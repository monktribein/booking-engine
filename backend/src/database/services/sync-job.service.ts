import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession } from 'mongodb';
import { Connection, Types } from 'mongoose';
import { addDays, todayIn } from '../common/dates';
import {
  ChannelCode,
  MappingStatus,
  NotificationChannel,
  NotificationType,
  SyncEntityType,
  SyncJobStatus,
  SyncJobType,
  SyncLogStatus,
} from '../enums';
import { NotFoundError } from '../errors';
import { Models, getModels } from '../models';
import type { SyncJob } from '../schemas/ops.schema';
import { ChannelMappingService, SYNC_FLAG_FOR } from './channel-mapping.service';

type Id = Types.ObjectId;

const LEASE_MS = 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60_000;

@Injectable()
export class SyncJobService {
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly channels: ChannelMappingService,
  ) {
    this.m = getModels(connection);
  }

  /**
   * Outbox write: queue one job per (mapped external listing × job type) for a
   * room type and date range. Call it inside the transaction that made the change.
   */
  async enqueueForRoomType(
    session: ClientSession | null,
    input: {
      propertyId: Id;
      roomTypeId: Id;
      types: SyncJobType[];
      dateFrom: Date;
      dateTo: Date;
      entityType?: SyncEntityType;
      entityId?: Id;
    },
  ): Promise<number> {
    const targets = await this.channels.getOutboundTargets(input.propertyId, input.roomTypeId, session);
    const now = new Date();
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
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          scheduledAt: now,
        })),
    );
    if (jobs.length) await this.m.SyncJob.insertMany(jobs, { session });
    return jobs.length;
  }

  /** After (re)connecting a channel: push the full horizon for every mapped room type. */
  async enqueueFullResync(propertyId: Id, channel: ChannelCode): Promise<number> {
    const property = await this.m.Property.findById(propertyId).lean();
    if (!property) throw new NotFoundError('Property', propertyId);
    const from = todayIn(property.timezone);
    const to = addDays(from, property.bookingHorizonDays);
    const mappings = await this.m.ChannelRoomMapping.find({ propertyId, channel, status: MappingStatus.ACTIVE }).lean();
    const jobs = mappings.flatMap((mp) =>
      [SyncJobType.INVENTORY, SyncJobType.RATES, SyncJobType.RESTRICTIONS].map((type) => ({
        propertyId,
        channel,
        channelListingId: mp.channelListingId,
        roomTypeId: mp.roomTypeId,
        type,
        entityType: SyncEntityType.ROOM_TYPE,
        entityId: mp.roomTypeId,
        dateFrom: from,
        dateTo: to,
      })),
    );
    if (jobs.length) await this.m.SyncJob.insertMany(jobs);
    return jobs.length;
  }

  /**
   * Atomically claim the next due job. Jobs whose worker died (lease expired
   * while PROCESSING) are reclaimed. Safe for any number of concurrent workers:
   * findOneAndUpdate on a single document is atomic.
   */
  async claimNext(workerId: string, now = new Date()): Promise<SyncJob | null> {
    return this.m.SyncJob.findOneAndUpdate(
      {
        $or: [
          { status: { $in: [SyncJobStatus.PENDING, SyncJobStatus.RETRYING] }, scheduledAt: { $lte: now } },
          { status: SyncJobStatus.PROCESSING, lockedUntil: { $lt: now } },
        ],
      },
      {
        $set: {
          status: SyncJobStatus.PROCESSING,
          lockedBy: workerId,
          lockedUntil: new Date(now.getTime() + LEASE_MS),
          startedAt: now,
        },
        $inc: { attempts: 1 },
      },
      { sort: { scheduledAt: 1 }, new: true },
    ).lean();
  }

  async complete(jobId: Id, workerId: string): Promise<boolean> {
    const res = await this.m.SyncJob.updateOne(
      { _id: jobId, lockedBy: workerId, status: SyncJobStatus.PROCESSING },
      { $set: { status: SyncJobStatus.SUCCESS, completedAt: new Date(), lockedUntil: null, lastError: null } },
    );
    return res.modifiedCount === 1;
  }

  /** Exponential backoff with jitter; FAILED (and a staff alert) after maxAttempts. */
  async fail(jobId: Id, workerId: string, error: string): Promise<SyncJobStatus | null> {
    const job = await this.m.SyncJob.findOne({ _id: jobId, lockedBy: workerId, status: SyncJobStatus.PROCESSING }).lean();
    if (!job) return null;
    const exhausted = job.attempts >= job.maxAttempts;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (job.attempts - 1), BACKOFF_MAX_MS);
    const jitter = Math.floor(Math.random() * delay * 0.2);
    const status = exhausted ? SyncJobStatus.FAILED : SyncJobStatus.RETRYING;
    await this.m.SyncJob.updateOne(
      { _id: jobId, lockedBy: workerId },
      {
        $set: {
          status,
          lastError: error.slice(0, 4000),
          lockedUntil: null,
          lockedBy: null,
          ...(exhausted ? { completedAt: new Date() } : { scheduledAt: new Date(Date.now() + delay + jitter) }),
        },
      },
    );
    if (exhausted) await this.alertSyncFailed(job, error);
    return status;
  }

  /** BullMQ path: lease one specific job. Null if it is finished or leased by a live worker. */
  async claimById(jobId: Id, workerId: string, now = new Date()): Promise<SyncJob | null> {
    return this.m.SyncJob.findOneAndUpdate(
      {
        _id: jobId,
        $or: [
          { status: { $in: [SyncJobStatus.PENDING, SyncJobStatus.RETRYING] } },
          { status: SyncJobStatus.PROCESSING, lockedUntil: { $lt: now } },
        ],
      },
      {
        $set: { status: SyncJobStatus.PROCESSING, lockedBy: workerId, lockedUntil: new Date(now.getTime() + LEASE_MS), startedAt: now },
        $inc: { attempts: 1 },
      },
      { new: true },
    ).lean();
  }

  /**
   * BullMQ path: BullMQ owns retries and backoff; this mirrors the outcome on the
   * sync_jobs row (RETRYING, or FAILED plus a staff alert on the final attempt).
   * The reservation that caused the job is never touched.
   */
  async recordAttemptFailure(jobId: Id, workerId: string, error: string, final: boolean): Promise<void> {
    const job = await this.m.SyncJob.findOneAndUpdate(
      { _id: jobId, lockedBy: workerId },
      {
        $set: {
          status: final ? SyncJobStatus.FAILED : SyncJobStatus.RETRYING,
          lastError: error.slice(0, 4000),
          lockedUntil: null,
          lockedBy: null,
          ...(final ? { completedAt: new Date() } : {}),
        },
      },
      { new: true },
    ).lean();
    if (job && final) await this.alertSyncFailed(job, error);
  }

  private async alertSyncFailed(job: SyncJob, error: string): Promise<void> {
    const property = await this.m.Property.findById(job.propertyId, { ownerId: 1 }).lean();
    if (!property) return;
    await this.m.Notification.create({
      propertyId: job.propertyId,
      userId: property.ownerId,
      type: NotificationType.CHANNEL_SYNC_FAILED,
      channel: NotificationChannel.IN_APP,
      message: `${job.channel} ${job.type} sync failed after ${job.attempts} attempts: ${error.slice(0, 300)}`,
      metadata: { syncJobId: job._id },
    });
  }

  /** Request/response metadata is redacted by the schema before it is stored. */
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
    await this.m.SyncLog.create(entry);
  }
}
