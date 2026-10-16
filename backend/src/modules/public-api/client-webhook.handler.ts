import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { decryptSecret } from '../../database/common/crypto';
import { WebhookDeliveryStatus, WebhookEndpointStatus } from '../../database/enums';
import { Db, InjectDb } from '../../database/kysely';
import { sql } from 'kysely';
import { JobContext, JobHandler, JobHandlerRegistry, isFinalAttempt, nonRetryable } from '../../jobs/job-handler';
import { QUEUES } from '../../jobs/queues';
import { postWebhook, validateWebhookUrl } from './safe-http';
import { signatureHeader } from './webhook-signature';

/** While BullMQ owns a retry, the outbox relay must not hand the row over again. */
const RETRY_OWNED_BY_QUEUE_MS = 12 * 3_600_000;

/**
 * Delivers one event to one customer endpoint. At-least-once: the same event id and byte-identical body are
 * sent on every attempt, so receivers deduplicate on the `Tirvona-Event-Id` header. 2xx = delivered; anything
 * else (non-2xx, timeout, DNS or TLS failure, blocked address) is retried with exponential backoff up to the
 * queue's attempt limit, after which the delivery is FAILED and can be redelivered manually.
 */
@Injectable()
export class ClientWebhookJobHandler implements JobHandler<'client-webhook'>, OnModuleInit {
  readonly queue = QUEUES.CLIENT_WEBHOOK;
  private readonly logger = new Logger('ClientWebhook');
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly registry: JobHandlerRegistry,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async handle(ctx: JobContext<'client-webhook'>) {
    const now = new Date();
    // Lease: one worker per delivery at a time.
    const d = await this.db
      .updateTable('webhookDeliveries')
      .set({ lockedUntil: new Date(now.getTime() + 60_000), attempts: sql<number>`attempts + 1` })
      .where('id', '=', ctx.data.deliveryId)
      .where('status', 'in', [WebhookDeliveryStatus.PENDING, WebhookDeliveryStatus.RETRYING])
      .where((w) => w.or([w('lockedUntil', 'is', null), w('lockedUntil', '<', now)]))
      .returningAll()
      .executeTakeFirst();
    if (!d) return { status: 'SKIPPED_ALREADY_HANDLED' };

    const endpoint = await this.db.selectFrom('webhookEndpoints').selectAll().where('id', '=', d.endpointId).executeTakeFirst();
    if (!endpoint || endpoint.status !== WebhookEndpointStatus.ACTIVE) {
      await this.db.updateTable('webhookDeliveries').set({ status: WebhookDeliveryStatus.FAILED, lockedUntil: null, lastError: 'Endpoint is disabled or deleted' }).where('id', '=', d.id).execute();
      return { status: 'SKIPPED_ENDPOINT_INACTIVE' };
    }

    // Nothing is delivered for a partner that is suspended or no longer approved. The delivery stays FAILED and can be redelivered later.
    const org = await this.db.selectFrom('organizations').select('status').where('id', '=', d.organizationId).executeTakeFirst();
    if (org?.status !== 'ACTIVE') {
      await this.db.updateTable('webhookDeliveries').set({ status: WebhookDeliveryStatus.FAILED, lockedUntil: null, lastError: 'Organization is not active' }).where('id', '=', d.id).execute();
      return { status: 'SKIPPED_ORGANIZATION_INACTIVE' };
    }

    const { webhookAllowPrivateTargets, webhookTimeoutMs } = this.config.get('publicApi', { infer: true });
    const started = Date.now();
    try {
      const url = validateWebhookUrl(endpoint.url, webhookAllowPrivateTargets);
      const ts = Math.floor(Date.now() / 1000);
      const res = await postWebhook(
        url,
        {
          'Content-Type': 'application/json',
          'User-Agent': 'Tirvona-Webhooks/1.0',
          'Tirvona-Event-Id': d.eventId,
          'Tirvona-Event-Type': d.eventType,
          'Tirvona-Delivery-Attempt': String(d.attempts),
          'Tirvona-Signature': signatureHeader(decryptSecret(endpoint.secretEncrypted), ts, d.body),
        },
        d.body,
        { timeoutMs: webhookTimeoutMs, allowPrivate: webhookAllowPrivateTargets },
      );
      if (res.status < 200 || res.status >= 300) throw new Error(`Endpoint responded with HTTP ${res.status}`);
      await this.db
        .updateTable('webhookDeliveries')
        .set({ status: WebhookDeliveryStatus.DELIVERED, deliveredAt: new Date(), lockedUntil: null, lastStatusCode: res.status, lastError: null })
        .where('id', '=', d.id)
        .execute();
      return { status: 'DELIVERED', ms: Date.now() - started };
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const statusCode = /HTTP (\d{3})/.exec(message)?.[1];
      const final = isFinalAttempt(ctx);
      await this.db
        .updateTable('webhookDeliveries')
        .set({
          status: final ? WebhookDeliveryStatus.FAILED : WebhookDeliveryStatus.RETRYING,
          lockedUntil: null,
          lastError: message,
          ...(statusCode ? { lastStatusCode: Number(statusCode) } : {}),
          ...(final ? {} : { enqueuedAt: new Date(Date.now() + RETRY_OWNED_BY_QUEUE_MS) }),
        })
        .where('id', '=', d.id)
        .execute();
      if (final) {
        // Structured so a log-based alert can count event=client_webhook_failed.
        this.logger.error({ event: 'client_webhook_failed', deliveryId: d.id, endpointId: d.endpointId, eventType: d.eventType, attempts: d.attempts, error: message });
        throw nonRetryable(err);
      }
      throw err;
    }
  }
}
