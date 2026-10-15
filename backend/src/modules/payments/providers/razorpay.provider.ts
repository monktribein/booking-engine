import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../../config/configuration';
import { PaymentProvider } from '../../../database/enums';
import { ChannelError, DomainError } from '../../../database/errors';
import type {
  CreateOrderInput,
  CreatedOrder,
  PaymentProviderAdapter,
  PaymentWebhookEvent,
  ProviderRefund,
} from './payment-provider.interface';

const API = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 15_000;

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Razorpay through its public, documented REST API:
 *   POST /v1/orders                     create an order before Checkout
 *   POST /v1/payments/:id/refund        full/partial refund
 *   GET  /v1/payments/:id/refunds       used to make refund retries idempotent
 * Signatures:
 *   checkout: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
 *   webhook : HMAC_SHA256(raw body, webhook_secret) in X-Razorpay-Signature
 */
@Injectable()
export class RazorpayProvider implements PaymentProviderAdapter {
  readonly provider = PaymentProvider.RAZORPAY;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get cfg() {
    return this.config.get('razorpay', { infer: true });
  }

  isConfigured(): boolean {
    return !!(this.cfg.keyId && this.cfg.keySecret);
  }

  publicKey(): string | null {
    return this.cfg.keyId;
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const res = await this.call<{ id: string; amount: number; currency: string }>('POST', '/orders', {
      amount: input.amount,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    });
    return { orderId: res.id, amount: res.amount, currency: res.currency };
  }

  verifyPaymentSignature({ orderId, paymentId, signature }: { orderId: string; paymentId: string; signature: string }): boolean {
    if (!this.cfg.keySecret) return false;
    const expected = createHmac('sha256', this.cfg.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
    return safeEqualHex(signature, expected);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!this.cfg.webhookSecret || !signature) return false;
    const expected = createHmac('sha256', this.cfg.webhookSecret).update(rawBody).digest('hex');
    return safeEqualHex(signature, expected);
  }

  parseWebhook(body: unknown, headers: Record<string, string | string[] | undefined>): PaymentWebhookEvent {
    const b = body as {
      event?: string;
      payload?: {
        payment?: { entity?: { id: string; order_id?: string; amount: number; currency: string; method?: string; error_description?: string } };
        refund?: { entity?: { id: string; payment_id: string; amount: number; notes?: Record<string, string> } };
      };
    };
    const rawType = b?.event ?? 'unknown';
    const eventIdHeader = headers['x-razorpay-event-id'];
    const eventId = Array.isArray(eventIdHeader) ? eventIdHeader[0] : eventIdHeader;
    const p = b?.payload?.payment?.entity;
    const r = b?.payload?.refund?.entity;
    const type: PaymentWebhookEvent['type'] =
      rawType === 'payment.captured' || rawType === 'order.paid'
        ? 'PAYMENT_CAPTURED'
        : rawType === 'payment.failed'
          ? 'PAYMENT_FAILED'
          : rawType === 'refund.processed'
            ? 'REFUND_PROCESSED'
            : rawType === 'refund.failed'
              ? 'REFUND_FAILED'
              : 'OTHER';
    return {
      eventId,
      type,
      rawType,
      orderId: p?.order_id,
      paymentId: p?.id ?? r?.payment_id,
      refundId: r?.id,
      amount: p?.amount ?? r?.amount,
      currency: p?.currency,
      method: p?.method,
      failureReason: p?.error_description,
    };
  }

  async refund({ paymentId, amount, refundReference }: { paymentId: string; amount: number; refundReference: string }): Promise<ProviderRefund> {
    // Idempotency: a previous attempt may have succeeded after we timed out. Look for our reference first.
    const existing = await this.call<{ items: { id: string; status: string; notes?: Record<string, string> }[] }>('GET', `/payments/${encodeURIComponent(paymentId)}/refunds`);
    const prior = existing.items?.find((x) => x.notes?.tirvona_refund_id === refundReference);
    const toResult = (x: { id: string; status: string }): ProviderRefund => ({ refundId: x.id, status: x.status === 'processed' ? 'PROCESSED' : 'PENDING' });
    if (prior) return toResult(prior);
    const created = await this.call<{ id: string; status: string }>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, {
      amount,
      notes: { tirvona_refund_id: refundReference },
    });
    return toResult(created);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.isConfigured()) throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Razorpay is not configured');
    const auth = Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ChannelError('PAYMENT_PROVIDER_ERROR', `Razorpay unreachable: ${(err as Error).message}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; description?: string } };
    if (!res.ok) {
      // 5xx/429 are worth retrying; 4xx are request errors.
      const retryable = res.status >= 500 || res.status === 429;
      throw new ChannelError('PAYMENT_PROVIDER_ERROR', `Razorpay ${res.status}: ${json.error?.description ?? 'request failed'}`, retryable);
    }
    return json;
  }
}
