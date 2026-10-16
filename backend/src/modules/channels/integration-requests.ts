import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, RequireActiveOrg, Roles } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors } from '../../common/swagger';
import { ParseUuidPipe, pageParams } from '../../common/utils';
import { ChannelCode, IntegrationRequestStatus, UserRole } from '../../database/enums';
import { ConflictError, DomainValidationError, NotFoundError } from '../../database/errors';
import { Db, InjectDb, isUniqueViolation } from '../../database/kysely';
import { AuditLogger } from '../audit/audit.logger';

/** Channels a partner may ask the platform to enable. Real OTAs need the platform's own partner approval first, see docs/CHANNEL_ADAPTERS.md. */
const REQUESTABLE = [ChannelCode.AIRBNB, ChannelCode.BOOKING_COM, ChannelCode.AGODA, ChannelCode.OTHER] as const;

export class CreateIntegrationRequestDto {
  @ApiProperty({ enum: REQUESTABLE }) @IsEnum(REQUESTABLE) channel!: ChannelCode;
  @ApiPropertyOptional({ description: 'Leave out to ask for the whole organization' }) @IsOptional() @IsUUID() propertyId?: string;
  @ApiPropertyOptional({ description: 'Your existing account or listing, anything that helps the review' }) @IsOptional() @IsString() @Length(1, 1000) note?: string;
}

export class IntegrationRequestsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: IntegrationRequestStatus }) @IsOptional() @IsEnum(IntegrationRequestStatus) status?: IntegrationRequestStatus;
}

export class DecideIntegrationRequestDto {
  @ApiProperty({ enum: [IntegrationRequestStatus.IN_REVIEW, IntegrationRequestStatus.APPROVED, IntegrationRequestStatus.REJECTED] })
  @IsEnum([IntegrationRequestStatus.IN_REVIEW, IntegrationRequestStatus.APPROVED, IntegrationRequestStatus.REJECTED])
  status!: IntegrationRequestStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 1000) note?: string;
}

/**
 * A partner asks the platform to enable an integration. This is only a request and a decision on record: APPROVED does NOT mean
 * a channel is connected. The channel connection (OAuth/credentials) is separate and works only where the platform holds the
 * channel's own partner access.
 */
@Injectable()
export class IntegrationRequestsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditLogger,
  ) {}

  list(user: AuthUser) {
    return this.db.selectFrom('integrationRequests').selectAll().where('organizationId', '=', user.organizationId ?? '00000000-0000-0000-0000-000000000000').orderBy('createdAt', 'desc').limit(100).execute();
  }

  async create(user: AuthUser, meta: RequestMeta, dto: CreateIntegrationRequestDto) {
    if (!user.organizationId) throw new DomainValidationError('This account has no organization');
    if (dto.propertyId) {
      const own = await this.db.selectFrom('properties').select('id').where('id', '=', dto.propertyId).where('organizationId', '=', user.organizationId).executeTakeFirst();
      if (!own) throw new NotFoundError('Property', dto.propertyId); // another partner's property is a 404, never a hint
    }
    try {
      const row = await this.db
        .insertInto('integrationRequests')
        .values({ organizationId: user.organizationId, propertyId: dto.propertyId ?? null, channel: dto.channel, note: dto.note?.trim() ?? null, requestedBy: user.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.log({ user, meta }, { action: 'integration_request.create', entityType: 'IntegrationRequest', entityId: row.id, propertyId: dto.propertyId ?? undefined, after: { channel: dto.channel } });
      return row;
    } catch (err) {
      if (isUniqueViolation(err, 'integration_requests_open_key')) throw new ConflictError('DUPLICATE', 'There is already an open request for this channel');
      throw err;
    }
  }

  async withdraw(user: AuthUser, meta: RequestMeta, id: string) {
    const row = await this.db
      .updateTable('integrationRequests')
      .set({ status: IntegrationRequestStatus.WITHDRAWN })
      .where('id', '=', id)
      .where('organizationId', '=', user.organizationId ?? '00000000-0000-0000-0000-000000000000')
      .where('status', 'in', [IntegrationRequestStatus.REQUESTED, IntegrationRequestStatus.IN_REVIEW])
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Open integration request', id);
    await this.audit.log({ user, meta }, { action: 'integration_request.withdraw', entityType: 'IntegrationRequest', entityId: id });
    return row;
  }

  // ------------------------------------------------------------ platform admin

  async adminList(q: IntegrationRequestsQueryDto) {
    const p = pageParams(q.page, q.limit);
    let query = this.db.selectFrom('integrationRequests as r').innerJoin('organizations as o', 'o.id', 'r.organizationId').leftJoin('properties as pr', 'pr.id', 'r.propertyId');
    if (q.status) query = query.where('r.status', '=', q.status);
    const [items, total] = await Promise.all([
      query
        .select(['r.id', 'r.organizationId', 'o.name as organizationName', 'r.propertyId', 'pr.name as propertyName', 'r.channel', 'r.status', 'r.note', 'r.decisionNote', 'r.decidedAt', 'r.createdAt'])
        .orderBy('r.createdAt', 'desc')
        .offset(p.skip)
        .limit(p.limit)
        .execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, page: p.page, limit: p.limit, total: Number(total.n) };
  }

  async decide(admin: AuthUser, meta: RequestMeta, id: string, dto: DecideIntegrationRequestDto) {
    if (dto.status === IntegrationRequestStatus.REJECTED && !dto.note?.trim()) throw new DomainValidationError('A note is required when rejecting', { fields: { note: ['required'] } });
    const row = await this.db
      .updateTable('integrationRequests')
      .set({ status: dto.status, decisionNote: dto.note?.trim() ?? null, decidedBy: admin.userId, decidedAt: new Date() })
      .where('id', '=', id)
      .where('status', 'in', [IntegrationRequestStatus.REQUESTED, IntegrationRequestStatus.IN_REVIEW])
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new ConflictError('INVALID_STATE_TRANSITION', 'The request is not open');
    await this.audit.log({ user: admin, meta }, { action: 'admin.integration_request_decide', entityType: 'IntegrationRequest', entityId: id, organizationId: row.organizationId, after: { status: dto.status, channel: row.channel } });
    return row;
  }
}

@ApiTags('Integrations')
@Roles(UserRole.PROPERTY_OWNER)
@Controller('integration-requests')
export class IntegrationRequestsController {
  constructor(private readonly requests: IntegrationRequestsService) {}

  @Get()
  @ApiOperation({ summary: "The organization's integration requests and their decisions" })
  @ApiStandardErrors()
  list(@CurrentUser() user: AuthUser) {
    return this.requests.list(user);
  }

  @Post()
  @RequireActiveOrg()
  @ApiOperation({ summary: 'Ask the platform to enable an integration (a request only: approval does not connect a channel)' })
  @ApiStandardErrors({ conflict: 'DUPLICATE' })
  create(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Body() dto: CreateIntegrationRequestDto) {
    return this.requests.create(user, meta, dto);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw an open request' })
  @ApiStandardErrors({ notFound: true })
  withdraw(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.requests.withdraw(user, meta, id);
  }
}

@ApiTags('Admin')
@Roles(UserRole.SUPER_ADMIN, UserRole.OPERATIONS_ADMIN)
@Controller('admin/integration-requests')
export class AdminIntegrationRequestsController {
  constructor(private readonly requests: IntegrationRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Integration requests from all partners' })
  @ApiStandardErrors()
  list(@Query() q: IntegrationRequestsQueryDto) {
    return this.requests.adminList(q);
  }

  @Post(':id/decide')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a request in review, approved or rejected (a record of the decision; it does not connect a channel)' })
  @ApiStandardErrors({ notFound: true, conflict: 'INVALID_STATE_TRANSITION' })
  decide(@CurrentUser() admin: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string, @Body() dto: DecideIntegrationRequestDto) {
    return this.requests.decide(admin, meta, id, dto);
  }
}

@Module({
  controllers: [IntegrationRequestsController, AdminIntegrationRequestsController],
  providers: [IntegrationRequestsService],
})
export class IntegrationRequestsModule {}
