import { Inject, Logger, Type } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { JobContext, JobHandlerRegistry } from './job-handler';
import { ALL_QUEUES, QUEUE_OPTIONS, QueueName } from './queues';

/**
 * One BullMQ worker class per queue, each delegating to the transport-neutral
 * JobHandler registered for that queue. Only instantiated when
 * WORKERS_ENABLED=true, so API-only instances do not consume jobs.
 */
function makeProcessor(queue: QueueName): Type<WorkerHost> {
  @Processor(queue, { concurrency: QUEUE_OPTIONS[queue].concurrency })
  class QueueProcessor extends WorkerHost {
    private readonly logger = new Logger(`queue:${queue}`);

    constructor(@Inject(JobHandlerRegistry) private readonly registry: JobHandlerRegistry) {
      super();
    }

    async process(job: Job): Promise<unknown> {
      const ctx: JobContext = {
        id: String(job.id),
        name: job.name,
        data: job.data,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
      };
      return this.registry.get(queue).handle(ctx);
    }

    @OnWorkerEvent('failed')
    onFailed(job: Job | undefined, err: Error): void {
      if (!job) return;
      const final = job.attemptsMade >= (job.opts.attempts ?? 1) || err.name === 'UnrecoverableError';
      // Structured so a log-based alert can count event=queue_job_failed,final=true per queue.
      const entry = { event: 'queue_job_failed', queue, job: job.name, jobId: String(job.id), attempt: job.attemptsMade, attempts: job.opts.attempts, final, error: err.message.slice(0, 300) };
      if (final) this.logger.error(entry);
      else this.logger.warn(entry);
    }

    @OnWorkerEvent('error')
    onError(err: Error): void {
      this.logger.error({ event: 'queue_worker_error', queue, error: err.message.slice(0, 300) });
    }
  }
  Object.defineProperty(QueueProcessor, 'name', { value: `${queue.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase())}Processor` });
  return QueueProcessor;
}

export const QUEUE_PROCESSORS: Type<WorkerHost>[] = ALL_QUEUES.map(makeProcessor);
