import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { runInTransaction } from '../../database/common/transaction';
import {
  NotificationChannel,
  NotificationType,
  PaymentProvider,
  PaymentStatus,
  RefundStatus,
  ReservationPaymentStatus,
  ReservationStatus,
} from '../../database/enums';
import { DomainError, DomainValidationError, NotFoundError, UnauthorizedError } from '../../database/errors';
import { Models, getModels } from '../../database/models';
import type { Payment, Refund } from '../../database/schemas/payment.schema';
import type { Reservation } from '../../database/schemas/reservation.schema';
import { ReservationService } from '../../database/services/reservation.service';
import { WebhookService } from '../../database/services/webhook.service';
import { JobContext, isFinalAttempt, isRetryable, nonRetryable } from '../../jobs/job-handler';
import { OutboxDispatcher } from '../../jobs/outbox.dispatcher';
import { AuditLogger } from '../audit/audit.logger';
import { RazorpayProvider } from './providers/razorpay.provider';
import type { PaymentProviderAdapter } from './providers/payment-provider.interface';

export interface CheckoutPayload {
  provider: PaymentProvider;
  keyId: string | null;
  orderId: string;
  amount: number;
  currency: string;
  reservationCode: string;
  prefill: { name: string; email?: string; contact?: string };
}

/**
 * Payment lifecycle. Money movements are idempotent on provider ids
 * (unique partial indexes on providerPaymentId / providerRefundId), and
 * capture is a conditional PENDING→PAID transition inside a transaction,
 * so the browser callback and the gateway webhook can race without
 * double-counting.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly m: Models;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly razorpay: RazorpayProvider,
    private readonly reservations: ReservationService,
    private readonly webhooks: WebhookService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
  ) {
    this.m = getModels(connection);
  }

  gateway(provider: PaymentProvider): PaymentProviderAdapter {
    if (provider === PaymentProvider.RAZORPAY) return this.razorpay;
    throw new DomainValidationError(`${provider} is not an online gateway`);
  }

  balanceDue(r: Pick<Reservation, 'total' | 'amountPaid' | 'amountRefunded'>): number {
    return Math.max(0, r.total - (r.amountPaid - r.amountRefunded));
  }

  // ------------------------------------------------------------ create

  /**
   * Staff-facing "take a payment". Online (RAZORPAY): creates a gateway order
   * and a PENDING payment the guest completes in Checkout. Offline (CASH,
   * BANK_TRANSFER, OTHER): recorded as PAID immediately.
   */
  async create(
    user: AuthUser | null,
    meta: RequestMeta,
    input: { reservationId: Types.ObjectId; provider: PaymentProvider; amount?: number; reference?: string },
  ): Promise<{ payment: Payment; checkout: CheckoutPayload | null }> {
    const r = await this.m.Reservation.findById(input.reservationId).lean();
    if (!r) throw new NotFoundError('Reservation', input.reservationId);
    if (r.status === ReservationStatus.CANCELLED) throw new DomainError('INVALID_STATE_TRANSITION', 'Reservation is cancelled');
    if (r.paymentStatus === ReservationPaymentStatus.CHANNEL_COLLECTED) throw new DomainValidationError('Payment was collected by the channel');
    const due = this.balanceDue(r);
    const amount = input.amount ?? due;
    if (!Number.isInteger(amount) || amount < 1) throw new DomainValidationError('amount must be a positive integer (minor units)');
    if (amount > due) throw new DomainValidationError(`amount exceeds the balance due (${due})`);

    if (input.provider === PaymentProvider.RAZORPAY) return this.createGatewayOrder(user, meta, r, amount);
    if (input.provider === PaymentProvider.CHANNEL_COLLECTED) throw new DomainValidationError('CHANNEL_COLLECTED payments come from channels');

    const { payment } = await this.reservations.recordPayment({
      propertyId: r.propertyId,
      reservationId: r._id,
      provider: input.provider,
      amount,
      currency: r.currency,
      status: PaymentStatus.PAID,
      metadata: input.reference ? { reference: input.reference } : {},
      createdBy: user?.userId ?? null,
    });
    void this.outbox.flush();
    return { payment, checkout: null };
  }

  async createGatewayOrder(user: AuthUser | null, meta: RequestMeta, r: Reservation, amount: number) {
    if (!this.razorpay.isConfigured()) throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Online payments are not configured');
    const order = await this.razorpay.createOrder({
      amount,
      currency: r.currency,
      receipt: r.reservationCode,
      notes: { reservationCode: r.reservationCode, reservationId: String(r._id) },
    });
    const [payment] = await this.m.Payment.create([
      {
        propertyId: r.propertyId,
        reservationId: r._id,
        provider: PaymentProvider.RAZORPAY,
        providerOrderId: order.orderId,
        amount,
        currency: r.currency,
        status: PaymentStatus.PENDING,
        createdBy: user?.userId ?? null,
      },
    ]);
    this.audit.logSafe({ user, meta }, { action: 'payment.order_create', entityType: 'Payment', entityId: payment._id, propertyId: r.propertyId, after: { amount, orderId: order.orderId } });
    return {
      payment: payment.toObject(),
      checkout: {
        provider: PaymentProvider.RAZORPAY,
        keyId: this.razorpay.publicKey(),
        orderId: order.orderId,
        amount,
        currency: r.currency,
        reservationCode: r.reservationCode,
        prefill: { name: `${r.guest.firstName} ${r.guest.lastName}`.trim(), email: r.guest.email, contact: r.guest.phone },
      },
    };
  }

  // ------------------------------------------------------------ capture / fail

  /** Browser callback after Checkout. The signature proves the payment belongs to our order. */
  async verifyCheckout(input: { orderId: string; paymentId: string; signature: string }, meta: RequestMeta) {
    if (!this.razorpay.verifyPaymentSignature(input)) throw new DomainError('PAYMENT_SIGNATURE_INVALID', 'Payment signature verification failed');
    const payment = await this.capture(input.orderId, input.paymentId, {}, meta);
    const r = await this.m.Reservation.findById(payment.reservationId, { reservationCode: 1, status: 1, paymentStatus: 1 }).lean();
    return { payment, reservation: r };
  }

  /** PENDING → PAID for the order, then the reservation effects. Idempotent. */
  async capture(orderId: string, paymentId: string, metadata: Record<string, unknown>, meta: RequestMeta = {}): Promise<Payment> {
    const result = await runInTransaction(this.connection, async (session) => {
      const payment = await this.m.Payment.findOne({ provider: PaymentProvider.RAZORPAY, providerOrderId: orderId }).session(session).lean();
      if (!payment) throw new NotFoundError('Payment for order', orderId);
      if (payment.status === PaymentStatus.PAID || payment.status === PaymentStatus.REFUNDED || payment.status === PaymentStatus.PARTIALLY_REFUNDED) {
        return { payment, captured: false };
      }
      const now = new Date();
      const updated = await this.m.Payment.findOneAndUpdate(
        { _id: payment._id, status: { $in: [PaymentStatus.PENDING, PaymentStatus.AUTHORIZED, PaymentStatus.FAILED] } },
        { $set: { status: PaymentStatus.PAID, providerPaymentId: paymentId, paidAt: now, metadata: { ...payment.metadata, ...metadata } } },
        { new: true, session, runValidators: true },
      ).lean();
      const r = await this.m.Reservation.findById(payment.reservationId).session(session).lean();
      await this.reservations.applyCapturedPayment(session, r!, payment.amount, now);
      await this.audit.log({ meta }, { action: 'payment.captured', entityType: 'Payment', entityId: payment._id, propertyId: payment.propertyId, after: { amount: payment.amount, paymentId } }, session);
      return { payment: updated!, captured: true };
    });
    if (result.captured) void this.outbox.flush();
    return result.payment;
  }

  async markFailed(orderId: string, reason: string): Promise<void> {
    const payment = await this.m.Payment.findOneAndUpdate(
      { provider: PaymentProvider.RAZORPAY, providerOrderId: orderId, status: PaymentStatus.PENDING },
      { $set: { status: PaymentStatus.FAILED, failureReason: reason.slice(0, 500) } },
      { new: true },
    ).lean();
    if (!payment) return;
    // Alertable event: count of these per hour is the payment-failure rate (no guest data in it).
    this.logger.warn({ event: 'payment_failed', paymentId: String(payment._id), reservationId: String(payment.reservationId), amount: payment.amount, reason: reason.slice(0, 120) });
    const r = await this.m.Reservation.findById(payment.reservationId, { guest: 1, reservationCode: 1, propertyId: 1 }).lean();
    if (r?.guest.email) {
      await this.m.Notification.create({
        propertyId: r.propertyId,
        reservationId: r._id,
        type: NotificationType.PAYMENT_FAILED,
        channel: NotificationChannel.EMAIL,
        recipient: r.guest.email,
        subject: `Payment failed for ${r.reservationCode}`,
        message: `Your payment for reservation ${r.reservationCode} did not go through. You can try again before your hold expires.`,
      });
      void this.outbox.flush();
    }
  }

  // ------------------------------------------------------------ webhooks

  /** POST /payments/webhook: verify → persist raw event (idempotent) → enqueue → return. */
  async receiveWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, body: unknown) {
    const sigHeader = headers['x-razorpay-signature'];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const valid = this.razorpay.verifyWebhookSignature(rawBody, signature);
    const parsed = valid ? this.razorpay.parseWebhook(body, headers) : null;
    const { event, duplicate } = await this.webhooks.ingest({
      channel: 'RAZORPAY',
      eventType: parsed?.rawType ?? 'unknown',
      externalEventId: parsed?.eventId,
      payload: typeof body === 'object' && body ? (body as Record<string, unknown>) : {},
      rawBody,
      signature,
      signatureValid: valid,
    });
    if (!valid) throw new UnauthorizedError('Webhook signature verification failed', 'INVALID_SIGNATURE');
    if (!duplicate) {
      await this.webhooks.markEnqueued(event._id);
      await this.outbox.enqueueWebhook(event._id, 'RAZORPAY');
    }
    return { received: true, duplicate, eventId: String(event._id) };
  }

  /** payment queue, kind WEBHOOK. */
  async processWebhookEvent(eventId: string, ctx: JobContext): Promise<unknown> {
    const id = new Types.ObjectId(eventId);
    const ev = await this.webhooks.claimById(id);
    if (!ev) return { status: 'SKIPPED_ALREADY_HANDLED' };
    try {
      const e = this.razorpay.parseWebhook(ev.payload, {});
      switch (e.type) {
        case 'PAYMENT_CAPTURED':
          if (!e.orderId || !e.paymentId) throw new DomainValidationError('Captured event without order/payment id');
          await this.capture(e.orderId, e.paymentId, { method: e.method, source: 'webhook' });
          break;
        case 'PAYMENT_FAILED':
          if (e.orderId) await this.markFailed(e.orderId, e.failureReason ?? 'Payment failed');
          break;
        case 'REFUND_PROCESSED':
          if (e.refundId) await this.finalizeRefundByProviderId(e.refundId);
          break;
        case 'REFUND_FAILED':
          if (e.refundId) await this.m.Refund.updateOne({ providerRefundId: e.refundId, status: RefundStatus.PROCESSING }, { $set: { status: RefundStatus.FAILED, lastError: 'Refund failed at gateway' } });
          break;
        default:
          await this.webhooks.markIgnored(id, `Unhandled event ${e.rawType}`);
          return { status: 'IGNORED' };
      }
      await this.webhooks.markProcessed(id, ev.propertyId);
      return { status: 'PROCESSED', type: e.type };
    } catch (err) {
      const final = !isRetryable(err) || isFinalAttempt(ctx);
      this.logger[final ? 'error' : 'warn']({ event: 'payment_webhook_failed', webhookEventId: eventId, final, attempt: ctx.attemptsMade + 1, error: (err as Error).message.slice(0, 200) });
      await this.webhooks.markFailed(id, (err as Error).message, final);
      throw final ? nonRetryable(err) : err;
    }
  }

  // ------------------------------------------------------------ refunds

  /** Queue a full or partial refund. Never more than paid minus already refunded or pending. */
  async requestRefund(user: AuthUser, meta: RequestMeta, paymentId: Types.ObjectId, input: { amount?: number; reason: string }): Promise<Refund> {
    const refund = await runInTransaction(this.connection, async (session) => {
      const p = await this.m.Payment.findById(paymentId).session(session).lean();
      if (!p) throw new NotFoundError('Payment', paymentId);
      if (![PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED].includes(p.status)) {
        throw new DomainError('INVALID_STATE_TRANSITION', `A ${p.status} payment cannot be refunded`);
      }
      const pending = await this.m.Refund.find({ paymentId, status: { $in: [RefundStatus.PENDING, RefundStatus.PROCESSING] } }).session(session).lean();
      const refundable = p.amount - p.amountRefunded - pending.reduce((a, x) => a + x.amount, 0);
      const amount = input.amount ?? refundable;
      if (!Number.isInteger(amount) || amount < 1) throw new DomainValidationError('Refund amount must be a positive integer');
      if (amount > refundable) throw new DomainError('REFUND_EXCEEDS_BALANCE', `At most ${refundable} can be refunded on this payment`);
      // Touch the payment so concurrent refund requests on it conflict and serialise.
      await this.m.Payment.updateOne({ _id: p._id }, { $set: { updatedAt: new Date() } }, { session });
      const [r] = await this.m.Refund.create(
        [{ propertyId: p.propertyId, reservationId: p.reservationId, paymentId: p._id, provider: p.provider, amount, currency: p.currency, reason: input.reason, requestedBy: user.userId }],
        { session },
      );
      await this.audit.log({ user, meta }, { action: 'payment.refund_request', entityType: 'Refund', entityId: r._id, propertyId: p.propertyId, after: { paymentId, amount, reason: input.reason } }, session);
      return r.toObject();
    });
    void this.outbox.flush();
    return refund;
  }

  /** payment queue, kind REFUND: execute at the gateway (or settle offline), then book it. */
  async processRefund(refundId: string, ctx: JobContext): Promise<unknown> {
    const refund = await this.m.Refund.findOneAndUpdate(
      { _id: refundId, status: { $in: [RefundStatus.PENDING, RefundStatus.PROCESSING] }, providerRefundId: { $exists: false } },
      { $set: { status: RefundStatus.PROCESSING } },
      { new: true },
    ).lean();
    if (!refund) return { status: 'SKIPPED_ALREADY_HANDLED' };
    const payment = await this.m.Payment.findById(refund.paymentId).lean();
    try {
      if (payment!.provider === PaymentProvider.RAZORPAY) {
        if (!payment!.providerPaymentId) throw new DomainValidationError('Gateway payment has no provider payment id');
        const res = await this.razorpay.refund({ paymentId: payment!.providerPaymentId, amount: refund.amount, refundReference: String(refund._id) });
        await this.m.Refund.updateOne({ _id: refund._id }, { $set: { providerRefundId: res.refundId } });
        if (res.status === 'PROCESSED') await this.finalizeRefund(refund._id);
        return { status: res.status };
      }
      // Cash / bank transfer: money is returned by staff; the ledger is updated now.
      await this.m.Refund.updateOne({ _id: refund._id }, { $set: { metadata: { settlement: 'offline' } } });
      await this.finalizeRefund(refund._id);
      return { status: 'PROCESSED_OFFLINE' };
    } catch (err) {
      const final = !isRetryable(err) || isFinalAttempt(ctx);
      this.logger[final ? 'error' : 'warn']({ event: 'refund_failed', refundId: String(refund._id), paymentId: String(refund.paymentId), final, attempt: ctx.attemptsMade + 1, error: (err as Error).message.slice(0, 200) });
      await this.m.Refund.updateOne(
        { _id: refund._id },
        { $set: { status: final ? RefundStatus.FAILED : RefundStatus.PENDING, lastError: (err as Error).message.slice(0, 2000) } },
      );
      throw final ? nonRetryable(err) : err;
    }
  }

  private async finalizeRefundByProviderId(providerRefundId: string) {
    const r = await this.m.Refund.findOne({ providerRefundId }, { _id: 1 }).lean();
    if (r) await this.finalizeRefund(r._id);
  }

  /** PROCESSING → PROCESSED plus payment/reservation totals, once (conditional transition). */
  async finalizeRefund(refundId: Types.ObjectId): Promise<void> {
    await runInTransaction(this.connection, async (session) => {
      const refund = await this.m.Refund.findOneAndUpdate(
        { _id: refundId, status: { $ne: RefundStatus.PROCESSED } },
        { $set: { status: RefundStatus.PROCESSED, processedAt: new Date() } },
        { new: true, session },
      ).lean();
      if (!refund) return;
      const p = await this.m.Payment.findById(refund.paymentId).session(session).lean();
      const refunded = p!.amountRefunded + refund.amount;
      await this.m.Payment.updateOne(
        { _id: p!._id },
        { $set: { amountRefunded: refunded, status: refunded >= p!.amount ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED } },
        { session },
      );
      const r = await this.m.Reservation.findById(refund.reservationId).session(session).lean();
      const rRefunded = r!.amountRefunded + refund.amount;
      await this.m.Reservation.updateOne(
        { _id: r!._id },
        { $set: { amountRefunded: rRefunded, paymentStatus: rRefunded >= r!.amountPaid ? ReservationPaymentStatus.REFUNDED : ReservationPaymentStatus.PARTIALLY_REFUNDED } },
        { session },
      );
      await this.audit.log({}, { action: 'payment.refund_processed', entityType: 'Refund', entityId: refund._id, propertyId: refund.propertyId, after: { amount: refund.amount } }, session);
    });
  }

  // ------------------------------------------------------------ reads

  async get(id: Types.ObjectId) {
    const p = await this.m.Payment.findById(id).lean();
    if (!p) throw new NotFoundError('Payment', id);
    const refunds = await this.m.Refund.find({ paymentId: id }).sort({ createdAt: -1 }).lean();
    return { ...p, refunds };
  }

  listForReservation(reservationId: Types.ObjectId) {
    return this.m.Payment.find({ reservationId }).sort({ createdAt: -1 }).lean();
  }
}
