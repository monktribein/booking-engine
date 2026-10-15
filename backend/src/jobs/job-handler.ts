import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { DomainError } from '../database/errors';
import type { JobPayloads, QueueName } from './queues';

export interface JobContext<Q extends QueueName = QueueName> {
  id: string;
  name: string;
  data: JobPayloads[Q];
  /** Attempts already made before this one (0 on the first run). */
  attemptsMade: number;
  maxAttempts: number;
}

export const isFinalAttempt = (ctx: JobContext) => ctx.attemptsMade + 1 >= ctx.maxAttempts;

/**
 * Business logic for one queue, independent of the transport (BullMQ in
 * production, inline in tests). Throw to request a retry; throw
 * `nonRetryable(err)` to fail immediately.
 */
export interface JobHandler<Q extends QueueName = QueueName> {
  readonly queue: Q;
  handle(ctx: JobContext<Q>): Promise<unknown>;
}

/** Errors that retrying cannot fix: validation, state conflicts, missing partner access. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof UnrecoverableError) return false;
  if (err instanceof DomainError) {
    const retryable = (err as DomainError & { retryable?: boolean }).retryable;
    if (typeof retryable === 'boolean') return retryable;
    // Missing mappings can be fixed by staff while retries continue; data errors cannot.
    return ['CHANNEL_MAPPING_MISSING', 'INVENTORY_INVARIANT'].includes(err.code);
  }
  return true; // network errors, timeouts, write conflicts that escaped the driver
}

export function nonRetryable(err: unknown): UnrecoverableError {
  const e = new UnrecoverableError(err instanceof Error ? err.message : String(err));
  (e as Error & { cause?: unknown }).cause = err;
  return e;
}

@Injectable()
export class JobHandlerRegistry {
  private readonly handlers = new Map<QueueName, JobHandler>();

  register(handler: JobHandler): void {
    if (this.handlers.has(handler.queue)) throw new Error(`A handler for ${handler.queue} is already registered`);
    this.handlers.set(handler.queue, handler);
  }

  get(queue: QueueName): JobHandler {
    const h = this.handlers.get(queue);
    if (!h) throw new Error(`No handler registered for queue ${queue}`);
    return h;
  }
}
