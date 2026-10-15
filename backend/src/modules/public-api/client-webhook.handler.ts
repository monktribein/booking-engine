import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import type { AppConfig } from '../../config/configuration';
import { decryptSecret } from '../../database/common/crypto';
import { WebhookDeliveryStatus, WebhookEndpointStatus } from '../../database/enums';
import { Models, getModels } from '../../database/models';
import { JobContext, JobHandler, JobHandlerRegistry, isFinalAttempt, nonRetryable } from '../../jobs/job-handler';
import { QUEUES } from '../../jobs/queues';
import { postWebhook, validateWebhookUrl } from './safe-http';
import { signatureHeader } from './webhook-signature';

/** While BullMQ owns a retry, the outbox relay must not hand the row over again. */
const RETRY_OWNED_BY_QUEUE_MS = 2 * 3_600_000;

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
  private readonly m: Models;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly registry: JobHandlerRegistry,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.m = getModels(connection);
  }

  onModuleInit() {
    this.registry.register(this);
  }

  async handle(ctx: JobContext<'client-webhook'>) {
    const now = new Date();
    // Lease: one worker per delivery at a time.
    const d = await this.m.WebhookDelivery.findOneAndUpdate(
      {
        _id: ctx.data.deliveryId,
        status: { $in: [WebhookDeliveryStatus.PENDING, WebhookDeliveryStatus.RETRYING] },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      },
      { $set: { lockedUntil: new Date(now.getTime() + 60_000) }, $inc: { attempts: 1 } },
      { new: true },
    ).lean();
    if (!d) return { status: 'SKIPPED_ALREADY_HANDLED' };

    const endpoint = await this.m.WebhookEndpoint.findById(d.endpointId).select('+secretEncrypted').lean();
    if (!endpoint || endpoint.status !== WebhookEndpointStatus.ACTIVE) {
      await this.m.WebhookDelivery.updateOne({ _id: d._id }, { $set: { status: WebhookDeliveryStatus.FAILED, lockedUntil: null, lastError: 'Endpoint is disabled or deleted' } });
      return { status: 'SKIPPED_ENDPOINT_INACTIVE' };
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
      await this.m.WebhookDelivery.updateOne(
        { _id: d._id },
        { $set: { status: WebhookDeliveryStatus.DELIVERED, deliveredAt: new Date(), lockedUntil: null, lastStatusCode: res.status, lastError: null as never } },
      );
      return { status: 'DELIVERED', ms: Date.now() - started };
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const statusCode = /HTTP (\d{3})/.exec(message)?.[1];
      const final = isFinalAttempt(ctx);
      await this.m.WebhookDelivery.updateOne(
        { _id: d._id },
        {
          $set: {
            status: final ? WebhookDeliveryStatus.FAILED : WebhookDeliveryStatus.RETRYING,
            lockedUntil: null,
            lastError: message,
            ...(statusCode ? { lastStatusCode: Number(statusCode) } : {}),
            ...(final ? {} : { enqueuedAt: new Date(Date.now() + RETRY_OWNED_BY_QUEUE_MS) }),
          },
        },
      );
      if (final) {
        // Structured so a log-based alert can count event=client_webhook_failed.
        this.logger.error({ event: 'client_webhook_failed', deliveryId: String(d._id), endpointId: String(d.endpointId), eventType: d.eventType, attempts: d.attempts, error: message });
        throw nonRetryable(err);
      }
      throw err;
    }
  }
}
