import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { WebhookService } from '../../database/services/webhook.service';
import { JobContext, JobHandler, JobHandlerRegistry } from '../../jobs/job-handler';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { QUEUES } from '../../jobs/queues';
import { ChannelsModule } from '../channels/channels.module';
import { SyncService } from './sync.service';

/** inventory-sync queue: availability and restriction pushes. */
@Injectable()
export class InventorySyncHandler implements JobHandler<'inventory-sync'>, OnModuleInit {
  readonly queue = QUEUES.INVENTORY_SYNC;
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly sync: SyncService,
  ) {}
  onModuleInit() {
    this.registry.register(this);
  }
  handle(ctx: JobContext<'inventory-sync'>) {
    return this.sync.run(ctx, ctx.data.syncJobId);
  }
}

/** rate-sync queue: price pushes. */
@Injectable()
export class RateSyncHandler implements JobHandler<'rate-sync'>, OnModuleInit {
  readonly queue = QUEUES.RATE_SYNC;
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly sync: SyncService,
  ) {}
  onModuleInit() {
    this.registry.register(this);
  }
  handle(ctx: JobContext<'rate-sync'>) {
    return this.sync.run(ctx, ctx.data.syncJobId);
  }
}

/**
 * reservation-sync queue: reservation/listing sync jobs, acknowledgements of
 * imported OTA bookings, and periodic reservation pulls (safety net for missed webhooks).
 */
@Injectable()
export class ReservationSyncHandler implements JobHandler<'reservation-sync'>, OnModuleInit {
  readonly queue = QUEUES.RESERVATION_SYNC;
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly sync: SyncService,
    private readonly webhooks: WebhookService,
    private readonly outbox: OutboxDispatcher,
  ) {}
  onModuleInit() {
    this.registry.register(this);
  }
  async handle(ctx: JobContext<'reservation-sync'>) {
    const d = ctx.data;
    switch (d.kind) {
      case 'SYNC_JOB':
        return this.sync.run(ctx, d.syncJobId);
      case 'ACKNOWLEDGE':
        return this.sync.acknowledge(d.propertyId, d.channel, d.externalReservationId, ctx);
      case 'PULL':
        return this.sync.pullReservations(d.connectionId, async (channel, events) => {
          let fresh = 0;
          for (const e of events) {
            // Same inbox and idempotency as pushed webhooks. The event id encodes the booking's state (the provider's own revision when it has one).
            const res = await this.webhooks.ingest({
              channel,
              externalScope: e.externalScope,
              eventType: `poll.${e.kind.toLowerCase()}`,
              externalEventId: `poll:${e.externalReservationId}:${e.kind}:${e.revision ?? `${e.checkIn}:${e.checkOut}`}`,
              payload: { polled: true, reservation: e },
              signatureValid: true,
            });
            if (!res.duplicate) fresh++;
          }
          if (fresh) void this.outbox.flush();
          return fresh;
        });
    }
  }
}

@Module({
  imports: [ChannelsModule],
  providers: [SyncService, InventorySyncHandler, RateSyncHandler, ReservationSyncHandler],
  exports: [SyncService],
})
export class SyncModule {}
