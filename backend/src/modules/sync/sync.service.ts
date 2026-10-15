import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { addDays, eachNight, formatDateOnly, todayIn } from '../../database/common/dates';
import { ChannelConnectionStatus, MappingStatus, SyncJobType, SyncLogStatus } from '../../database/enums';
import { ChannelError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { SyncJob } from '../../database/schemas/ops.schema';
import { ChannelMappingService } from '../../database/services/channel-mapping.service';
import { SyncJobService } from '../../database/services/sync-job.service';
import { JobContext, isFinalAttempt, isRetryable, nonRetryable } from '../../jobs/job-handler';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { ChannelAdapterRegistry } from '../channels/channel-registry';
import { ChannelsService } from '../channels/channels.service';
import type { AvailabilityUpdate, PushResult, RateUpdate, RestrictionUpdate } from '../channels/interfaces/channel-adapter.interface';

/**
 * Executes one sync_jobs row: read the CURRENT master data for its date
 * range, translate it to channel-neutral updates for the mapped listing, and
 * hand them to the channel's adapter. Pushing absolute values ("Deluxe AC on
 * 2026-10-05 = 9") makes retries and out-of-order runs harmless.
 *
 * A failing channel never affects reservations. The job is retried with
 * exponential backoff by the queue, and after the last attempt it is marked
 * FAILED and staff are alerted.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly syncJobs: SyncJobService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly channels: ChannelsService,
    private readonly outbox: OutboxDispatcher,
  ) {
    this.m = getModels(connection);
  }

  async run(ctx: JobContext, syncJobId: string): Promise<{ status: string; pushed?: number }> {
    const workerId = `${process.pid}:${ctx.id}:${ctx.attemptsMade}`;
    const job = await this.syncJobs.claimById(new Types.ObjectId(syncJobId), workerId);
    if (!job) return { status: 'SKIPPED_ALREADY_HANDLED' };
    const started = Date.now();
    try {
      const conn = await this.m.ChannelConnection.findOne({ propertyId: job.propertyId, channel: job.channel }, { status: 1, metadata: 1 }).lean();
      if (!conn || conn.status !== ChannelConnectionStatus.CONNECTED) {
        // Nothing to push to. A full resync runs when the channel is (re)connected.
        await this.syncJobs.complete(job._id, workerId);
        return { status: 'SKIPPED_NOT_CONNECTED' };
      }
      if ((conn.metadata as { mock?: boolean } | undefined)?.mock) {
        // Seed/sandbox connection with no real credentials: nothing real to push to.
        await this.syncJobs.complete(job._id, workerId);
        return { status: 'SKIPPED_MOCK_CONNECTION' };
      }
      const adapter = this.registry.get(job.channel);
      const { creds } = await this.channels.credentials(job.propertyId, adapter);

      let result: PushResult = { accepted: 0, rejected: 0 };
      let count = 0;
      switch (job.type) {
        case SyncJobType.INVENTORY: {
          const updates = await this.availabilityUpdates(job);
          count = updates.length;
          if (count) result = await adapter.updateAvailability(creds, updates);
          break;
        }
        case SyncJobType.RESTRICTIONS: {
          const updates = await this.restrictionUpdates(job);
          count = updates.length;
          if (count) result = await adapter.updateRestrictions(creds, updates);
          break;
        }
        case SyncJobType.RATES: {
          const updates = await this.rateUpdates(job);
          count = updates.length;
          if (count) result = await adapter.updateRates(creds, updates);
          break;
        }
        case SyncJobType.LISTING:
          count = await this.channels.importListings(job.propertyId, adapter);
          break;
        case SyncJobType.RESERVATION:
          break;
      }

      await this.syncJobs.log({
        propertyId: job.propertyId,
        channel: job.channel,
        syncJobId: job._id,
        action: `push_${job.type.toLowerCase()}`,
        status: SyncLogStatus.SUCCESS,
        requestMetadata: { updates: count, dateFrom: job.dateFrom, dateTo: job.dateTo, roomTypeId: job.roomTypeId, attempt: ctx.attemptsMade + 1 },
        responseMetadata: { ...result },
        duration: Date.now() - started,
      });
      await this.syncJobs.complete(job._id, workerId);
      const now = new Date();
      await this.m.ChannelConnection.updateOne({ propertyId: job.propertyId, channel: job.channel }, { $set: { lastSyncAt: now, lastError: null } });
      if (job.channelListingId && job.roomTypeId) {
        await this.m.ChannelRoomMapping.updateMany({ channelListingId: job.channelListingId, roomTypeId: job.roomTypeId }, { $set: { lastSyncedAt: now } });
      }
      return { status: 'SUCCESS', pushed: count };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const final = !isRetryable(err) || isFinalAttempt(ctx);
      await this.syncJobs.log({
        propertyId: job.propertyId,
        channel: job.channel,
        syncJobId: job._id,
        action: `push_${job.type.toLowerCase()}`,
        status: SyncLogStatus.FAILED,
        requestMetadata: { dateFrom: job.dateFrom, dateTo: job.dateTo, roomTypeId: job.roomTypeId, attempt: ctx.attemptsMade + 1 },
        error: message,
        duration: Date.now() - started,
      });
      await this.syncJobs.recordAttemptFailure(job._id, workerId, message, final);
      if (final) {
        await this.m.ChannelConnection.updateOne({ propertyId: job.propertyId, channel: job.channel }, { $set: { lastError: message.slice(0, 2000) } });
        void this.outbox.flush(); // deliver the CHANNEL_SYNC_FAILED alert
        this.logger.error(`sync ${job.type} → ${job.channel} failed permanently: ${message}`);
        throw nonRetryable(err);
      }
      throw err;
    }
  }

  // ------------------------------------------------------------ builders

  private async targets(job: SyncJob, flag: 'syncAvailability' | 'syncRates' | 'syncRestrictions') {
    if (!job.channelListingId || !job.roomTypeId) return [];
    const [listing, mappings] = await Promise.all([
      this.m.ChannelListing.findById(job.channelListingId, { externalListingId: 1 }).lean(),
      this.m.ChannelRoomMapping.find({ channelListingId: job.channelListingId, roomTypeId: job.roomTypeId, status: MappingStatus.ACTIVE, [flag]: true }).lean(),
    ]);
    if (!listing) return [];
    return mappings.map((mp) => ({ mapping: mp, externalListingId: listing.externalListingId }));
  }

  /** Clamp to [today, horizon): past nights are never pushed. */
  private async window(job: SyncJob): Promise<{ from: Date; to: Date } | null> {
    const property = await this.m.Property.findById(job.propertyId, { timezone: 1, bookingHorizonDays: 1 }).lean();
    if (!property) return null;
    const today = todayIn(property.timezone);
    const horizon = addDays(today, property.bookingHorizonDays);
    const from = job.dateFrom && job.dateFrom > today ? job.dateFrom : today;
    const to = job.dateTo && job.dateTo < horizon ? job.dateTo : horizon;
    return from < to ? { from, to } : null;
  }

  async availabilityUpdates(job: SyncJob): Promise<AvailabilityUpdate[]> {
    const targets = await this.targets(job, 'syncAvailability');
    const w = await this.window(job);
    if (!targets.length || !w) return [];
    const rows = await this.m.Inventory.find(
      { propertyId: job.propertyId, roomTypeId: job.roomTypeId, date: { $gte: w.from, $lt: w.to } },
      { date: 1, available: 1, stopSell: 1 },
    ).lean();
    return targets.flatMap((t) =>
      rows.map((r) => ({
        externalListingId: t.externalListingId,
        externalRoomId: t.mapping.externalRoomId,
        date: formatDateOnly(r.date),
        // Stop-sell nights are pushed as 0 so channels that ignore the flag still stop selling.
        available: r.stopSell ? 0 : Math.max(0, r.available),
        stopSell: r.stopSell,
      })),
    );
  }

  async restrictionUpdates(job: SyncJob): Promise<RestrictionUpdate[]> {
    const targets = await this.targets(job, 'syncRestrictions');
    const w = await this.window(job);
    if (!targets.length || !w) return [];
    const [rows, inv] = await Promise.all([
      this.m.Restriction.find({ propertyId: job.propertyId, roomTypeId: job.roomTypeId, date: { $gte: w.from, $lt: w.to } }).lean(),
      this.m.Inventory.find({ propertyId: job.propertyId, roomTypeId: job.roomTypeId, date: { $gte: w.from, $lt: w.to } }, { date: 1, stopSell: 1 }).lean(),
    ]);
    const byDate = new Map(rows.map((r) => [r.date.getTime(), r]));
    const stop = new Map(inv.map((r) => [r.date.getTime(), r.stopSell]));
    // Every night is sent, including ones without a row, so cleared restrictions propagate too.
    return targets.flatMap((t) =>
      eachNight(w.from, w.to).map((d) => {
        const r = byDate.get(d.getTime());
        return {
          externalListingId: t.externalListingId,
          externalRoomId: t.mapping.externalRoomId,
          date: formatDateOnly(d),
          minimumStay: r?.minimumStay ?? null,
          maximumStay: r?.maximumStay ?? null,
          closedToArrival: r?.closedToArrival ?? false,
          closedToDeparture: r?.closedToDeparture ?? false,
          closed: !!(r?.closed || r?.stopSell || stop.get(d.getTime())),
        };
      }),
    );
  }

  async rateUpdates(job: SyncJob): Promise<RateUpdate[]> {
    const targets = await this.targets(job, 'syncRates');
    const w = await this.window(job);
    if (!targets.length || !w) return [];
    const rateMappings = await this.m.ChannelRateMapping.find({
      channelRoomMappingId: { $in: targets.map((t) => t.mapping._id) },
      status: MappingStatus.ACTIVE,
    }).lean();
    const ratePlans = await this.m.RatePlan.find({ _id: { $in: rateMappings.map((r) => r.ratePlanId) } }, { basePrice: 1, currency: 1, status: 1 }).lean();
    const rpById = new Map(ratePlans.map((rp) => [String(rp._id), rp]));
    const nights = eachNight(w.from, w.to);
    return targets.flatMap((t) =>
      rateMappings
        .filter((rm) => rm.channelRoomMappingId.equals(t.mapping._id))
        .flatMap((rm) => {
          const rp = rpById.get(String(rm.ratePlanId));
          if (!rp) return [];
          const price = ChannelMappingService.channelPrice(rp.basePrice, rm);
          return nights.map((d) => ({
            externalListingId: t.externalListingId,
            externalRoomId: t.mapping.externalRoomId,
            externalRatePlanId: rm.externalRatePlanId,
            date: formatDateOnly(d),
            price,
            currency: rp.currency,
          }));
        }),
    );
  }

  /** Confirm receipt of an imported booking to the channel (required by some OTAs). */
  async acknowledge(propertyId: string, channel: string, externalReservationId: string, ctx: JobContext): Promise<void> {
    const adapter = this.registry.get(channel);
    try {
      const { creds } = await this.channels.credentials(new Types.ObjectId(propertyId), adapter);
      await adapter.acknowledgeReservation(creds, externalReservationId);
    } catch (err) {
      if (!isRetryable(err) || isFinalAttempt(ctx)) throw nonRetryable(err);
      throw err;
    }
  }

  /** Safety net for missed webhooks: fetch recent reservations and feed them through the webhook inbox. */
  async pullReservations(connectionId: string, ingest: (channel: string, events: unknown[]) => Promise<number>): Promise<number> {
    const conn = await this.m.ChannelConnection.findById(connectionId, { propertyId: 1, channel: 1, status: 1, lastSyncAt: 1 }).lean();
    if (!conn || conn.status !== ChannelConnectionStatus.CONNECTED) return 0;
    const adapter = this.registry.get(conn.channel);
    try {
      const { creds } = await this.channels.credentials(conn.propertyId, adapter);
      const events = await adapter.getReservations(creds, { since: new Date(Date.now() - 2 * 86_400_000) });
      return ingest(conn.channel, events);
    } catch (err) {
      if (err instanceof ChannelError && !err.retryable) return 0;
      throw err;
    }
  }
}
