import type { PaymentProvider } from '../../../database/enums';

export interface CreateOrderInput {
  /** Minor units. */
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}

export interface CreatedOrder {
  orderId: string;
  amount: number;
  currency: string;
}

export type PaymentWebhookType = 'PAYMENT_CAPTURED' | 'PAYMENT_FAILED' | 'REFUND_PROCESSED' | 'REFUND_FAILED' | 'OTHER';

export interface PaymentWebhookEvent {
  eventId?: string;
  type: PaymentWebhookType;
  rawType: string;
  orderId?: string;
  paymentId?: string;
  refundId?: string;
  amount?: number;
  currency?: string;
  method?: string;
  failureReason?: string;
}

export interface ProviderRefund {
  refundId: string;
  status: 'PROCESSED' | 'PENDING';
}

/**
 * Gateway abstraction. Card data never touches Tirvona: the gateway's hosted
 * checkout collects it, and only provider references and non-sensitive
 * metadata (method, network, last4) are stored.
 */
export interface PaymentProviderAdapter {
  readonly provider: PaymentProvider;
  isConfigured(): boolean;
  /** Public key the browser checkout needs (never the secret). */
  publicKey(): string | null;
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  /** Verify the signature the checkout returns to the browser after payment. */
  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean;
  parseWebhook(body: unknown, headers: Record<string, string | string[] | undefined>): PaymentWebhookEvent;
  /** Must be idempotent per `refundReference` (retries must never double-refund). */
  refund(input: { paymentId: string; amount: number; refundReference: string }): Promise<ProviderRefund>;
}
