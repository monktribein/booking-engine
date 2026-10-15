import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_PROCESSORS } from './bullmq.processors';
import { JobHandlerRegistry } from './job-handler';
import { BACKOFF_OVERRIDE_MS, BullMqJobsProducer, InlineJobsProducer, JobsProducer } from './jobs.producer';
import { OutboxDispatcher } from './outbox.dispatcher';
import { ALL_QUEUES } from './queues';

export interface JobsModuleOptions {
  driver: 'bullmq' | 'inline';
  redisUrl: string | null;
  workersEnabled: boolean;
  /** Redis key prefix for all queues (default 'tirvona'). */
  prefix?: string;
  /** Tests only: fixed retry delay in ms instead of the exponential backoff (0 = off). */
  backoffOverrideMs?: number;
}

/**
 * Queue infrastructure. With driver=bullmq, jobs go to Redis and (if
 * workersEnabled) this process also runs the workers. With driver=inline,
 * jobs run in-process (tests, Redis-less local dev). Feature modules only see
 * JobsProducer, JobHandlerRegistry and OutboxDispatcher.
 */
@Global()
@Module({})
export class JobsModule {
  static forRoot(opts: JobsModuleOptions): DynamicModule {
    const common: Provider[] = [JobHandlerRegistry, OutboxDispatcher];
    if (opts.driver === 'inline') {
      return {
        module: JobsModule,
        providers: [...common, InlineJobsProducer, { provide: JobsProducer, useExisting: InlineJobsProducer }],
        exports: [...common, JobsProducer, InlineJobsProducer],
      };
    }
    if (!opts.redisUrl) throw new Error('REDIS_URL is required for the bullmq queue driver');
    return {
      module: JobsModule,
      imports: [
        BullModule.forRoot({ connection: { url: opts.redisUrl, maxRetriesPerRequest: null }, prefix: opts.prefix ?? 'tirvona' }),
        BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
      ],
      providers: [
        ...common,
        { provide: BACKOFF_OVERRIDE_MS, useValue: opts.backoffOverrideMs ?? 0 },
        BullMqJobsProducer,
        { provide: JobsProducer, useExisting: BullMqJobsProducer },
        ...(opts.workersEnabled ? QUEUE_PROCESSORS : []),
      ],
      exports: [...common, JobsProducer],
    };
  }
}
