import { Body, Controller, Get, HttpCode, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { sql } from 'kysely';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, Roles } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseUuidPipe, escapeLike, pageParams } from '../../common/utils';
import { MarketplaceStatus, OrganizationStatus, PropertyStatus, UserRole } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { AuditLogger } from '../audit/audit.logger';

export class PartnersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: OrganizationStatus }) @IsOptional() @IsEnum(OrganizationStatus) status?: OrganizationStatus;
  @ApiPropertyOptional({ description: 'Organization name or owner e-mail' }) @IsOptional() @IsString() @Length(1, 100) q?: string;
}

export class DecisionDto {
  @ApiPropertyOptional({ description: 'Why. Required when rejecting or suspending; shown to the partner.' }) @IsOptional() @IsString() @Length(1, 500) reason?: string;
}

type PartnerAction = 'approve' | 'reject' | 'suspend' | 'reactivate';
type MarketplaceAction = 'approve' | 'reject' | 'suspend' | 'reinstate';

/**
 * Platform review of partners and their marketplace listings. Everything here is audit-logged against the partner.
 * OPERATIONS_ADMIN reviews (approve / reject). Only SUPER_ADMIN suspends and reinstates, see the controller.
 */
@Injectable()
export class PartnersAdminService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditLogger,
  ) {}

  async list(q: PartnersQueryDto) {
    const p = pageParams(q.page, q.limit);
    let query = this.db.selectFrom('organizations as o');
    if (q.status) query = query.where('o.status', '=', q.status);
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      query = query.where((w) =>
        w.or([w('o.name', 'ilike', like), w.exists(w.selectFrom('users as u').select('u.id').whereRef('u.organizationId', '=', 'o.id').where('u.email', 'ilike', like))]),
      );
    }
    const [items, total] = await Promise.all([
      query
        .select([
          'o.id',
          'o.name',
          'o.slug',
          'o.status',
          'o.statusReason',
          'o.approvedAt',
          'o.createdAt',
          sql<string>`(select u.email from users u where u.organization_id = o.id and u.role = 'PROPERTY_OWNER' order by u.created_at limit 1)`.as('ownerEmail'),
          sql<string>`(select u.name from users u where u.organization_id = o.id and u.role = 'PROPERTY_OWNER' order by u.created_at limit 1)`.as('ownerName'),
          sql<number>`(select count(*)::int from properties p where p.organization_id = o.id and p.status <> 'ARCHIVED')`.as('properties'),
          sql<number>`(select count(*)::int from api_keys k where k.organization_id = o.id and k.status = 'ACTIVE')`.as('activeApiKeys'),
        ])
        .orderBy(sql`case o.status when 'PENDING_APPROVAL' then 0 else 1 end`)
        .orderBy('o.createdAt', 'desc')
        .offset(p.skip)
        .limit(p.limit)
        .execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, page: p.page, limit: p.limit, total: Number(total.n) };
  }

  /** One partner with its properties and people. No guest or booking data. */
  async get(id: string) {
    const org = await this.db.selectFrom('organizations').selectAll().where('id', '=', id).executeTakeFirst();
    if (!org) throw new NotFoundError('Organization', id);
    const [properties, users, integrationRequests] = await Promise.all([
      this.db
        .selectFrom('properties')
        .select(['id', 'name', 'slug', 'city', 'status', 'directBookingEnabled', 'marketplaceStatus', 'marketplaceConsentAt', 'marketplaceNote', 'suspendedReason'])
        .where('organizationId', '=', id)
        .where('status', '<>', PropertyStatus.ARCHIVED)
        .orderBy('name')
        .execute(),
      this.db.selectFrom('users').select(['id', 'name', 'email', 'role', 'status', 'lastLoginAt']).where('organizationId', '=', id).orderBy('role').orderBy('name').execute(),
      this.db.selectFrom('integrationRequests').selectAll().where('organizationId', '=', id).orderBy('createdAt', 'desc').limit(50).execute(),
    ]);
    return { ...org, properties, users, integrationRequests };
  }

  async act(actor: AuthUser, meta: RequestMeta, id: string, action: PartnerAction, reason?: string) {
    const rule: Record<PartnerAction, { from: OrganizationStatus[]; to: OrganizationStatus; needsReason: boolean }> = {
      approve: { from: [OrganizationStatus.PENDING_APPROVAL, OrganizationStatus.REJECTED], to: OrganizationStatus.ACTIVE, needsReason: false },
      reject: { from: [OrganizationStatus.PENDING_APPROVAL], to: OrganizationStatus.REJECTED, needsReason: true },
      suspend: { from: [OrganizationStatus.ACTIVE], to: OrganizationStatus.SUSPENDED, needsReason: true },
      reactivate: { from: [OrganizationStatus.SUSPENDED], to: OrganizationStatus.ACTIVE, needsReason: false },
    };
    const r = rule[action];
    if (r.needsReason && !reason?.trim()) throw new DomainValidationError(`A reason is required to ${action} a partner`, { fields: { reason: ['required'] } });
    const now = new Date();
    // The status condition makes concurrent decisions safe: only one of two admins clicking at once changes the row.
    const after = await this.db
      .updateTable('organizations')
      .set({
        status: r.to,
        statusReason: reason?.trim() ?? null,
        statusChangedAt: now,
        statusChangedBy: actor.userId,
        ...(r.to === OrganizationStatus.ACTIVE ? { approvedAt: sql<Date>`coalesce(approved_at, ${now})` as never } : {}),
      })
      .where('id', '=', id)
      .where('status', 'in', r.from)
      .returning(['id', 'name', 'status'])
      .executeTakeFirst();
    if (!after) {
      const current = await this.db.selectFrom('organizations').select('status').where('id', '=', id).executeTakeFirst();
      if (!current) throw new NotFoundError('Organization', id);
      throw new ConflictError('INVALID_STATE_TRANSITION', `Cannot ${action} a partner that is ${current.status}`);
    }
    await this.audit.log({ user: actor, meta }, { action: `admin.partner_${action}`, entityType: 'Organization', entityId: id, organizationId: id, after: { status: after.status, reason: reason?.trim() } });
    return after;
  }

  async marketplace(actor: AuthUser, meta: RequestMeta, propertyId: string, action: MarketplaceAction, note?: string) {
    const rule: Record<MarketplaceAction, { from: MarketplaceStatus; to: MarketplaceStatus; needsNote: boolean }> = {
      approve: { from: MarketplaceStatus.REQUESTED, to: MarketplaceStatus.APPROVED, needsNote: false },
      reject: { from: MarketplaceStatus.REQUESTED, to: MarketplaceStatus.REJECTED, needsNote: true },
      suspend: { from: MarketplaceStatus.APPROVED, to: MarketplaceStatus.SUSPENDED, needsNote: true },
      reinstate: { from: MarketplaceStatus.SUSPENDED, to: MarketplaceStatus.APPROVED, needsNote: false },
    };
    const r = rule[action];
    if (r.needsNote && !note?.trim()) throw new DomainValidationError(`A note is required to ${action} a listing`, { fields: { reason: ['required'] } });
    const after = await this.db
      .updateTable('properties')
      .set({ marketplaceStatus: r.to, marketplaceReviewedAt: new Date(), marketplaceReviewedBy: actor.userId, marketplaceNote: note?.trim() ?? null })
      .where('id', '=', propertyId)
      .where('marketplaceStatus', '=', r.from)
      .returning(['id', 'name', 'organizationId', 'marketplaceStatus'])
      .executeTakeFirst();
    if (!after) {
      const current = await this.db.selectFrom('properties').select('marketplaceStatus').where('id', '=', propertyId).executeTakeFirst();
      if (!current) throw new NotFoundError('Property', propertyId);
      throw new ConflictError('INVALID_STATE_TRANSITION', `Cannot ${action} a listing that is ${current.marketplaceStatus}`);
    }
    await this.audit.log({ user: actor, meta }, { action: `admin.marketplace_${action}`, entityType: 'Property', entityId: propertyId, propertyId, organizationId: after.organizationId, after: { marketplaceStatus: after.marketplaceStatus, note: note?.trim() } });
    return after;
  }

  /** Platform suspension of a whole property: nobody can book it, and the owner cannot lift it. */
  async setPropertySuspended(actor: AuthUser, meta: RequestMeta, propertyId: string, suspended: boolean, reason?: string) {
    if (suspended && !reason?.trim()) throw new DomainValidationError('A reason is required to suspend a property', { fields: { reason: ['required'] } });
    const after = await this.db
      .updateTable('properties')
      .set(
        suspended
          ? { status: PropertyStatus.SUSPENDED, suspendedReason: reason!.trim(), suspendedAt: new Date() }
          : { status: PropertyStatus.ACTIVE, suspendedReason: null, suspendedAt: null },
      )
      .where('id', '=', propertyId)
      .where('status', 'in', suspended ? [PropertyStatus.ACTIVE, PropertyStatus.INACTIVE, PropertyStatus.DRAFT] : [PropertyStatus.SUSPENDED])
      .returning(['id', 'name', 'organizationId', 'status'])
      .executeTakeFirst();
    if (!after) {
      const current = await this.db.selectFrom('properties').select('status').where('id', '=', propertyId).executeTakeFirst();
      if (!current) throw new NotFoundError('Property', propertyId);
      throw new ConflictError('INVALID_STATE_TRANSITION', `Cannot ${suspended ? 'suspend' : 'reactivate'} a property that is ${current.status}`);
    }
    await this.audit.log({ user: actor, meta }, { action: suspended ? 'admin.property_suspend' : 'admin.property_reactivate', entityType: 'Property', entityId: propertyId, propertyId, organizationId: after.organizationId, after: { status: after.status, reason: reason?.trim() } });
    return after;
  }
}

class PartnerSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: OrganizationStatus }) status!: OrganizationStatus;
}

@ApiTags('Admin')
@Roles(UserRole.SUPER_ADMIN, UserRole.OPERATIONS_ADMIN)
@Controller('admin')
export class PartnersAdminController {
  constructor(private readonly partners: PartnersAdminService) {}

  @Get('partners')
  @ApiOperation({ summary: 'Partner organizations with owner, property and key counts; pending approvals first' })
  @ApiEnvelope(PartnerSummaryDto, { paginated: true })
  @ApiStandardErrors()
  list(@Query() q: PartnersQueryDto) {
    return this.partners.list(q);
  }

  @Get('partners/:id')
  @ApiOperation({ summary: 'One partner: properties, people, integration requests (no guest data)' })
  @ApiStandardErrors({ notFound: true })
  get(@Param('id', ParseUuidPipe) id: string) {
    return this.partners.get(id);
  }

  @Post('partners/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a pending (or previously rejected) partner' })
  @ApiEnvelope(PartnerSummaryDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  approve(@CurrentUser() u: AuthUser, @ReqMeta() m: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: DecisionDto) {
    return this.partners.act(u, m, id, 'approve', dto.reason);
  }

  @Post('partners/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a pending partner (a reason is required and is shown to them)' })
  @ApiEnvelope(PartnerSummaryDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  reject(@CurrentUser() u: AuthUser, @ReqMeta() m: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: DecisionDto) {
    return this.partners.act(u, m, id, 'reject', dto.reason);
  }

  @Post('partners/:id/suspend')
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspend a partner (SUPER_ADMIN): its users are locked out, its API keys and public listings stop working' })
  @ApiEnvelope(PartnerSummaryDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  suspend(@CurrentUser() u: AuthUser, @ReqMeta() m: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: DecisionDto) {
    return this.partners.act(u, m, id, 'suspend', dto.reason);
  }

  @Post('partners/:id/reactivate')
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Lift a suspension (SUPER_ADMIN)' })
  @ApiEnvelope(PartnerSummaryDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  reactivate(@CurrentUser() u: AuthUser, @ReqMeta() m: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.partners.act(u, m, id, 'reactivate');
  }

  @Post('properties/:id/marketplace/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a marketplace listing request' })
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  approveListing(@CurrentUser() u: AuthUser, @ReqMeta() m: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: DecisionDto) {
    return this.partners.marketplace(u, m, id, 'approve', dto.reason);
  }

  @Post('properties/:id/marketplace/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a marketplace listing request (a note is required)' })
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  rejectListing(@CurrentUser() u: AuthUser, @ReqMeta() m: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: DecisionDto) {
    return this.partners.marketplace(u, m, id, 'reject', dto.reason);
  }

  @Post('properties/:id/marketplace/suspend')
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Pull an approved listing off the marketplace (SUPER_ADMIN)' })
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  suspendListing(@CurrentUser() u: AuthUser, @ReqMeta() m: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: DecisionDto) {
    return this.partners.marketplace(u, m, id, 'suspend', dto.reason);
  }

  @Post('properties/:id/marketplace/reinstate')
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Put a suspended listing back on the marketplace (SUPER_ADMIN)' })
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  reinstateListing(@CurrentUser() u: AuthUser, @ReqMeta() m: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.partners.marketplace(u, m, id, 'reinstate');
  }

  @Post('properties/:id/suspend')
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspend a property (SUPER_ADMIN): it cannot be booked and the owner cannot lift it' })
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  suspendProperty(@CurrentUser() u: AuthUser, @ReqMeta() m: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: DecisionDto) {
    return this.partners.setPropertySuspended(u, m, id, true, dto.reason);
  }

  @Post('properties/:id/reactivate')
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Lift a property suspension (SUPER_ADMIN)' })
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  reactivateProperty(@CurrentUser() u: AuthUser, @ReqMeta() m: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.partners.setPropertySuspended(u, m, id, false);
  }
}
