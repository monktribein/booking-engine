import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { NotificationStatus, RefundStatus, SyncJobStatus, WebhookDeliveryStatus, WebhookEventStatus } from '../database/enums';
import { Db, InjectDb } from '../database/kysely';
import { JobsProducer } from './jobs.producer';
import { QUEUES, QueueName, queueForSyncType } from './queues';

const BATCH = 200;
/** Rows handed to the queue but still unprocessed after this long are handed over again. */
const STALE_MS = 5 * 60_000;

type OutboxTable = 'syncJobs' | 'notifications' | 'refunds' | 'webhookEvents' | 'webhookDeliveries';

/**
 * Transactional outbox → queue.
 *
 * Business transactions only write rows (sync_jobs, notifications, refunds, webhook_events, webhook_deliveries). After
 * commit, services call flush(), and a timer calls relay(). Both claim rows with a conditional `enqueued_at` update
 * (FOR UPDATE SKIP LOCKED, so parallel dispatchers never take the same row) and add a queue job. A crash between commit
 * and enqueue therefore delays work but never loses it. Double delivery is harmless: every worker leases its row
 * (claimById / status checks) before acting.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly producer: JobsProducer,
  ) {}

  /** Fire-and-forget after a commit. Concurrent calls coalesce into one extra pass. */
  flush(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.dispatchAll(false).catch((err) => this.logger.error(`flush failed: ${(err as Error).message}`));
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Periodic recovery pass: also re-dispatches rows whose queue job was lost. */
  async relay(): Promise<void> {
    await this.dispatchAll(true);
  }

  private async dispatchAll(includeStale: boolean): Promise<void> {
    await this.dispatchSyncJobs(includeStale);
    await this.dispatchNotifications(includeStale);
    await this.dispatchRefunds(includeStale);
    await this.dispatchWebhooks(includeStale);
    await this.dispatchClientWebhooks(includeStale);
  }

  /**
   * Claims one due row: stamps `enqueued_at = now()` on the oldest row matching `due` that is unclaimed (or, in a relay
   * pass, claimed long ago). Returns its id and the stamp, or null when nothing is due.
   */
  private async claimOne(table: OutboxTable, due: ReturnType<typeof sql>, orderBy: string, includeStale: boolean): Promise<{ id: string; stamp: number; channel?: string; type?: string } | null> {
    const staleCut = new Date(Date.now() - STALE_MS);
    const unclaimed = includeStale ? sql`(enqueued_at is null or enqueued_at < ${staleCut})` : sql`enqueued_at is null`;
    const rows = await sql<{ id: string; enqueuedAt: Date; channel?: string; type?: string }>`
      update ${sql.table(toSnake(table))} set enqueued_at = now()
      where id = (select id from ${sql.table(toSnake(table))} where ${due} and ${unclaimed} order by ${sql.ref(orderBy)} limit 1 for update skip locked)
      returning id, enqueued_at${table === 'syncJobs' ? sql`, type, channel` : sql``}${table === 'webhookEvents' ? sql`, channel` : sql``}`.execute(this.db);
    const row = rows.rows[0];
    return row ? { id: row.id, stamp: new Date(row.enqueuedAt).getTime(), channel: row.channel, type: row.type } : null;
  }

  private async unclaim(table: OutboxTable, id: string) {
    await sql`update ${sql.table(toSnake(table))} set enqueued_at = null where id = ${id}::uuid`.execute(this.db);
  }

  private async claimLoop(table: OutboxTable, due: ReturnType<typeof sql>, orderBy: string, includeStale: boolean, send: (row: { id: string; stamp: number; channel?: string; type?: string }) => Promise<void>) {
    for (let i = 0; i < BATCH; i++) {
      const row = await this.claimOne(table, due, orderBy, includeStale);
      if (!row) return;
      try {
        // The job id includes the claim time, so a re-dispatch of a lost job is not swallowed by BullMQ's dedup, while a
        // single dispatch is never duplicated.
        await send(row);
      } catch (err) {
        await this.unclaim(table, row.id);
        throw err;
      }
    }
  }

  private dispatchSyncJobs(includeStale: boolean) {
    return this.claimLoop(
      'syncJobs',
      sql`status in (${sql.join([SyncJobStatus.PENDING, SyncJobStatus.RETRYING])}) and scheduled_at <= now()`,
      'scheduled_at',
      includeStale,
      async (job) => {
        const queue = queueForSyncType(job.type as never);
        if (queue === QUEUES.RESERVATION_SYNC) {
          await this.producer.enqueue(queue, 'sync', { kind: 'SYNC_JOB', syncJobId: job.id }, { jobId: `sync-${job.id}-${job.stamp}` });
        } else {
          await this.producer.enqueue(queue as 'inventory-sync', 'sync', { syncJobId: job.id }, { jobId: `sync-${job.id}-${job.stamp}` });
        }
      },
    );
  }

  private dispatchNotifications(includeStale: boolean) {
    return this.claimLoop('notifications', sql`status = ${NotificationStatus.QUEUED}`, 'created_at', includeStale, (n) =>
      this.producer.enqueue(QUEUES.NOTIFICATION, 'send', { notificationId: n.id }, { jobId: `ntf-${n.id}-${n.stamp}` }),
    );
  }

  private dispatchRefunds(includeStale: boolean) {
    return this.claimLoop('refunds', sql`status = ${RefundStatus.PENDING}`, 'created_at', includeStale, (r) =>
      this.producer.enqueue(QUEUES.PAYMENT, 'refund', { kind: 'REFUND', refundId: r.id }, { jobId: `refund-${r.id}-${r.stamp}` }),
    );
  }

  private dispatchWebhooks(includeStale: boolean) {
    return this.claimLoop('webhookEvents', sql`status = ${WebhookEventStatus.RECEIVED}`, 'created_at', includeStale, (ev) => this.enqueueWebhook(ev.id, ev.channel as string, ev.stamp));
  }

  /** Outbound customer webhooks (api events). */
  private dispatchClientWebhooks(includeStale: boolean) {
    return this.claimLoop('webhookDeliveries', sql`status in (${sql.join([WebhookDeliveryStatus.PENDING, WebhookDeliveryStatus.RETRYING])})`, 'created_at', includeStale, (dl) =>
      this.producer.enqueue(QUEUES.CLIENT_WEBHOOK, 'deliver', { deliveryId: dl.id }, { jobId: `cwh-${dl.id}-${dl.stamp}` }),
    );
  }

  /** Payment-provider events go to the payment queue; OTA events to webhook-processing. */
  async enqueueWebhook(eventId: string, source: string, stamp = Date.now()): Promise<void> {
    const queue: QueueName = source === 'RAZORPAY' ? QUEUES.PAYMENT : QUEUES.WEBHOOK;
    if (queue === QUEUES.PAYMENT) {
      await this.producer.enqueue(QUEUES.PAYMENT, 'webhook', { kind: 'WEBHOOK', webhookEventId: eventId }, { jobId: `wh-${eventId}-${stamp}` });
    } else {
      await this.producer.enqueue(QUEUES.WEBHOOK, 'process', { webhookEventId: eventId }, { jobId: `wh-${eventId}-${stamp}` });
    }
  }
}

const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
