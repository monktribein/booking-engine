import { Injectable, Logger, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import type { AppConfig } from '../config/configuration';
import { SYNC_JOB_SUCCESS_RETENTION_DAYS, SYNC_LOG_RETENTION_DAYS, WEBHOOK_DELIVERY_RETENTION_DAYS } from '../database/constants';
import { addDays, formatDateOnly, todayIn } from '../database/common/dates';
import { ChannelConnectionStatus, NotificationChannel, NotificationType, PropertyStatus, ReservationStatus, SyncJobStatus, WebhookDeliveryStatus } from '../database/enums';
import { Db, InjectDb } from '../database/kysely';

import { InventoryService } from '../database/services/inventory.service';
import { ReservationService } from '../database/services/reservation.service';
import { d } from '../database/sql';
import { ChannelAdapterRegistry } from '../modules/channels/channel-registry';
import { ChannelsModule } from '../modules/channels/channels.module';
import { ReconciliationService } from '../modules/channels/providers/reconciliation.service';
import { JobsProducer } from './jobs.producer';
import { OutboxDispatcher } from './outbox.dispatcher';
import { QUEUES } from './queues';

interface Task {
  name: string;
  everyMs: number;
  runAtStart?: boolean;
  run: () => Promise<unknown>;
}

/**
 * Periodic housekeeping. Every task is idempotent, so running it on several instances at once is safe (only wasteful).
 * Enable it on worker instances (SCHEDULER_ENABLED=true) and disable it on API-only instances.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Scheduler');
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly outbox: OutboxDispatcher,
    private readonly reservations: ReservationService,
    private readonly inventory: InventoryService,
    private readonly producer: JobsProducer,
    private readonly channels: ChannelAdapterRegistry,
    private readonly reconciliation: ReconciliationService,
  ) {}

  readonly tasks: Task[] = [
    { name: 'outbox-relay', everyMs: 5_000, run: () => this.outbox.relay() },
    { name: 'expire-pending-holds', everyMs: 60_000, run: () => this.reservations.expirePendingHolds().then(() => this.outbox.flush()) },
    { name: 'extend-inventory-horizon', everyMs: 6 * 3600_000, runAtStart: true, run: () => this.extendHorizons() },
    { name: 'checkin-reminders', everyMs: 3600_000, run: () => this.checkInReminders() },
    { name: 'channel-reconciliation', everyMs: 6 * 3600_000, run: () => this.reconciliation.runDue() },
    { name: 'channel-reservation-pull', everyMs: 60_000, run: () => this.queueReservationPulls() },
    // PostgreSQL has no TTL indexes: expired sessions, reset tokens and old logs are deleted here.
    { name: 'purge-expired', everyMs: 3600_000, runAtStart: true, run: () => this.purgeExpired() },
  ];

  onApplicationBootstrap() {
    if (!this.config.get('queue', { infer: true }).schedulerEnabled) return;
    for (const t of this.tasks) {
      const tick = () => this.runOnce(t);
      this.timers.push(setInterval(tick, t.everyMs).unref());
      if (t.runAtStart) setTimeout(tick, 1_000).unref();
    }
    this.logger.log(`started ${this.tasks.length} periodic tasks`);
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  /** Skips a tick if the previous run of the same task is still going. */
  async runOnce(t: Task) {
    if (this.running.has(t.name)) return;
    this.running.add(t.name);
    try {
      await t.run();
    } catch (err) {
      this.logger.error(`${t.name} failed: ${(err as Error).message}`);
    } finally {
      this.running.delete(t.name);
    }
  }

  async extendHorizons() {
    const properties = await this.db.selectFrom('properties').select('id').where('status', '=', PropertyStatus.ACTIVE).execute();
    let created = 0;
    for (const p of properties) created += await this.inventory.extendHorizon(p.id);
    if (created) this.logger.log(`materialised ${created} inventory rows`);
    return created;
  }

  /** One reminder per reservation (dedupe key), the day before arrival in the property's time zone. */
  async checkInReminders() {
    const properties = await this.db.selectFrom('properties').select(['id', 'timezone', 'name', 'checkInTime']).where('status', '=', PropertyStatus.ACTIVE).execute();
    let sent = 0;
    for (const p of properties) {
      const tomorrow = addDays(todayIn(p.timezone), 1);
      const due = await this.db
        .selectFrom('reservations')
        .select(['id', 'guest', 'reservationCode'])
        .where('propertyId', '=', p.id)
        .where('status', '=', ReservationStatus.CONFIRMED)
        .where('checkIn', '=', d(tomorrow))
        .where(sql<boolean>`guest->>'email' is not null`)
        .execute();
      for (const r of due) {
        // The unique dedupe key makes a repeated run a no-op (ON CONFLICT DO NOTHING).
        const res = await this.db
          .insertInto('notifications')
          .values({
            propertyId: p.id,
            reservationId: r.id,
            type: NotificationType.CHECKIN_REMINDER,
            channel: NotificationChannel.EMAIL,
            recipient: r.guest.email ?? null,
            subject: `See you tomorrow at ${p.name}`,
            message: `Your check-in for ${r.reservationCode} is on ${formatDateOnly(tomorrow)} from ${p.checkInTime}.`,
            dedupeKey: `checkin-reminder:${r.id}`,
          })
          .onConflict((oc) => oc.column('dedupeKey').where('dedupeKey', 'is not', null).doNothing())
          .executeTakeFirst();
        sent += Number(res.numInsertedOrUpdatedRows ?? 0);
      }
    }
    if (sent) void this.outbox.flush();
    return sent;
  }

  /**
   * Safety net for lost webhooks: poll each connected channel for recent reservations, each on ITS OWN interval (the connection's
   * poll interval; built-in channels default to 15 minutes; a null interval means webhooks only). The claim is a single conditional
   * UPDATE, so several scheduler instances cannot enqueue the same poll twice.
   */
  async queueReservationPulls() {
    const now = Date.now();
    const available = new Set(this.channels.list().filter((a) => a.isAvailable()).map((a) => a.channel));
    const conns = await this.db.selectFrom('channelConnections').select(['id', 'channel', 'pollIntervalSeconds']).where('status', '=', ChannelConnectionStatus.CONNECTED).execute();
    let queued = 0;
    for (const c of conns) {
      const builtIn = this.channels.isBuiltIn(c.channel);
      if (builtIn && !available.has(c.channel)) continue;
      if (!builtIn && !this.channels.providersEnabled) continue;
      const intervalMs = (c.pollIntervalSeconds ?? (builtIn ? 900 : 0)) * 1000;
      if (intervalMs <= 0) continue;
      const claimed = await this.db
        .updateTable('channelConnections')
        .set({ lastPollAt: new Date(now) })
        .where('id', '=', c.id)
        .where((w) => w.or([w('lastPollAt', 'is', null), w('lastPollAt', '<=', new Date(now - intervalMs))]))
        .returning('id')
        .executeTakeFirst();
      if (!claimed) continue;
      await this.producer.enqueue(QUEUES.RESERVATION_SYNC, 'pull', { kind: 'PULL', connectionId: c.id }, { jobId: `pull-${c.id}-${now}` });
      queued++;
    }
    return queued;
  }

  /**
   * Replaces MongoDB's TTL indexes: deletes expired auth sessions and reset tokens, old sync logs, finished sync jobs and
   * settled webhook deliveries. Bounded batches keep each statement short.
   */
  async purgeExpired(now = new Date()) {
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
    const del = async (run: () => Promise<{ numDeletedRows: bigint }>) => Number((await run()).numDeletedRows);
    const counts = {
      sessions: await del(() => this.db.deleteFrom('authSessions').where('expiresAt', '<', now).executeTakeFirst()),
      resetTokens: await del(() => this.db.deleteFrom('passwordResetTokens').where('expiresAt', '<', now).executeTakeFirst()),
      syncLogs: await del(() => this.db.deleteFrom('syncLogs').where('createdAt', '<', daysAgo(SYNC_LOG_RETENTION_DAYS)).executeTakeFirst()),
      syncJobs: await del(() => this.db.deleteFrom('syncJobs').where('status', '=', SyncJobStatus.SUCCESS).where('completedAt', '<', daysAgo(SYNC_JOB_SUCCESS_RETENTION_DAYS)).executeTakeFirst()),
      deliveries: await del(() =>
        this.db.deleteFrom('webhookDeliveries').where('status', 'in', [WebhookDeliveryStatus.DELIVERED, WebhookDeliveryStatus.FAILED]).where('updatedAt', '<', daysAgo(WEBHOOK_DELIVERY_RETENTION_DAYS)).executeTakeFirst(),
      ),
    };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total) this.logger.log(`purged ${total} expired rows ${JSON.stringify(counts)}`);
    return counts;
  }
}


@Module({ imports: [ChannelsModule], providers: [SchedulerService], exports: [SchedulerService] })
export class SchedulerModule {}
