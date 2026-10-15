import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { JobContext, JobHandlerRegistry } from './job-handler';
import { ALL_QUEUES, JobPayloads, QUEUE_OPTIONS, QUEUES, QueueName } from './queues';

export interface EnqueueOptions {
  /** Deduplicates: while a job with this id exists, adding another is a no-op. */
  jobId?: string;
  delayMs?: number;
}

export interface QueueStats {
  queue: QueueName;
  counts: Record<string, number>;
}

export interface FailedJobInfo {
  id: string;
  name: string;
  data: unknown;
  attemptsMade: number;
  failedReason: string;
  finishedOn?: number;
}

export const BACKOFF_OVERRIDE_MS = Symbol('BACKOFF_OVERRIDE_MS');

/** Transport-neutral producer. Feature modules depend on this, never on BullMQ directly. */
export abstract class JobsProducer {
  abstract enqueue<Q extends QueueName>(queue: Q, name: string, data: JobPayloads[Q], opts?: EnqueueOptions): Promise<void>;
  abstract stats(): Promise<QueueStats[]>;
  abstract failed(queue: QueueName, limit?: number): Promise<FailedJobInfo[]>;
}

// ------------------------------------------------------------------ BullMQ (production)

@Injectable()
export class BullMqJobsProducer extends JobsProducer {
  private readonly queues: Record<QueueName, Queue>;

  constructor(
    @InjectQueue(QUEUES.WEBHOOK) webhook: Queue,
    @InjectQueue(QUEUES.INVENTORY_SYNC) inventory: Queue,
    @InjectQueue(QUEUES.RATE_SYNC) rate: Queue,
    @InjectQueue(QUEUES.RESERVATION_SYNC) reservation: Queue,
    @InjectQueue(QUEUES.NOTIFICATION) notification: Queue,
    @InjectQueue(QUEUES.PAYMENT) payment: Queue,
    @InjectQueue(QUEUES.CLIENT_WEBHOOK) clientWebhook: Queue,
    @Inject(BACKOFF_OVERRIDE_MS) private readonly backoffOverrideMs: number,
  ) {
    super();
    this.queues = {
      'webhook-processing': webhook,
      'inventory-sync': inventory,
      'rate-sync': rate,
      'reservation-sync': reservation,
      notification,
      payment,
      'client-webhook': clientWebhook,
    };
  }

  async enqueue<Q extends QueueName>(queue: Q, name: string, data: JobPayloads[Q], opts: EnqueueOptions = {}): Promise<void> {
    const o = QUEUE_OPTIONS[queue];
    await this.queues[queue].add(name, data, {
      jobId: opts.jobId,
      delay: opts.delayMs,
      attempts: o.attempts,
      backoff: this.backoffOverrideMs > 0 ? { type: 'fixed', delay: this.backoffOverrideMs } : { type: 'exponential', delay: o.backoffMs },
      removeOnComplete: { age: 24 * 3600, count: 10_000 },
      removeOnFail: { age: 14 * 24 * 3600 },
    });
  }

  async stats(): Promise<QueueStats[]> {
    return Promise.all(
      ALL_QUEUES.map(async (queue) => ({
        queue,
        counts: await this.queues[queue].getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
      })),
    );
  }

  async failed(queue: QueueName, limit = 50): Promise<FailedJobInfo[]> {
    const jobs = await this.queues[queue].getFailed(0, limit - 1);
    return jobs.map((j) => ({
      id: String(j.id),
      name: j.name,
      data: j.data,
      attemptsMade: j.attemptsMade,
      failedReason: j.failedReason,
      finishedOn: j.finishedOn,
    }));
  }
}

// ------------------------------------------------------------------ Inline (tests, local dev without Redis)

/**
 * Runs jobs in-process with the same retry semantics (attempt counting,
 * non-retryable errors, jobId dedup) but no delay between attempts. Tests call
 * drain() to wait until every job (and every job those jobs enqueue) is done.
 */
@Injectable()
export class InlineJobsProducer extends JobsProducer implements OnModuleDestroy {
  private readonly logger = new Logger('InlineJobs');
  private readonly inFlight = new Set<Promise<void>>();
  private readonly seenIds = new Set<string>();
  private readonly counts = new Map<QueueName, Record<string, number>>();
  private readonly failures = new Map<QueueName, FailedJobInfo[]>();
  private seq = 0;
  private stopped = false;

  constructor(private readonly registry: JobHandlerRegistry) {
    super();
  }

  async enqueue<Q extends QueueName>(queue: Q, name: string, data: JobPayloads[Q], opts: EnqueueOptions = {}): Promise<void> {
    if (this.stopped) return;
    if (opts.jobId) {
      if (this.seenIds.has(opts.jobId)) return;
      this.seenIds.add(opts.jobId);
    }
    const id = opts.jobId ?? `inline-${++this.seq}`;
    this.bump(queue, 'waiting');
    const p = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.run(queue, id, name, data));
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  private async run(queue: QueueName, id: string, name: string, data: unknown): Promise<void> {
    const maxAttempts = QUEUE_OPTIONS[queue].attempts;
    this.bump(queue, 'waiting', -1);
    for (let attemptsMade = 0; attemptsMade < maxAttempts && !this.stopped; attemptsMade++) {
      const ctx = { id, name, data, attemptsMade, maxAttempts } as JobContext;
      try {
        await this.registry.get(queue).handle(ctx);
        this.bump(queue, 'completed');
        return;
      } catch (err) {
        const final = err instanceof UnrecoverableError || attemptsMade + 1 >= maxAttempts;
        if (final) {
          this.bump(queue, 'failed');
          const list = this.failures.get(queue) ?? [];
          list.push({ id, name, data, attemptsMade: attemptsMade + 1, failedReason: (err as Error).message, finishedOn: Date.now() });
          this.failures.set(queue, list);
          this.logger.debug(`${queue}/${name} ${id} failed permanently: ${(err as Error).message}`);
          return;
        }
      }
    }
  }

  /** Resolves when no job is queued or running. */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  async stats(): Promise<QueueStats[]> {
    return ALL_QUEUES.map((queue) => ({ queue, counts: { ...(this.counts.get(queue) ?? {}) } }));
  }

  async failed(queue: QueueName, limit = 50): Promise<FailedJobInfo[]> {
    return (this.failures.get(queue) ?? []).slice(-limit);
  }

  async onModuleDestroy(): Promise<void> {
    await this.drain();
    this.stopped = true;
  }

  private bump(queue: QueueName, key: string, by = 1) {
    const c = this.counts.get(queue) ?? {};
    c[key] = (c[key] ?? 0) + by;
    this.counts.set(queue, c);
  }
}
