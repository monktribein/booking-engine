import { Injectable, Logger } from '@nestjs/common';
import { addDays, eachNight, formatDateOnly, todayIn } from '../../database/common/dates';
import { redactText } from '../channels/providers/provider-engine';
import { j } from '../../database/kysely';
import type { NormalizedReservationEvent } from '../../database/services/webhook.service';
import { ChannelCode, ChannelConnectionStatus, MappingStatus, SyncJobType, SyncLogStatus } from '../../database/enums';
import { ChannelError } from '../../database/errors';
import type { SyncJob } from '../../database/db-types';
import { Db, InjectDb } from '../../database/kysely';
import { d } from '../../database/sql';
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
const POLL_OVERLAP_MS = 10 * 60_000;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly syncJobs: SyncJobService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly channels: ChannelsService,
    private readonly outbox: OutboxDispatcher,
  ) {}

  async run(ctx: JobContext, syncJobId: string): Promise<{ status: string; pushed?: number }> {
    const workerId = `${process.pid}:${ctx.id}:${ctx.attemptsMade}`;
    const job = await this.syncJobs.claimById(syncJobId, workerId);
    if (!job) return { status: 'SKIPPED_ALREADY_HANDLED' };
    const started = Date.now();
    try {
      const conn = await this.db.selectFrom('channelConnections').select(['status', 'metadata']).where('propertyId', '=', job.propertyId).where('channel', '=', job.channel).executeTakeFirst();
      if (!conn || conn.status !== ChannelConnectionStatus.CONNECTED) {
        // Nothing to push to. A full resync runs when the channel is (re)connected.
        await this.syncJobs.complete(job.id, workerId);
        return { status: 'SKIPPED_NOT_CONNECTED' };
      }
      if ((conn.metadata as { mock?: boolean } | undefined)?.mock) {
        // Seed/sandbox connection with no real credentials: nothing real to push to.
        await this.syncJobs.complete(job.id, workerId);
        return { status: 'SKIPPED_MOCK_CONNECTION' };
      }
      const adapter = await this.registry.forProperty(job.propertyId, job.channel);
      const needed = ({ [SyncJobType.INVENTORY]: 'pushAvailability', [SyncJobType.RATES]: 'pushRates', [SyncJobType.RESTRICTIONS]: 'pushRestrictions', [SyncJobType.LISTING]: 'listings' } as Record<string, string>)[job.type];
      if (needed && adapter.supports && !adapter.supports(needed)) {
        // The provider does not offer this operation: record it as skipped, never as pushed.
        await this.syncJobs.log({ propertyId: job.propertyId, channel: job.channel, syncJobId: job.id, action: `push_${job.type.toLowerCase()}`, status: SyncLogStatus.SUCCESS, requestMetadata: { skipped: true }, responseMetadata: { skipped: `${adapter.displayName} does not support ${needed}` }, duration: 0 });
        await this.syncJobs.complete(job.id, workerId);
        return { status: 'SKIPPED_UNSUPPORTED_BY_PROVIDER' };
      }
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
        channel: job.channel as ChannelCode,
        syncJobId: job.id,
        action: `push_${job.type.toLowerCase()}`,
        status: SyncLogStatus.SUCCESS,
        requestMetadata: { updates: count, dateFrom: job.dateFrom, dateTo: job.dateTo, roomTypeId: job.roomTypeId, attempt: ctx.attemptsMade + 1 },
        responseMetadata: { ...result },
        duration: Date.now() - started,
      });
      await this.syncJobs.complete(job.id, workerId);
      const now = new Date();
      await this.db.updateTable('channelConnections').set({ lastSyncAt: now, lastError: null }).where('propertyId', '=', job.propertyId).where('channel', '=', job.channel).execute();
      if (job.channelListingId && job.roomTypeId) {
        await this.db.updateTable('channelRoomMappings').set({ lastSyncedAt: now }).where('channelListingId', '=', job.channelListingId).where('roomTypeId', '=', job.roomTypeId).execute();
      }
      return { status: 'SUCCESS', pushed: count };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const final = !isRetryable(err) || isFinalAttempt(ctx);
      await this.syncJobs.log({
        propertyId: job.propertyId,
        channel: job.channel as ChannelCode,
        syncJobId: job.id,
        action: `push_${job.type.toLowerCase()}`,
        status: SyncLogStatus.FAILED,
        requestMetadata: { dateFrom: job.dateFrom, dateTo: job.dateTo, roomTypeId: job.roomTypeId, attempt: ctx.attemptsMade + 1 },
        error: message,
        duration: Date.now() - started,
      });
      await this.syncJobs.recordAttemptFailure(job.id, workerId, message, final);
      if (final) {
        await this.db.updateTable('channelConnections').set({ lastError: message.slice(0, 2000) }).where('propertyId', '=', job.propertyId).where('channel', '=', job.channel).execute();
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
      this.db.selectFrom('channelListings').select('externalListingId').where('id', '=', job.channelListingId).executeTakeFirst(),
      this.db
        .selectFrom('channelRoomMappings')
        .selectAll()
        .where('channelListingId', '=', job.channelListingId)
        .where('roomTypeId', '=', job.roomTypeId)
        .where('status', '=', MappingStatus.ACTIVE)
        .where(flag, '=', true)
        .execute(),
    ]);
    if (!listing) return [];
    return mappings.map((mp) => ({ mapping: mp, externalListingId: listing.externalListingId }));
  }

  /** Clamp to [today, horizon): past nights are never pushed. */
  private async window(job: SyncJob): Promise<{ from: Date; to: Date } | null> {
    const property = await this.db.selectFrom('properties').select(['timezone', 'bookingHorizonDays']).where('id', '=', job.propertyId).executeTakeFirst();
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
    const rows = await this.db
      .selectFrom('inventory')
      .select(['date', 'available', 'stopSell'])
      .where('propertyId', '=', job.propertyId)
      .where('roomTypeId', '=', job.roomTypeId!)
      .where('date', '>=', d(w.from))
      .where('date', '<', d(w.to))
      .orderBy('date')
      .execute();
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
      this.db.selectFrom('restrictions').selectAll().where('propertyId', '=', job.propertyId).where('roomTypeId', '=', job.roomTypeId!).where('date', '>=', d(w.from)).where('date', '<', d(w.to)).execute(),
      this.db.selectFrom('inventory').select(['date', 'stopSell']).where('propertyId', '=', job.propertyId).where('roomTypeId', '=', job.roomTypeId!).where('date', '>=', d(w.from)).where('date', '<', d(w.to)).execute(),
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
    const rateMappings = await this.db
      .selectFrom('channelRateMappings')
      .selectAll()
      .where('channelRoomMappingId', 'in', targets.map((t) => t.mapping.id))
      .where('status', '=', MappingStatus.ACTIVE)
      .execute();
    const ratePlans = rateMappings.length
      ? await this.db.selectFrom('ratePlans').select(['id', 'basePrice', 'currency', 'status']).where('id', 'in', rateMappings.map((r) => r.ratePlanId)).execute()
      : [];
    const rpById = new Map(ratePlans.map((rp) => [rp.id, rp]));
    const nights = eachNight(w.from, w.to);
    return targets.flatMap((t) =>
      rateMappings
        .filter((rm) => rm.channelRoomMappingId === t.mapping.id)
        .flatMap((rm) => {
          const rp = rpById.get(rm.ratePlanId);
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
    const adapter = await this.registry.forProperty(propertyId, channel);
    if (adapter.supports && !adapter.supports('ackReservation')) return; // the provider has no acknowledgement step
    try {
      const { creds } = await this.channels.credentials(propertyId, adapter);
      await adapter.acknowledgeReservation(creds, externalReservationId);
    } catch (err) {
      if (!isRetryable(err) || isFinalAttempt(ctx)) throw nonRetryable(err);
      throw err;
    }
  }

  /**
   * Safety net for missed webhooks, per connection. A configured provider is read incrementally from a persisted cursor (with an
   * overlap window, so a late-arriving change is fetched twice rather than never; the inbox dedupes the repeat). The cursor moves
   * only AFTER the events are durably stored, so a failure anywhere leaves it where it was and the next poll retries the same window.
   *
   * Adapters that return the complete current state (an iCal feed has no "changed since") also list every id they contain
   * (`presentExternalIds`). For those, an event is ingested only if it differs from what we hold, and a booking that has vanished
   * from the feed is cancelled, but only when the feed was read completely and the removal is not suspiciously large.
   */
  async pullReservations(connectionId: string, ingest: (channel: string, events: NormalizedReservationEvent[]) => Promise<number>): Promise<number> {
    const conn = await this.db.selectFrom('channelConnections').selectAll().where('id', '=', connectionId).executeTakeFirst();
    if (!conn || conn.status !== ChannelConnectionStatus.CONNECTED) return 0;
    const startedAt = new Date();
    try {
      const adapter = await this.registry.forConnection(conn);
      if (adapter.supports && !adapter.supports('pullReservations')) return 0; // webhook-only provider
      const { creds } = await this.channels.credentials(conn.propertyId, adapter);
      const cursor = (conn.pollCursor as { updatedSince?: string } | null)?.updatedSince;
      const since = cursor && !Number.isNaN(Date.parse(cursor)) ? new Date(Date.parse(cursor) - POLL_OVERLAP_MS) : new Date(startedAt.getTime() - 2 * 86_400_000);
      type Pull = { events: NormalizedReservationEvent[]; newestUpdatedAt?: string; skipped: { externalReservationId?: string; reason: string }[]; presentExternalIds?: string[] };
      let pull: Pull;
      if (typeof (adapter as { pullReservations?: unknown }).pullReservations === 'function') {
        pull = await (adapter as unknown as { pullReservations(since: Date): Promise<Pull> }).pullReservations(since);
      } else {
        pull = { events: await adapter.getReservations(creds, { since }), skipped: [] };
      }
      const isConfigured = !this.registry.isBuiltIn(conn.channel);
      const skipped = [...pull.skipped];
      let events = pull.events;

      if (isConfigured) {
        // Stays that are over, or further out than the sellable horizon, cannot be booked into inventory: report, do not fail.
        const property = await this.db.selectFrom('properties').select(['timezone', 'bookingHorizonDays']).where('id', '=', conn.propertyId).executeTakeFirstOrThrow();
        const today = formatDateOnly(todayIn(property.timezone));
        const last = formatDateOnly(addDays(todayIn(property.timezone), property.bookingHorizonDays));
        events = events.filter((e) => {
          if (e.checkOut <= today) return false; // already over: nothing to hold
          if (e.checkIn > last) {
            skipped.push({ externalReservationId: e.externalReservationId, reason: `starts after the sellable horizon (${last}); it is picked up once the horizon reaches it` });
            return false;
          }
          return true;
        });
      }

      let removed: NormalizedReservationEvent[] = [];
      if (pull.presentExternalIds) {
        const present = new Set(pull.presentExternalIds);
        const local = await this.db
          .selectFrom('reservations')
          .select(['id', 'externalReservationId', 'status', 'checkIn', 'checkOut', 'updatedAt'])
          .where('propertyId', '=', conn.propertyId)
          .where('source', '=', conn.channel)
          .where('externalScope', '=', conn.id)
          .where('externalReservationId', 'is not', null)
          .execute();
        const byExt = new Map(local.map((l) => [l.externalReservationId as string, l]));
        const ymd = (d: Date | string) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
        const changed: NormalizedReservationEvent[] = [];
        for (const e of events) {
          const l = byExt.get(e.externalReservationId);
          const active = l && (l.status === 'PENDING' || l.status === 'CONFIRMED' || l.status === 'CHECKED_IN');
          if (e.kind === 'RESERVATION_CANCELLED') {
            if (!active) continue; // already cancelled or never held
          } else if (l && !active) {
            skipped.push({ externalReservationId: e.externalReservationId, reason: 'it was cancelled here earlier and has reappeared in the feed; review it manually' });
            continue;
          } else if (l && ymd(l.checkIn) === e.checkIn && ymd(l.checkOut) === e.checkOut) continue; // identical to what we hold
          changed.push({ ...e, revision: `${e.revision ?? ''}:${l ? l.updatedAt.getTime() : 0}` }); // a new id per state transition
        }
        events = changed;
        // Removals: held, in the future, and no longer in the (completely read) feed.
        const todayStr = formatDateOnly(todayIn((await this.db.selectFrom('properties').select('timezone').where('id', '=', conn.propertyId).executeTakeFirstOrThrow()).timezone));
        const heldFuture = local.filter((l) => (l.status === 'PENDING' || l.status === 'CONFIRMED') && ymd(l.checkOut) > todayStr);
        const gone = heldFuture.filter((l) => !present.has(l.externalReservationId as string));
        if (gone.length) {
          if (gone.length > Math.max(2, Math.ceil(heldFuture.length * 0.5))) {
            skipped.push({ reason: `${gone.length} of ${heldFuture.length} held calendar blocks are missing from the feed; not cancelling them automatically (the feed may be incomplete). Review the calendar.` });
          } else {
            removed = gone.map((l) => ({
              kind: 'RESERVATION_CANCELLED' as const,
              channel: conn.channel,
              externalScope: conn.id,
              revision: `removed:${l.updatedAt.getTime()}`,
              externalListingId: '',
              externalReservationId: l.externalReservationId as string,
              checkIn: ymd(l.checkIn),
              checkOut: ymd(l.checkOut),
              adults: 1,
              guest: { firstName: 'Calendar', lastName: 'block' },
              rooms: [],
              currency: 'INR',
              paymentCollectedByChannel: true,
            }));
          }
        }
      }

      const fresh = await ingest(conn.channel, [...events, ...removed]);
      if (skipped.length) {
        await this.syncJobs.log({
          propertyId: conn.propertyId,
          channel: conn.channel,
          action: 'poll_skipped',
          status: SyncLogStatus.FAILED,
          requestMetadata: { skipped: skipped.length },
          error: `${skipped.length} item(s) were not imported: ${skipped.slice(0, 10).map((x) => `${x.externalReservationId ?? 'feed'} (${x.reason})`).join('; ')}`.slice(0, 1900),
          duration: Date.now() - startedAt.getTime(),
        });
      }
      // Persisted only now that the events are stored. Built-in channels have no cursor semantics and keep none.
      await this.db
        .updateTable('channelConnections')
        .set({ lastPollAt: new Date(), lastPollError: null, ...(isConfigured ? { pollCursor: j({ updatedSince: pull.newestUpdatedAt && pull.newestUpdatedAt > (cursor ?? '') ? pull.newestUpdatedAt : startedAt.toISOString() }) } : {}) })
        .where('id', '=', connectionId)
        .execute();
      return fresh;
    } catch (err) {
      await this.db.updateTable('channelConnections').set({ lastPollError: redactText(err instanceof Error ? err.message : String(err)).slice(0, 1900) }).where('id', '=', connectionId).execute();
      if (err instanceof ChannelError && !err.retryable) return 0;
      throw err;
    }
  }
}
