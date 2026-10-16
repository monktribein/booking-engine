import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChannelConnectionStatus } from '../../database/enums';
import { NotFoundError, UnauthorizedError } from '../../database/errors';
import { Db, InjectDb } from '../../database/kysely';
import { NormalizedReservationEvent, WebhookService } from '../../database/services/webhook.service';
import { JobContext, JobHandler, JobHandlerRegistry, isFinalAttempt, isRetryable, nonRetryable } from '../../jobs/job-handler';
import { JobsProducer } from '../../jobs/jobs.producer';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { QUEUES } from '../../jobs/queues';
import { ChannelAdapterRegistry } from '../channels/channel-registry';
import type { InboundWebhookRequest, ParsedWebhook } from '../channels/interfaces/channel-adapter.interface';

export interface WebhookReceipt {
  received: true;
  duplicate: boolean;
  eventId: string;
}

/**
 * HTTP side of the webhook pipeline. It does only cheap, bounded work:
 * verify the signature → store the raw event (unique channel+eventId) →
 * enqueue → return. All booking logic runs later in WebhookJobHandler.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly registry: ChannelAdapterRegistry,
    private readonly store: WebhookService,
    private readonly outbox: OutboxDispatcher,
  ) {}

  /**
   * Inbound webhook of a configured provider, addressed to ONE connection by its random key. The signature is checked with that
   * connection's own secret, the event id is deduplicated within the connection, and nothing about the connection is revealed to a
   * caller who does not hold a valid signature (an unknown key and a wrong signature are both refused without detail).
   */
  async receiveForConnection(webhookKey: string, req: InboundWebhookRequest): Promise<WebhookReceipt> {
    const resolved = await this.registry.forWebhookKey(webhookKey).catch(() => null);
    if (!resolved || resolved.connection.status !== ChannelConnectionStatus.CONNECTED) throw new NotFoundError('Webhook endpoint', 'unknown');
    const { adapter, connection } = resolved;
    const signatureValid = adapter.verifyWebhook(req);
    let parsed: ParsedWebhook | null = null;
    if (signatureValid) {
      try {
        parsed = adapter.parseWebhook(req.body);
      } catch {
        parsed = null; // authentic but unparseable: stored as IGNORED for investigation
      }
    }
    const { event, duplicate } = await this.store.ingest({
      channel: connection.channel,
      externalScope: connection.id,
      eventType: parsed?.eventType ?? 'unknown',
      externalEventId: parsed?.externalEventId,
      // Only the normalised reservation is kept (not the raw body), and nothing at all of an unauthenticated delivery.
      payload: signatureValid && parsed?.reservation ? { normalized: true, connectionId: connection.id, reservation: parsed.reservation } : { normalized: false },
      rawBody: req.rawBody,
      signature: undefined,
      signatureValid: signatureValid && parsed !== null,
      propertyId: connection.propertyId,
    });
    if (!signatureValid) throw new UnauthorizedError('Webhook signature verification failed', 'INVALID_SIGNATURE');
    if (!duplicate && parsed?.reservation) {
      await this.store.markEnqueued(event.id);
      await this.outbox.enqueueWebhook(event.id, connection.channel, event.enqueuedAt?.getTime() ?? Date.now());
    } else if (!duplicate && parsed) {
      await this.store.markIgnored(event.id, `No handler for event type ${parsed.eventType}`);
    }
    return { received: true, duplicate, eventId: event.id };
  }

  async receive(channel: string, req: InboundWebhookRequest): Promise<WebhookReceipt> {
    const adapter = this.registry.get(channel);
    const signatureValid = adapter.verifyWebhook(req);
    let parsed: ParsedWebhook | null = null;
    if (signatureValid) {
      try {
        parsed = adapter.parseWebhook(req.body);
      } catch {
        parsed = null; // authentic but unparseable: stored as IGNORED for investigation
      }
    }
    const header = req.headers['x-mock-signature'] ?? req.headers['x-signature'];
    const { event, duplicate } = await this.store.ingest({
      channel: adapter.channel,
      eventType: parsed?.eventType ?? 'unknown',
      externalEventId: parsed?.externalEventId,
      payload: typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : { raw: String(req.body ?? '') },
      rawBody: req.rawBody,
      signature: Array.isArray(header) ? header[0] : header,
      signatureValid: signatureValid && parsed !== null,
    });
    // Stored first (forensics), rejected second.
    if (!signatureValid) throw new UnauthorizedError('Webhook signature verification failed', 'INVALID_SIGNATURE');
    if (!duplicate && parsed) {
      await this.store.markEnqueued(event.id);
      await this.outbox.enqueueWebhook(event.id, adapter.channel, event.enqueuedAt?.getTime() ?? Date.now());
    }
    return { received: true, duplicate, eventId: event.id };
  }
}

/**
 * webhook-processing queue. Parses the stored event, then creates, modifies
 * or cancels the reservation (inventory changes inside the reservation
 * transaction). It then acknowledges the booking to the channel and flushes
 * the outbox so every OTHER channel receives the new availability.
 */
@Injectable()
export class WebhookJobHandler implements JobHandler<'webhook-processing'>, OnModuleInit {
  readonly queue = QUEUES.WEBHOOK;
  private readonly logger = new Logger('WebhookWorker');
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly registry: JobHandlerRegistry,
    private readonly adapters: ChannelAdapterRegistry,
    private readonly store: WebhookService,
    private readonly producer: JobsProducer,
    private readonly outbox: OutboxDispatcher,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async handle(ctx: JobContext<'webhook-processing'>) {
    const id = ctx.data.webhookEventId;
    const event = await this.store.claimById(id);
    if (!event) return { status: 'SKIPPED_ALREADY_HANDLED' };
    try {
      // Polled and connection-addressed (configured provider) events are stored already normalised; built-in channels store the raw body.
      const payload = event.payload as { polled?: boolean; normalized?: boolean; reservation?: NormalizedReservationEvent };
      const reservation = payload.polled || payload.normalized ? payload.reservation : this.adapters.get(event.channel).parseWebhook(event.payload).reservation;
      if (!reservation) {
        await this.store.markIgnored(id, `No handler for event type ${event.eventType}`);
        return { status: 'IGNORED' };
      }
      const outcome = await this.store.applyReservationEvent(reservation);
      await this.store.markProcessed(id, outcome.propertyId);
      if (outcome.action === 'CREATED' || outcome.action === 'MODIFIED') {
        await this.producer.enqueue(
          QUEUES.RESERVATION_SYNC,
          'acknowledge',
          { kind: 'ACKNOWLEDGE', propertyId: outcome.propertyId, channel: event.channel, externalReservationId: reservation.externalReservationId },
          { jobId: `ack-${event.channel}-${reservation.externalScope ?? 'global'}-${reservation.externalReservationId}-${outcome.action}`.replace(/[^A-Za-z0-9_-]/g, '_') },
        );
      }
      void this.outbox.flush();
      return { status: 'PROCESSED', ...outcome };
    } catch (err) {
      const final = !isRetryable(err) || isFinalAttempt(ctx);
      const message = err instanceof Error ? err.message : String(err);
      await this.store.markFailed(id, message, final);
      this.logger.warn(`webhook ${id} (${event.channel}/${event.eventType}) failed${final ? ' permanently' : ''}: ${message}`);
      throw final ? nonRetryable(err) : err;
    }
  }

  /** For admin retry of a FAILED event: back to RECEIVED and re-enqueued with a fresh job id. */
  async retry(eventId: string): Promise<void> {
    const ev = await this.db
      .updateTable('webhookEvents')
      .set({ status: 'RECEIVED', attempts: 0, lockedUntil: null, enqueuedAt: new Date() })
      .where('id', '=', eventId)
      .returning('channel')
      .executeTakeFirst();
    if (ev) await this.outbox.enqueueWebhook(eventId, ev.channel);
  }
}
