import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { NotificationStatus, RefundStatus, SyncJobStatus, WebhookDeliveryStatus, WebhookEventStatus } from '../database/enums';
import { Models, getModels } from '../database/models';
import { JobsProducer } from './jobs.producer';
import { QUEUES, QueueName, queueForSyncType } from './queues';

const BATCH = 200;
/** Rows handed to the queue but still unprocessed after this long are handed over again. */
const STALE_MS = 5 * 60_000;

/**
 * Transactional outbox → queue.
 *
 * Business transactions only write rows (sync_jobs, notifications, refunds,
 * webhook_events). After commit, services call flush(), and a timer calls
 * relay(). Both claim rows with a conditional `enqueuedAt` update and add a
 * queue job. A crash between commit and enqueue therefore delays work but
 * never loses it. Double delivery is harmless: every worker leases its row
 * (claimById / status checks) before acting.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private readonly m: Models;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly producer: JobsProducer,
  ) {
    this.m = getModels(connection);
  }

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

  private staleFilter(includeStale: boolean) {
    return includeStale ? { $or: [{ enqueuedAt: null }, { enqueuedAt: { $lt: new Date(Date.now() - STALE_MS) } }] } : { enqueuedAt: null };
  }

  /** Claim one row at a time, so parallel dispatchers never both hand over the same row in one pass. */
  private async claimLoop<T extends { _id: Types.ObjectId }>(
    claim: () => Promise<(T & { enqueuedAt: Date | null }) | null>,
    send: (row: T, stamp: number) => Promise<void>,
    unclaim: (id: Types.ObjectId) => Promise<unknown>,
  ): Promise<void> {
    for (let i = 0; i < BATCH; i++) {
      const row = await claim();
      if (!row) return;
      try {
        // The job id includes the claim time, so a re-dispatch of a lost job is not swallowed by
        // BullMQ's dedup, while a single dispatch is never duplicated.
        await send(row, row.enqueuedAt?.getTime() ?? Date.now());
      } catch (err) {
        await unclaim(row._id);
        throw err;
      }
    }
  }

  private async dispatchSyncJobs(includeStale: boolean) {
    await this.claimLoop(
      () =>
        this.m.SyncJob.findOneAndUpdate(
          { status: { $in: [SyncJobStatus.PENDING, SyncJobStatus.RETRYING] }, scheduledAt: { $lte: new Date() }, ...this.staleFilter(includeStale) },
          { $set: { enqueuedAt: new Date() } },
          { sort: { scheduledAt: 1 }, new: true },
        ).lean(),
      async (job, stamp) => {
        const queue = queueForSyncType(job.type);
        const id = String(job._id);
        if (queue === QUEUES.RESERVATION_SYNC) {
          await this.producer.enqueue(queue, 'sync', { kind: 'SYNC_JOB', syncJobId: id }, { jobId: `sync-${id}-${stamp}` });
        } else {
          await this.producer.enqueue(queue as 'inventory-sync', 'sync', { syncJobId: id }, { jobId: `sync-${id}-${stamp}` });
        }
      },
      (id) => this.m.SyncJob.updateOne({ _id: id }, { $set: { enqueuedAt: null } }),
    );
  }

  private async dispatchNotifications(includeStale: boolean) {
    await this.claimLoop(
      () =>
        this.m.Notification.findOneAndUpdate(
          { status: NotificationStatus.QUEUED, ...this.staleFilter(includeStale) },
          { $set: { enqueuedAt: new Date() } },
          { sort: { createdAt: 1 }, new: true },
        ).lean(),
      (n, stamp) => this.producer.enqueue(QUEUES.NOTIFICATION, 'send', { notificationId: String(n._id) }, { jobId: `ntf-${n._id}-${stamp}` }),
      (id) => this.m.Notification.updateOne({ _id: id }, { $set: { enqueuedAt: null } }),
    );
  }

  private async dispatchRefunds(includeStale: boolean) {
    await this.claimLoop(
      () =>
        this.m.Refund.findOneAndUpdate(
          { status: RefundStatus.PENDING, ...this.staleFilter(includeStale) },
          { $set: { enqueuedAt: new Date() } },
          { sort: { createdAt: 1 }, new: true },
        ).lean(),
      (r, stamp) => this.producer.enqueue(QUEUES.PAYMENT, 'refund', { kind: 'REFUND', refundId: String(r._id) }, { jobId: `refund-${r._id}-${stamp}` }),
      (id) => this.m.Refund.updateOne({ _id: id }, { $set: { enqueuedAt: null } }),
    );
  }

  /** Outbound customer webhooks (api events). */
  private async dispatchClientWebhooks(includeStale: boolean) {
    await this.claimLoop(
      () =>
        this.m.WebhookDelivery.findOneAndUpdate(
          { status: { $in: [WebhookDeliveryStatus.PENDING, WebhookDeliveryStatus.RETRYING] }, ...this.staleFilter(includeStale) },
          { $set: { enqueuedAt: new Date() } },
          { sort: { createdAt: 1 }, new: true },
        ).lean(),
      (d, stamp) => this.producer.enqueue(QUEUES.CLIENT_WEBHOOK, 'deliver', { deliveryId: String(d._id) }, { jobId: `cwh-${d._id}-${stamp}` }),
      (id) => this.m.WebhookDelivery.updateOne({ _id: id }, { $set: { enqueuedAt: null } }),
    );
  }

  private async dispatchWebhooks(includeStale: boolean) {
    await this.claimLoop(
      () =>
        this.m.WebhookEvent.findOneAndUpdate(
          { status: WebhookEventStatus.RECEIVED, ...this.staleFilter(includeStale) },
          { $set: { enqueuedAt: new Date() } },
          { sort: { createdAt: 1 }, new: true },
        ).lean(),
      (ev, stamp) => this.enqueueWebhook(ev._id, ev.channel, stamp),
      (id) => this.m.WebhookEvent.updateOne({ _id: id }, { $set: { enqueuedAt: null } }),
    );
  }

  /** Payment-provider events go to the payment queue; OTA events to webhook-processing. */
  async enqueueWebhook(eventId: Types.ObjectId, source: string, stamp = Date.now()): Promise<void> {
    const id = String(eventId);
    const queue: QueueName = source === 'RAZORPAY' ? QUEUES.PAYMENT : QUEUES.WEBHOOK;
    if (queue === QUEUES.PAYMENT) {
      await this.producer.enqueue(QUEUES.PAYMENT, 'webhook', { kind: 'WEBHOOK', webhookEventId: id }, { jobId: `wh-${id}-${stamp}` });
    } else {
      await this.producer.enqueue(QUEUES.WEBHOOK, 'process', { webhookEventId: id }, { jobId: `wh-${id}-${stamp}` });
    }
  }
}
