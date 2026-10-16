import { Body, Controller, Get, HttpCode, Injectable, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, RequireActiveOrg } from '../../common/decorators';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseUuidPipe } from '../../common/utils';
import { MarketplaceStatus, PropertyStatus, RatePlanStatus, RoomTypeStatus } from '../../database/enums';
import { ConflictError, DomainValidationError, ForbiddenError, NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { AuditLogger } from '../audit/audit.logger';

export class UpdateVisibilityDto {
  @ApiPropertyOptional({ description: "Publish the property's own booking page (/booking/<slug>), independent of the marketplace" })
  @IsOptional()
  @IsBoolean()
  directBookingEnabled?: boolean;
}

export class MarketplaceRequestDto {
  @ApiProperty({ description: 'Must be true. The owner consents to list this property publicly on the Tirvona marketplace and to the platform rules.' })
  @IsBoolean()
  consent!: boolean;
}

interface Requirement {
  key: string;
  label: string;
  ok: boolean;
}

/**
 * Who can see and book a property publicly. The owner decides (and consents); the platform approves marketplace listings and can
 * suspend them. Public reads/bookings apply `common/public-visibility.ts`, never anything defined here.
 */
@Injectable()
export class PropertyVisibilityService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditLogger,
  ) {}

  private async property(propertyId: string) {
    const p = await this.db.selectFrom('properties').selectAll().where('id', '=', propertyId).executeTakeFirst();
    if (!p) throw new NotFoundError('Property', propertyId);
    return p;
  }

  /** The platform's listing rules, evaluated on live data. All must pass before a marketplace request is accepted. */
  async requirements(propertyId: string): Promise<Requirement[]> {
    const p = await this.property(propertyId);
    const [rooms, plans] = await Promise.all([
      this.db.selectFrom('roomTypes').select((eb) => eb.fn.countAll<string>().as('n')).where('propertyId', '=', propertyId).where('status', '=', RoomTypeStatus.ACTIVE).where('totalRooms', '>', 0).executeTakeFirstOrThrow(),
      this.db.selectFrom('ratePlans').select((eb) => eb.fn.countAll<string>().as('n')).where('propertyId', '=', propertyId).where('status', '=', RatePlanStatus.ACTIVE).executeTakeFirstOrThrow(),
    ]);
    return [
      { key: 'active', label: 'The property is active', ok: p.status === PropertyStatus.ACTIVE },
      { key: 'description', label: 'A description of at least 50 characters', ok: (p.description ?? '').trim().length >= 50 },
      { key: 'photo', label: 'At least one photo', ok: p.images.length > 0 },
      { key: 'address', label: 'A full address and postal code', ok: !!(p.address && p.city && p.state && p.postalCode) },
      { key: 'rooms', label: 'At least one active room type with rooms', ok: Number(rooms.n) > 0 },
      { key: 'rates', label: 'At least one active rate plan', ok: Number(plans.n) > 0 },
    ];
  }

  async get(propertyId: string) {
    const p = await this.property(propertyId);
    const requirements = await this.requirements(propertyId);
    return {
      propertyStatus: p.status,
      suspendedReason: p.status === PropertyStatus.SUSPENDED ? p.suspendedReason : null,
      directBookingEnabled: p.directBookingEnabled,
      marketplace: {
        status: p.marketplaceStatus,
        consentAt: p.marketplaceConsentAt,
        reviewedAt: p.marketplaceReviewedAt,
        note: p.marketplaceNote,
      },
      requirements,
      eligibleForMarketplace: requirements.every((r) => r.ok),
      /** What a visitor can do right now, derived from the same rules the public API applies. */
      publiclyBookable: p.status === PropertyStatus.ACTIVE && (p.directBookingEnabled || p.marketplaceStatus === MarketplaceStatus.APPROVED),
      listedOnMarketplace: p.status === PropertyStatus.ACTIVE && p.marketplaceStatus === MarketplaceStatus.APPROVED,
      slug: p.slug,
    };
  }

  async update(user: AuthUser, meta: RequestMeta, propertyId: string, dto: UpdateVisibilityDto) {
    const before = await this.property(propertyId);
    if (before.status === PropertyStatus.SUSPENDED) throw new ForbiddenError('This property was suspended by the platform.', 'PROPERTY_SUSPENDED');
    if (dto.directBookingEnabled !== undefined) {
      await this.db.updateTable('properties').set({ directBookingEnabled: dto.directBookingEnabled }).where('id', '=', propertyId).execute();
      await this.audit.log({ user, meta }, { action: 'property.visibility_update', entityType: 'Property', entityId: propertyId, propertyId, before: { directBookingEnabled: before.directBookingEnabled }, after: { directBookingEnabled: dto.directBookingEnabled } });
    }
    return this.get(propertyId);
  }

  async requestMarketplace(user: AuthUser, meta: RequestMeta, propertyId: string, dto: MarketplaceRequestDto) {
    if (dto.consent !== true) throw new DomainValidationError('Explicit consent is required to list a property on the marketplace', { fields: { consent: ['must be true'] } });
    const p = await this.property(propertyId);
    if (p.status === PropertyStatus.SUSPENDED) throw new ForbiddenError('This property was suspended by the platform.', 'PROPERTY_SUSPENDED');
    if (p.marketplaceStatus === MarketplaceStatus.SUSPENDED) throw new ConflictError('MARKETPLACE_SUSPENDED', 'The platform suspended this listing. Contact Tirvona support.');
    if (p.marketplaceStatus === MarketplaceStatus.APPROVED || p.marketplaceStatus === MarketplaceStatus.REQUESTED) {
      throw new ConflictError('INVALID_STATE_TRANSITION', `The marketplace request is already ${p.marketplaceStatus.toLowerCase()}`);
    }
    const missing = (await this.requirements(propertyId)).filter((r) => !r.ok);
    if (missing.length) throw new DomainValidationError('The property does not meet the marketplace requirements yet', { missing: missing.map((m) => m.label) });
    await this.db
      .updateTable('properties')
      .set({ marketplaceStatus: MarketplaceStatus.REQUESTED, marketplaceConsentAt: new Date(), marketplaceConsentBy: user.userId, marketplaceReviewedAt: null, marketplaceReviewedBy: null, marketplaceNote: null })
      .where('id', '=', propertyId)
      .execute();
    await this.audit.log({ user, meta }, { action: 'property.marketplace_request', entityType: 'Property', entityId: propertyId, propertyId, before: { marketplaceStatus: p.marketplaceStatus }, after: { marketplaceStatus: MarketplaceStatus.REQUESTED } });
    return this.get(propertyId);
  }

  /** The owner leaves the marketplace (or cancels a pending request). Consent is withdrawn with it. */
  async withdrawMarketplace(user: AuthUser, meta: RequestMeta, propertyId: string) {
    const p = await this.property(propertyId);
    if (p.marketplaceStatus === MarketplaceStatus.NOT_LISTED) return this.get(propertyId);
    // A platform suspension is not something an owner can escape by withdrawing: it stays recorded.
    if (p.marketplaceStatus === MarketplaceStatus.SUSPENDED) throw new ConflictError('MARKETPLACE_SUSPENDED', 'The platform suspended this listing. Contact Tirvona support.');
    await this.db
      .updateTable('properties')
      .set({ marketplaceStatus: MarketplaceStatus.NOT_LISTED, marketplaceConsentAt: null, marketplaceConsentBy: null, marketplaceReviewedAt: null, marketplaceReviewedBy: null, marketplaceNote: null })
      .where('id', '=', propertyId)
      .execute();
    await this.audit.log({ user, meta }, { action: 'property.marketplace_withdraw', entityType: 'Property', entityId: propertyId, propertyId, before: { marketplaceStatus: p.marketplaceStatus }, after: { marketplaceStatus: MarketplaceStatus.NOT_LISTED } });
    return this.get(propertyId);
  }
}

class VisibilityDto {
  @ApiProperty() propertyStatus!: string;
  @ApiProperty() directBookingEnabled!: boolean;
  @ApiProperty() slug!: string;
  @ApiProperty({ type: Object }) marketplace!: Record<string, unknown>;
  @ApiProperty({ type: [Object] }) requirements!: Record<string, unknown>[];
  @ApiProperty() eligibleForMarketplace!: boolean;
  @ApiProperty() publiclyBookable!: boolean;
  @ApiProperty() listedOnMarketplace!: boolean;
}

@ApiTags('Properties')
@Controller('properties/:id')
export class PropertyVisibilityController {
  constructor(private readonly visibility: PropertyVisibilityService) {}

  @Get('visibility')
  @PropertyAccess(Permission.PROPERTY_VIEW, { in: 'param', key: 'id', entity: 'property' })
  @ApiOperation({ summary: 'Who can see and book this property publicly, with the marketplace requirements checklist' })
  @ApiEnvelope(VisibilityDto)
  @ApiStandardErrors({ notFound: true })
  get(@Param('id', ParseUuidPipe) id: string) {
    return this.visibility.get(id);
  }

  @Patch('visibility')
  @RequireActiveOrg()
  @PropertyAccess(Permission.MARKETPLACE_MANAGE, { in: 'param', key: 'id', entity: 'property' })
  @ApiOperation({ summary: "Turn the property's own public booking page on or off (owner)" })
  @ApiEnvelope(VisibilityDto)
  @ApiStandardErrors({ notFound: true })
  update(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: UpdateVisibilityDto) {
    return this.visibility.update(user, meta, id, dto);
  }

  @Post('marketplace/request')
  @HttpCode(200)
  @RequireActiveOrg()
  @PropertyAccess(Permission.MARKETPLACE_MANAGE, { in: 'param', key: 'id', entity: 'property' })
  @ApiOperation({ summary: 'Ask to be listed on the Tirvona marketplace. Needs explicit consent and a complete listing; the platform then approves or rejects.' })
  @ApiEnvelope(VisibilityDto)
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  request(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: MarketplaceRequestDto) {
    return this.visibility.requestMarketplace(user, meta, id, dto);
  }

  @Post('marketplace/withdraw')
  @HttpCode(200)
  @PropertyAccess(Permission.MARKETPLACE_MANAGE, { in: 'param', key: 'id', entity: 'property' })
  @ApiOperation({ summary: 'Leave the marketplace or cancel a pending request (consent is withdrawn)' })
  @ApiEnvelope(VisibilityDto)
  @ApiStandardErrors({ notFound: true })
  withdraw(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.visibility.withdrawMarketplace(user, meta, id);
  }
}
