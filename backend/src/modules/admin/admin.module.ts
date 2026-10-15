import { Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsMongoId, IsOptional, IsString, Length } from 'class-validator';
import { Connection, Types } from 'mongoose';
import { Permission } from '../../common/access/permissions';
import { PropertyAccess } from '../../common/access/property-access.decorator';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { CurrentUser, ReqMeta, Roles } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto';
import { ApiEnvelope, ApiStandardErrors, OkDto } from '../../common/swagger';
import { ParseObjectIdPipe, escapeRegex, pageParams, toObjectId } from '../../common/utils';
import { ChannelCode, PropertyStatus, ReservationStatus, SyncJobStatus, SyncLogStatus, UserRole, WebhookEventStatus } from '../../database/enums';
import { NotFoundError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import { JobsProducer } from '../../jobs/jobs.producer';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { ALL_QUEUES } from '../../jobs/queues';
import { AuditLogger } from '../audit/audit.logger';
import { WebhookJobHandler } from '../webhooks/webhooks.service';
import { WebhooksModule } from '../webhooks/webhooks.module';

class AdminPropertiesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) q?: string;
  @ApiPropertyOptional({ enum: PropertyStatus }) @IsOptional() @IsEnum(PropertyStatus) status?: PropertyStatus;
}

class AdminReservationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() propertyId?: string;
  @ApiPropertyOptional({ enum: ReservationStatus }) @IsOptional() @IsEnum(ReservationStatus) status?: ReservationStatus;
  @ApiPropertyOptional({ description: 'Reservation code or external id' }) @IsOptional() @IsString() @Length(1, 100) q?: string;
}

class SyncErrorsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ChannelCode }) @IsOptional() @IsEnum(ChannelCode) channel?: ChannelCode;
  @ApiPropertyOptional() @IsOptional() @IsMongoId() propertyId?: string;
}

class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() propertyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsMongoId() userId?: string;
  @ApiPropertyOptional({ example: 'reservation.cancel' }) @IsOptional() @IsString() @Length(1, 100) action?: string;
  @ApiPropertyOptional({ example: 'Reservation' }) @IsOptional() @IsString() @Length(1, 60) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsMongoId() entityId?: string;
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
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly producer: JobsProducer,
    private readonly outbox: OutboxDispatcher,
    private readonly webhookWorker: WebhookJobHandler,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  private async page<T>(model: { find: Function; countDocuments: Function }, filter: object, q: PaginationQueryDto, sort: object, projection: object = {}) {
    const p = pageParams(q.page, q.limit);
    const [items, total] = await Promise.all([
      (model.find(filter, projection) as { sort: Function }).sort(sort).skip(p.skip).limit(p.limit).lean() as Promise<T[]>,
      model.countDocuments(filter) as Promise<number>,
    ]);
    return { items, page: p.page, limit: p.limit, total };
  }

  properties(q: AdminPropertiesQueryDto) {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.q) filter.$or = [{ name: new RegExp(escapeRegex(q.q), 'i') }, { slug: q.q.toLowerCase() }, { city: new RegExp(escapeRegex(q.q), 'i') }];
    return this.page(this.m.Property, filter, q, { createdAt: -1 });
  }

  reservations(q: AdminReservationsQueryDto) {
    const filter: Record<string, unknown> = {};
    if (q.propertyId) filter.propertyId = toObjectId(q.propertyId, 'propertyId');
    if (q.status) filter.status = q.status;
    if (q.q) filter.$or = [{ reservationCode: q.q.toUpperCase() }, { externalReservationId: q.q }];
    return this.page(this.m.Reservation, filter, q, { createdAt: -1 }, { statusHistory: 0 });
  }

  async syncErrors(q: SyncErrorsQueryDto) {
    const filter: Record<string, unknown> = { status: { $in: [SyncJobStatus.FAILED, SyncJobStatus.RETRYING] } };
    if (q.channel) filter.channel = q.channel;
    if (q.propertyId) filter.propertyId = toObjectId(q.propertyId, 'propertyId');
    const jobs = await this.page(this.m.SyncJob, filter, q, { updatedAt: -1 });
    const recentFailures = await this.m.SyncLog.find({ status: SyncLogStatus.FAILED, ...(q.channel ? { channel: q.channel } : {}) })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const failedWebhooks = await this.m.WebhookEvent.find({ status: WebhookEventStatus.FAILED }, { payload: 0 }).sort({ updatedAt: -1 }).limit(50).lean();
    const failedQueueJobs = await Promise.all(ALL_QUEUES.map(async (queue) => ({ queue, jobs: await this.producer.failed(queue, 20) })));
    return { syncJobs: jobs, recentFailures, failedWebhooks, failedQueueJobs };
  }

  channelConnections(q: PaginationQueryDto) {
    // Encrypted token fields are select:false and are never loaded here.
    return this.page(this.m.ChannelConnection, {}, q, { updatedAt: -1 });
  }

  auditLogs(q: AuditQueryDto, propertyId?: Types.ObjectId) {
    const filter: Record<string, unknown> = {};
    if (propertyId ?? q.propertyId) filter.propertyId = propertyId ?? toObjectId(q.propertyId!, 'propertyId');
    if (q.userId) filter.userId = toObjectId(q.userId, 'userId');
    if (q.action) filter.action = q.action;
    if (q.entityType) filter.entityType = q.entityType;
    if (q.entityId) filter.entityId = toObjectId(q.entityId, 'entityId');
    return this.page(this.m.AuditLog, filter, q, { createdAt: -1 });
  }

  queues() {
    return this.producer.stats();
  }

  async retrySyncJob(user: AuthUser, meta: RequestMeta, id: Types.ObjectId) {
    const job = await this.m.SyncJob.findOneAndUpdate(
      { _id: id, status: { $in: [SyncJobStatus.FAILED, SyncJobStatus.RETRYING] } },
      { $set: { status: SyncJobStatus.PENDING, attempts: 0, enqueuedAt: null, lockedBy: null, lockedUntil: null, scheduledAt: new Date() } },
      { new: true },
    ).lean();
    if (!job) throw new NotFoundError('Failed sync job', id);
    await this.audit.log({ user, meta }, { action: 'admin.sync_job_retry', entityType: 'SyncJob', entityId: id, propertyId: job.propertyId });
    void this.outbox.flush();
    return { ok: true };
  }

  async retryWebhook(user: AuthUser, meta: RequestMeta, id: Types.ObjectId) {
    const ev = await this.m.WebhookEvent.findOne({ _id: id, status: WebhookEventStatus.FAILED }, { propertyId: 1 }).lean();
    if (!ev) throw new NotFoundError('Failed webhook event', id);
    await this.webhookWorker.retry(id);
    await this.audit.log({ user, meta }, { action: 'admin.webhook_retry', entityType: 'WebhookEvent', entityId: id, propertyId: ev.propertyId });
    return { ok: true };
  }
}

@ApiTags('Admin')
@Roles(UserRole.SUPER_ADMIN)
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
  retrySync(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return this.admin.retrySyncJob(user, meta, id);
  }

  @Post('webhook-events/:id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reprocess a failed webhook event (idempotent)' })
  @ApiEnvelope(OkDto)
  @ApiStandardErrors({ notFound: true })
  retryWebhook(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
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
  list(@Param('propertyId', ParseObjectIdPipe) propertyId: Types.ObjectId, @Query() q: AuditQueryDto) {
    return this.admin.auditLogs(q, propertyId);
  }
}

@Module({ imports: [WebhooksModule], controllers: [AdminController, PropertyAuditController], providers: [AdminService] })
export class AdminModule {}
