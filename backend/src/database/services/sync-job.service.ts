import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { addDays, formatDateOnly, todayIn } from '../common/dates';
import { redactSecrets } from '../common/redact';
import type { SyncJob } from '../db-types';
import { ChannelCode, MappingStatus, NotificationChannel, NotificationType, SyncEntityType, SyncJobStatus, SyncJobType, SyncLogStatus } from '../enums';
import { NotFoundError } from '../errors';
import { Db, InjectDb, j } from '../kysely';
import { insertNotification } from '../repos';
import { ChannelMappingService, SYNC_FLAG_FOR } from './channel-mapping.service';

type Id = string;

const LEASE_MS = 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;

@Injectable()
export class SyncJobService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly channels: ChannelMappingService,
  ) {}

  /**
   * Outbox write: queue one job per (mapped external listing × job type) for a room type and date range. Call it inside
   * the transaction that made the change.
   */
  async enqueueForRoomType(
    q: Db | null,
    input: { propertyId: Id; roomTypeId: Id; types: SyncJobType[]; dateFrom: Date; dateTo: Date; entityType?: SyncEntityType; entityId?: Id },
  ): Promise<number> {
    const conn = q ?? this.db;
    const targets = await this.channels.getOutboundTargets(input.propertyId, input.roomTypeId, conn);
    const jobs = targets.flatMap((t) =>
      input.types
        .filter((type) => {
          const flag = SYNC_FLAG_FOR[type];
          return flag === null || t[flag] === true;
        })
        .map((type) => ({
          propertyId: input.propertyId,
          channel: t.channel,
          channelListingId: t.channelListingId,
          roomTypeId: input.roomTypeId,
          type,
          entityType: input.entityType ?? SyncEntityType.ROOM_TYPE,
          entityId: input.entityId ?? input.roomTypeId,
          dateFrom: formatDateOnly(input.dateFrom),
          dateTo: formatDateOnly(input.dateTo),
        })),
    );
    if (jobs.length) await conn.insertInto('syncJobs').values(jobs).execute();
    return jobs.length;
  }

  /** After (re)connecting a channel: push the full horizon for every mapped room type. */
  async enqueueFullResync(propertyId: Id, channel: ChannelCode): Promise<number> {
    const property = await this.db.selectFrom('properties').select(['timezone', 'bookingHorizonDays']).where('id', '=', propertyId).executeTakeFirst();
    if (!property) throw new NotFoundError('Property', propertyId);
    const from = todayIn(property.timezone);
    const to = addDays(from, property.bookingHorizonDays);
    const mappings = await this.db
      .selectFrom('channelRoomMappings')
      .select(['channelListingId', 'roomTypeId'])
      .where('propertyId', '=', propertyId)
      .where('channel', '=', channel)
      .where('status', '=', MappingStatus.ACTIVE)
      .execute();
    const jobs = mappings.flatMap((mp) =>
      [SyncJobType.INVENTORY, SyncJobType.RATES, SyncJobType.RESTRICTIONS].map((type) => ({
        propertyId,
        channel,
        channelListingId: mp.channelListingId,
        roomTypeId: mp.roomTypeId,
        type,
        entityType: SyncEntityType.ROOM_TYPE,
        entityId: mp.roomTypeId,
        dateFrom: formatDateOnly(from),
        dateTo: formatDateOnly(to),
      })),
    );
    if (jobs.length) await this.db.insertInto('syncJobs').values(jobs).execute();
    return jobs.length;
  }

  /**
   * Atomically claim the next due job. Jobs whose worker died (lease expired while PROCESSING) are reclaimed. Safe for
   * any number of concurrent workers: the inner SELECT ... FOR UPDATE SKIP LOCKED hands each row to exactly one of them.
   */
  async claimNext(workerId: string, now = new Date()): Promise<SyncJob | null> {
    const row = await this.db
      .updateTable('syncJobs')
      .set({ status: SyncJobStatus.PROCESSING, lockedBy: workerId, lockedUntil: new Date(now.getTime() + LEASE_MS), startedAt: now, attempts: sql`attempts + 1` })
      .where('id', '=', (eb) =>
        eb
          .selectFrom('syncJobs')
          .select('id')
          .where((w) =>
            w.or([
              w.and([w('status', 'in', [SyncJobStatus.PENDING, SyncJobStatus.RETRYING]), w('scheduledAt', '<=', now)]),
              w.and([w('status', '=', SyncJobStatus.PROCESSING), w('lockedUntil', '<', now)]),
            ]),
          )
          .orderBy('scheduledAt')
          .limit(1)
          .forUpdate()
          .skipLocked(),
      )
      .returningAll()
      .executeTakeFirst();
    return row ?? null;
  }

  async complete(jobId: Id, workerId: string): Promise<boolean> {
    const res = await this.db
      .updateTable('syncJobs')
      .set({ status: SyncJobStatus.SUCCESS, completedAt: new Date(), lockedUntil: null, lastError: null })
      .where('id', '=', jobId)
      .where('lockedBy', '=', workerId)
      .where('status', '=', SyncJobStatus.PROCESSING)
      .executeTakeFirst();
    return Number(res.numUpdatedRows) === 1;
  }

  /** Exponential backoff with jitter; FAILED (and a staff alert) after maxAttempts. */
  async fail(jobId: Id, workerId: string, error: string): Promise<SyncJobStatus | null> {
    const job = await this.db.selectFrom('syncJobs').selectAll().where('id', '=', jobId).where('lockedBy', '=', workerId).where('status', '=', SyncJobStatus.PROCESSING).executeTakeFirst();
    if (!job) return null;
    const exhausted = job.attempts >= job.maxAttempts;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (job.attempts - 1), BACKOFF_MAX_MS);
    const jitter = Math.floor(Math.random() * delay * 0.2);
    const status = exhausted ? SyncJobStatus.FAILED : SyncJobStatus.RETRYING;
    await this.db
      .updateTable('syncJobs')
      .set({
        status,
        lastError: error.slice(0, 4000),
        lockedUntil: null,
        lockedBy: null,
        ...(exhausted ? { completedAt: new Date() } : { scheduledAt: new Date(Date.now() + delay + jitter) }),
      })
      .where('id', '=', jobId)
      .where('lockedBy', '=', workerId)
      .execute();
    if (exhausted) await this.alertSyncFailed(job, error);
    return status;
  }

  /** BullMQ path: lease one specific job. Null if it is finished or leased by a live worker. */
  async claimById(jobId: Id, workerId: string, now = new Date()): Promise<SyncJob | null> {
    const row = await this.db
      .updateTable('syncJobs')
      .set({ status: SyncJobStatus.PROCESSING, lockedBy: workerId, lockedUntil: new Date(now.getTime() + LEASE_MS), startedAt: now, attempts: sql`attempts + 1` })
      .where('id', '=', jobId)
      .where((w) => w.or([w('status', 'in', [SyncJobStatus.PENDING, SyncJobStatus.RETRYING]), w.and([w('status', '=', SyncJobStatus.PROCESSING), w('lockedUntil', '<', now)])]))
      .returningAll()
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * BullMQ path: BullMQ owns retries and backoff; this mirrors the outcome on the sync_jobs row (RETRYING, or FAILED
   * plus a staff alert on the final attempt). The reservation that caused the job is never touched.
   */
  async recordAttemptFailure(jobId: Id, workerId: string, error: string, final: boolean): Promise<void> {
    const job = await this.db
      .updateTable('syncJobs')
      .set({ status: final ? SyncJobStatus.FAILED : SyncJobStatus.RETRYING, lastError: error.slice(0, 4000), lockedUntil: null, lockedBy: null, ...(final ? { completedAt: new Date() } : {}) })
      .where('id', '=', jobId)
      .where('lockedBy', '=', workerId)
      .returningAll()
      .executeTakeFirst();
    if (job && final) await this.alertSyncFailed(job, error);
  }

  private async alertSyncFailed(job: SyncJob, error: string): Promise<void> {
    const property = await this.db.selectFrom('properties').select('ownerId').where('id', '=', job.propertyId).executeTakeFirst();
    if (!property) return;
    await insertNotification(this.db, {
      propertyId: job.propertyId,
      userId: property.ownerId,
      type: NotificationType.CHANNEL_SYNC_FAILED,
      channel: NotificationChannel.IN_APP,
      message: `${job.channel} ${job.type} sync failed after ${job.attempts} attempts: ${error.slice(0, 300)}`,
      metadata: { syncJobId: job.id },
    });
  }

  /** Request/response metadata is redacted before it is stored: tokens never reach sync_logs. */
  async log(entry: {
    propertyId: Id;
    channel: ChannelCode;
    syncJobId?: Id | null;
    action: string;
    status: SyncLogStatus;
    requestMetadata?: Record<string, unknown>;
    responseMetadata?: Record<string, unknown>;
    error?: string;
    duration: number;
  }): Promise<void> {
    const plain = (v: Record<string, unknown> | undefined) => redactSecrets(JSON.parse(JSON.stringify(v ?? {})) as Record<string, unknown>);
    await this.db
      .insertInto('syncLogs')
      .values({
        propertyId: entry.propertyId,
        channel: entry.channel,
        syncJobId: entry.syncJobId ?? null,
        action: entry.action,
        status: entry.status,
        requestMetadata: j(plain(entry.requestMetadata)),
        responseMetadata: j(plain(entry.responseMetadata)),
        error: entry.error ? redactSecrets(entry.error).slice(0, 4000) : null,
        duration: Math.max(0, Math.round(entry.duration)),
      })
      .execute();
  }
}
