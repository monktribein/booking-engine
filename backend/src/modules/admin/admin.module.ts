import { Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsUUID, IsOptional, IsString, Length } from 'class-validator';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, Roles } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import { ParseUuidPipe, escapeLike, pageParams, toUuid } from '../../common/utils';
import { ChannelCode, MarketplaceStatus, PropertyStatus, ReservationStatus, SyncJobStatus, SyncLogStatus, UserRole, WebhookEventStatus } from '../../database/enums';
import { NotFoundError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { attachRooms } from '../../database/reservation-store';
import { JobsProducer } from '../../jobs/jobs.producer';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { ALL_QUEUES } from '../../jobs/queues';
import { AuditLogger } from '../audit/audit.logger';
import { WebhookJobHandler } from '../webhooks/webhooks.service';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { PartnersAdminController, PartnersAdminService } from './partners-admin';

class AdminPropertiesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) q?: string;
  @ApiPropertyOptional({ enum: PropertyStatus }) @IsOptional() @IsEnum(PropertyStatus) status?: PropertyStatus;
  @ApiPropertyOptional({ enum: MarketplaceStatus, description: 'REQUESTED = the approval queue' }) @IsOptional() @IsEnum(MarketplaceStatus) marketplaceStatus?: MarketplaceStatus;
}

class AdminReservationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() propertyId?: string;
  @ApiPropertyOptional({ enum: ReservationStatus }) @IsOptional() @IsEnum(ReservationStatus) status?: ReservationStatus;
  @ApiPropertyOptional({ description: 'Reservation code or external id' }) @IsOptional() @IsString() @Length(1, 100) q?: string;
}

class SyncErrorsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ChannelCode }) @IsOptional() @IsEnum(ChannelCode) channel?: ChannelCode;
  @ApiPropertyOptional() @IsOptional() @IsUUID() propertyId?: string;
}

class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() propertyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional({ example: 'reservation.cancel' }) @IsOptional() @IsString() @Length(1, 100) action?: string;
  @ApiPropertyOptional({ example: 'Reservation' }) @IsOptional() @IsString() @Length(1, 60) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() entityId?: string;
}

class QueueStatsDto {
  @ApiProperty() queue!: string;
  @ApiProperty({ type: Object }) counts!: Record<string, number>;
}

class GenericItemDto {
  @ApiProperty() _id!: string;
}

@Injectable()
export class AdminService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly producer: JobsProducer,
    private readonly outbox: OutboxDispatcher,
    private readonly webhookWorker: WebhookJobHandler,
    private readonly audit: AuditLogger,
  ) {}

  async properties(q: AdminPropertiesQueryDto) {
    const p = pageParams(q.page, q.limit);
    let query = this.db.selectFrom('properties');
    if (q.status) query = query.where('status', '=', q.status);
    if (q.marketplaceStatus) query = query.where('marketplaceStatus', '=', q.marketplaceStatus);
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      query = query.where((w) => w.or([w('name', 'ilike', like), w('slug', '=', q.q!.toLowerCase()), w('city', 'ilike', like)]));
    }
    const [items, total] = await Promise.all([
      query
        .select(['id', 'organizationId', 'name', 'slug', 'city', 'state', 'country', 'status', 'directBookingEnabled', 'marketplaceStatus', 'marketplaceConsentAt', 'marketplaceReviewedAt', 'marketplaceNote', 'suspendedReason', 'createdAt'])
        .select((eb) => eb.selectFrom('organizations as o').select('o.name').whereRef('o.id', '=', 'properties.organizationId').as('organizationName'))
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .offset(p.skip)
        .limit(p.limit)
        .execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, page: p.page, limit: p.limit, total: Number(total.n) };
  }

  async reservations(q: AdminReservationsQueryDto) {
    const p = pageParams(q.page, q.limit);
    let query = this.db.selectFrom('reservations');
    if (q.propertyId) query = query.where('propertyId', '=', toUuid(q.propertyId, 'propertyId'));
    if (q.status) query = query.where('status', '=', q.status);
    if (q.q) query = query.where((w) => w.or([w('reservationCode', '=', q.q!.toUpperCase()), w('externalReservationId', '=', q.q!)]));
    const [rows, total] = await Promise.all([
      query.selectAll().orderBy('createdAt', 'desc').orderBy('id', 'desc').offset(p.skip).limit(p.limit).execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    // Platform staff see what they need to operate (code, source, dates, money, state), not guest contact details:
    // the guest is reduced to a first name and a last initial, and free-text requests and the status history are dropped.
    const items = (await attachRooms(this.db, rows)).map(({ statusHistory: _h, specialRequests: _s, guestId: _g, guest, createdBy: _c, ...r }) => ({
      ...r,
      guest: { firstName: guest.firstName, lastInitial: guest.lastName ? `${guest.lastName.charAt(0)}.` : '' },
    }));
    return { items, page: p.page, limit: p.limit, total: Number(total.n) };
  }

  async syncErrors(q: SyncErrorsQueryDto) {
    const p = pageParams(q.page, q.limit);
    let jobsQ = this.db.selectFrom('syncJobs').where('status', 'in', [SyncJobStatus.FAILED, SyncJobStatus.RETRYING]);
    if (q.channel) jobsQ = jobsQ.where('channel', '=', q.channel);
    if (q.propertyId) jobsQ = jobsQ.where('propertyId', '=', toUuid(q.propertyId, 'propertyId'));
    const [jobItems, jobTotal] = await Promise.all([
      jobsQ.selectAll().orderBy('updatedAt', 'desc').orderBy('id', 'desc').offset(p.skip).limit(p.limit).execute(),
      jobsQ.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    const jobs = { items: jobItems, page: p.page, limit: p.limit, total: Number(jobTotal.n) };
    let logsQ = this.db.selectFrom('syncLogs').selectAll().where('status', '=', SyncLogStatus.FAILED);
    if (q.channel) logsQ = logsQ.where('channel', '=', q.channel);
    const recentFailures = await logsQ.orderBy('createdAt', 'desc').limit(50).execute();
    const failedWebhooks = await this.db
      .selectFrom('webhookEvents')
      .select(['id', 'channel', 'propertyId', 'eventType', 'externalEventId', 'status', 'attempts', 'error', 'createdAt', 'updatedAt'])
      .where('status', '=', WebhookEventStatus.FAILED)
      .orderBy('updatedAt', 'desc')
      .limit(50)
      .execute();
    const failedQueueJobs = await Promise.all(ALL_QUEUES.map(async (queue) => ({ queue, jobs: await this.producer.failed(queue, 20) })));
    return { syncJobs: jobs, recentFailures, failedWebhooks, failedQueueJobs };
  }

  async channelConnections(q: PaginationQueryDto) {
    const p = pageParams(q.page, q.limit);
    const [items, total] = await Promise.all([
      // Encrypted token columns are never selected.
      this.db
        .selectFrom('channelConnections')
        .select(['id', 'propertyId', 'channel', 'status', 'externalAccountId', 'expiresAt', 'connectedAt', 'lastSyncAt', 'lastError', 'createdAt', 'updatedAt'])
        .orderBy('updatedAt', 'desc')
        .orderBy('id', 'desc')
        .offset(p.skip)
        .limit(p.limit)
        .execute(),
      this.db.selectFrom('channelConnections').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, page: p.page, limit: p.limit, total: Number(total.n) };
  }

  async auditLogs(q: AuditQueryDto, propertyId?: string) {
    const p = pageParams(q.page, q.limit);
    let query = this.db.selectFrom('auditLogs');
    if (propertyId ?? q.propertyId) query = query.where('propertyId', '=', propertyId ?? toUuid(q.propertyId!, 'propertyId'));
    if (q.userId) query = query.where('userId', '=', toUuid(q.userId, 'userId'));
    if (q.action) query = query.where('action', '=', q.action);
    if (q.entityType) query = query.where('entityType', '=', q.entityType);
    if (q.entityId) query = query.where('entityId', '=', toUuid(q.entityId, 'entityId'));
    const [items, total] = await Promise.all([
      query.selectAll().orderBy('createdAt', 'desc').orderBy('id', 'desc').offset(p.skip).limit(p.limit).execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, page: p.page, limit: p.limit, total: Number(total.n) };
  }

  queues() {
    return this.producer.stats();
  }

  async retrySyncJob(user: AuthUser, meta: RequestMeta, id: string) {
    const job = await this.db
      .updateTable('syncJobs')
      .set({ status: SyncJobStatus.PENDING, attempts: 0, enqueuedAt: null, lockedBy: null, lockedUntil: null, scheduledAt: new Date() })
      .where('id', '=', id)
      .where('status', 'in', [SyncJobStatus.FAILED, SyncJobStatus.RETRYING])
      .returning(['id', 'propertyId'])
      .executeTakeFirst();
    if (!job) throw new NotFoundError('Failed sync job', id);
    await this.audit.log({ user, meta }, { action: 'admin.sync_job_retry', entityType: 'SyncJob', entityId: id, propertyId: job.propertyId });
    void this.outbox.flush();
    return { ok: true };
  }

  async retryWebhook(user: AuthUser, meta: RequestMeta, id: string) {
    const ev = await this.db.selectFrom('webhookEvents').select('propertyId').where('id', '=', id).where('status', '=', WebhookEventStatus.FAILED).executeTakeFirst();
    if (!ev) throw new NotFoundError('Failed webhook event', id);
    await this.webhookWorker.retry(id);
    await this.audit.log({ user, meta }, { action: 'admin.webhook_retry', entityType: 'WebhookEvent', entityId: id, propertyId: ev.propertyId ?? undefined });
    return { ok: true };
  }
}

@ApiTags('Admin')
@Roles(UserRole.SUPER_ADMIN, UserRole.OPERATIONS_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('properties')
  @ApiOperation({ summary: 'All properties on the platform' })
  @ApiEnvelope(GenericItemDto, { paginated: true })
  @ApiStandardErrors()
  properties(@Query() q: AdminPropertiesQueryDto) {
    return this.admin.properties(q);
  }

  @Get('reservations')
  @ApiOperation({ summary: 'Reservations across all properties' })
  @ApiEnvelope(GenericItemDto, { paginated: true })
  @ApiStandardErrors()
  reservations(@Query() q: AdminReservationsQueryDto) {
    return this.admin.reservations(q);
  }

  @Get('sync-errors')
  @ApiOperation({ summary: 'Failed/retrying sync jobs, recent failed pushes, failed webhooks and failed queue jobs' })
  @ApiStandardErrors()
  syncErrors(@Query() q: SyncErrorsQueryDto) {
    return this.admin.syncErrors(q);
  }

  @Get('channel-connections')
  @ApiOperation({ summary: 'All channel connections (credentials are never returned)' })
  @ApiEnvelope(GenericItemDto, { paginated: true })
  @ApiStandardErrors()
  connections(@Query() q: PaginationQueryDto) {
    return this.admin.channelConnections(q);
  }

  @Get('audit-logs')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Audit trail (filter by property, user, action, entity)' })
  @ApiEnvelope(GenericItemDto, { paginated: true })
  @ApiStandardErrors()
  auditLogs(@Query() q: AuditQueryDto) {
    return this.admin.auditLogs(q);
  }

  @Get('queues')
  @ApiOperation({ summary: 'Job counts per queue (waiting, active, delayed, completed, failed)' })
  @ApiEnvelope(QueueStatsDto, { isArray: true })
  @ApiStandardErrors()
  queues() {
    return this.admin.queues();
  }

  @Post('sync-jobs/:id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry a failed sync job' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ notFound: true })
  retrySync(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.admin.retrySyncJob(user, meta, id);
  }

  @Post('webhook-events/:id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reprocess a failed webhook event (idempotent)' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ notFound: true })
  retryWebhook(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseUuidPipe) id: string) {
    return this.admin.retryWebhook(user, meta, id);
  }
}

/** Owners and managers see their own property's audit trail. */
@ApiTags('Audit')
@Controller('properties/:propertyId/audit-logs')
export class PropertyAuditController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @PropertyAccess(Permission.AUDIT_VIEW, { in: 'param', key: 'propertyId', entity: 'property' })
  @ApiOperation({ summary: 'Audit trail of one property' })
  @ApiEnvelope(GenericItemDto, { paginated: true })
  @ApiStandardErrors({ notFound: true })
  list(@Param('propertyId', ParseUuidPipe) propertyId: string, @Query() q: AuditQueryDto) {
    return this.admin.auditLogs(q, propertyId);
  }
}

@Module({ imports: [WebhooksModule], controllers: [AdminController, PartnersAdminController, PropertyAuditController], providers: [AdminService, PartnersAdminService] })
export class AdminModule {}
