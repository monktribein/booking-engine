import { Injectable, Logger, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import type { AppConfig } from '../config/configuration';
import { addDays, formatDateOnly, todayIn } from '../database/common/dates';
import { isDuplicateKeyError } from '../database/common/schema-helpers';
import { ChannelConnectionStatus, NotificationChannel, NotificationType, PropertyStatus, ReservationStatus } from '../database/enums';
import { Models, getModels } from '../database/models';
import { InventoryService } from '../database/services/inventory.service';
import { ReservationService } from '../database/services/reservation.service';
import { ChannelAdapterRegistry } from '../modules/channels/channel-registry';
import { ChannelsModule } from '../modules/channels/channels.module';
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
 * Periodic housekeeping. Every task is idempotent, so running it on several
 * instances at once is safe (only wasteful). Enable it on worker instances
 * (SCHEDULER_ENABLED=true) and disable it on API-only instances.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Scheduler');
  private readonly m: Models;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();

  constructor(
    @InjectConnection() connection: Connection,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly outbox: OutboxDispatcher,
    private readonly reservations: ReservationService,
    private readonly inventory: InventoryService,
    private readonly producer: JobsProducer,
    private readonly channels: ChannelAdapterRegistry,
  ) {
    this.m = getModels(connection);
  }

  readonly tasks: Task[] = [
    { name: 'outbox-relay', everyMs: 5_000, run: () => this.outbox.relay() },
    { name: 'expire-pending-holds', everyMs: 60_000, run: () => this.reservations.expirePendingHolds().then(() => this.outbox.flush()) },
    { name: 'extend-inventory-horizon', everyMs: 6 * 3600_000, runAtStart: true, run: () => this.extendHorizons() },
    { name: 'checkin-reminders', everyMs: 3600_000, run: () => this.checkInReminders() },
    { name: 'channel-reservation-pull', everyMs: 15 * 60_000, run: () => this.queueReservationPulls() },
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
    const properties = await this.m.Property.find({ status: PropertyStatus.ACTIVE }, { _id: 1 }).lean();
    let created = 0;
    for (const p of properties) created += await this.inventory.extendHorizon(p._id);
    if (created) this.logger.log(`materialised ${created} inventory rows`);
    return created;
  }

  /** One reminder per reservation (dedupeKey), the day before arrival in the property's time zone. */
  async checkInReminders() {
    const properties = await this.m.Property.find({ status: PropertyStatus.ACTIVE }, { timezone: 1, name: 1, checkInTime: 1 }).lean();
    let sent = 0;
    for (const p of properties) {
      const tomorrow = addDays(todayIn(p.timezone), 1);
      const due = await this.m.Reservation.find(
        { propertyId: p._id, status: ReservationStatus.CONFIRMED, checkIn: tomorrow, 'guest.email': { $type: 'string' } },
        { guest: 1, reservationCode: 1 },
      ).lean();
      for (const r of due) {
        try {
          await this.m.Notification.create({
            propertyId: p._id,
            reservationId: r._id,
            type: NotificationType.CHECKIN_REMINDER,
            channel: NotificationChannel.EMAIL,
            recipient: r.guest.email,
            subject: `See you tomorrow at ${p.name}`,
            message: `Your check-in for ${r.reservationCode} is on ${formatDateOnly(tomorrow)} from ${p.checkInTime}.`,
            dedupeKey: `checkin-reminder:${r._id}`,
          });
          sent++;
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
        }
      }
    }
    if (sent) void this.outbox.flush();
    return sent;
  }

  /** Safety net for lost webhooks: poll each connected channel for recent reservations. */
  async queueReservationPulls() {
    const bucket = Math.floor(Date.now() / (15 * 60_000));
    const available = new Set(this.channels.list().filter((a) => a.isAvailable()).map((a) => a.channel));
    const conns = await this.m.ChannelConnection.find({ status: ChannelConnectionStatus.CONNECTED }, { channel: 1 }).lean();
    for (const c of conns.filter((x) => available.has(x.channel))) {
      await this.producer.enqueue(QUEUES.RESERVATION_SYNC, 'pull', { kind: 'PULL', connectionId: String(c._id) }, { jobId: `pull-${c._id}-${bucket}` });
    }
  }
}

@Module({ imports: [ChannelsModule], providers: [SchedulerService], exports: [SchedulerService] })
export class SchedulerModule {}
