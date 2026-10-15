import { Injectable, Logger } from '@nestjs/common';
import type { AuthUser, RequestMeta } from '../../common/auth/auth-user';
import { redactSecrets } from '../../database/common/redact';
import type { Payment, Refund } from '../../database/db-types';
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
import { Db, InjectDb, j, runInTransaction } from '../../database/kysely';
import { insertNotification } from '../../database/repos';
import { Reservation, findReservation } from '../../database/reservation-store';
import { ClientEventService } from '../../database/services/client-event.service';
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

const plainMeta = (m: Record<string, unknown>) => redactSecrets(JSON.parse(JSON.stringify(m)) as Record<string, unknown>);

/**
 * Payment lifecycle. Money movements are idempotent on provider ids (unique partial indexes on provider_payment_id /
 * provider_refund_id), and capture locks the payment row (SELECT ... FOR UPDATE) for a conditional PENDING→PAID
 * transition, so the browser callback and the gateway webhook can race without double-counting.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly razorpay: RazorpayProvider,
    private readonly reservations: ReservationService,
    private readonly webhooks: WebhookService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogger,
    private readonly clientEvents: ClientEventService,
  ) {}

  gateway(provider: PaymentProvider): PaymentProviderAdapter {
    if (provider === PaymentProvider.RAZORPAY) return this.razorpay;
    throw new DomainValidationError(`${provider} is not an online gateway`);
  }

  balanceDue(r: Pick<Reservation, 'total' | 'amountPaid' | 'amountRefunded'>): number {
    return Math.max(0, r.total - (r.amountPaid - r.amountRefunded));
  }

  // ------------------------------------------------------------ create

  /**
   * Staff-facing "take a payment". Online (RAZORPAY): creates a gateway order and a PENDING payment the guest completes
   * in Checkout. Offline (CASH, BANK_TRANSFER, OTHER): recorded as PAID immediately.
   */
  async create(
    user: AuthUser | null,
    meta: RequestMeta,
    input: { reservationId: string; provider: PaymentProvider; amount?: number; reference?: string },
  ): Promise<{ payment: Payment; checkout: CheckoutPayload | null }> {
    const r = await findReservation(this.db, { id: input.reservationId });
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
      reservationId: r.id,
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
      notes: { reservationCode: r.reservationCode, reservationId: r.id },
    });
    const payment = await this.db
      .insertInto('payments')
      .values({
        propertyId: r.propertyId,
        reservationId: r.id,
        provider: PaymentProvider.RAZORPAY,
        providerOrderId: order.orderId,
        providerPaymentId: null,
        amount,
        currency: r.currency,
        status: PaymentStatus.PENDING,
        paidAt: null,
        failureReason: null,
        createdBy: user?.userId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    this.audit.logSafe({ user, meta }, { action: 'payment.order_create', entityType: 'Payment', entityId: payment.id, propertyId: r.propertyId, after: { amount, orderId: order.orderId } });
    return {
      payment,
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
    const r = await this.db.selectFrom('reservations').select(['reservationCode', 'status', 'paymentStatus']).where('id', '=', payment.reservationId).executeTakeFirst();
    return { payment, reservation: r ?? null };
  }

  /** PENDING → PAID for the order, then the reservation effects. Idempotent. */
  async capture(orderId: string, paymentId: string, metadata: Record<string, unknown>, meta: RequestMeta = {}): Promise<Payment> {
    const result = await runInTransaction(this.db, async (tx) => {
      // The row lock queues a racing callback/webhook behind us; it then sees PAID and does nothing.
      const payment = await tx.selectFrom('payments').selectAll().where('provider', '=', PaymentProvider.RAZORPAY).where('providerOrderId', '=', orderId).forUpdate().executeTakeFirst();
      if (!payment) throw new NotFoundError('Payment for order', orderId);
      if (payment.status === PaymentStatus.PAID || payment.status === PaymentStatus.REFUNDED || payment.status === PaymentStatus.PARTIALLY_REFUNDED) {
        return { payment, captured: false };
      }
      const now = new Date();
      const updated = await tx
        .updateTable('payments')
        .set({
          status: PaymentStatus.PAID,
          providerPaymentId: paymentId,
          paidAt: now,
          metadata: j(plainMeta({ ...payment.metadata, ...metadata })),
        })
        .where('id', '=', payment.id)
        .where('status', 'in', [PaymentStatus.PENDING, PaymentStatus.AUTHORIZED, PaymentStatus.FAILED])
        .returningAll()
        .executeTakeFirstOrThrow();
      const r = await findReservation(tx, { id: payment.reservationId }, { forUpdate: true });
      await this.reservations.applyCapturedPayment(tx, r!, payment.amount, now);
      await this.audit.log({ meta }, { action: 'payment.captured', entityType: 'Payment', entityId: payment.id, propertyId: payment.propertyId, after: { amount: payment.amount, paymentId } }, tx);
      return { payment: updated, captured: true };
    });
    if (result.captured) void this.outbox.flush();
    return result.payment;
  }

  async markFailed(orderId: string, reason: string): Promise<void> {
    const payment = await this.db
      .updateTable('payments')
      .set({ status: PaymentStatus.FAILED, failureReason: reason.slice(0, 500) })
      .where('provider', '=', PaymentProvider.RAZORPAY)
      .where('providerOrderId', '=', orderId)
      .where('status', '=', PaymentStatus.PENDING)
      .returningAll()
      .executeTakeFirst();
    if (!payment) return;
    // Alertable event: count of these per hour is the payment-failure rate (no guest data in it).
    this.logger.warn({ event: 'payment_failed', paymentId: payment.id, reservationId: payment.reservationId, amount: payment.amount, reason: reason.slice(0, 120) });
    const r = await findReservation(this.db, { id: payment.reservationId });
    const property = r && (await this.db.selectFrom('properties').select(['id', 'organizationId', 'slug', 'name']).where('id', '=', r.propertyId).executeTakeFirst());
    if (r && property) {
      await this.clientEvents
        .emit(null, { type: 'payment.failed', property, reservation: r, discriminator: payment.id, extra: { payment: { amount: payment.amount, currency: payment.currency, reason: reason.slice(0, 200) } } })
        .catch((err) => this.logger.error(`client event payment.failed not recorded: ${(err as Error).message}`));
      void this.outbox.flush();
    }
    if (r?.guest.email) {
      await insertNotification(this.db, {
        propertyId: r.propertyId,
        reservationId: r.id,
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
      await this.webhooks.markEnqueued(event.id);
      await this.outbox.enqueueWebhook(event.id, 'RAZORPAY');
    }
    return { received: true, duplicate, eventId: event.id };
  }

  /** payment queue, kind WEBHOOK. */
  async processWebhookEvent(eventId: string, ctx: JobContext): Promise<unknown> {
    const ev = await this.webhooks.claimById(eventId);
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
          if (e.refundId) {
            await this.db.updateTable('refunds').set({ status: RefundStatus.FAILED, lastError: 'Refund failed at gateway' }).where('providerRefundId', '=', e.refundId).where('status', '=', RefundStatus.PROCESSING).execute();
          }
          break;
        default:
          await this.webhooks.markIgnored(eventId, `Unhandled event ${e.rawType}`);
          return { status: 'IGNORED' };
      }
      await this.webhooks.markProcessed(eventId, ev.propertyId);
      return { status: 'PROCESSED', type: e.type };
    } catch (err) {
      const final = !isRetryable(err) || isFinalAttempt(ctx);
      this.logger[final ? 'error' : 'warn']({ event: 'payment_webhook_failed', webhookEventId: eventId, final, attempt: ctx.attemptsMade + 1, error: (err as Error).message.slice(0, 200) });
      await this.webhooks.markFailed(eventId, (err as Error).message, final);
      throw final ? nonRetryable(err) : err;
    }
  }

  // ------------------------------------------------------------ refunds

  /** Queue a full or partial refund. Never more than paid minus already refunded or pending. */
  async requestRefund(user: AuthUser, meta: RequestMeta, paymentId: string, input: { amount?: number; reason: string }): Promise<Refund> {
    const refund = await runInTransaction(this.db, async (tx) => {
      // Locking the payment makes concurrent refund requests on it queue instead of over-refunding.
      const p = await tx.selectFrom('payments').selectAll().where('id', '=', paymentId).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundError('Payment', paymentId);
      if (![PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED].includes(p.status as PaymentStatus)) {
        throw new DomainError('INVALID_STATE_TRANSITION', `A ${p.status} payment cannot be refunded`);
      }
      const pending = await tx.selectFrom('refunds').select('amount').where('paymentId', '=', paymentId).where('status', 'in', [RefundStatus.PENDING, RefundStatus.PROCESSING]).execute();
      const refundable = p.amount - p.amountRefunded - pending.reduce((a, x) => a + x.amount, 0);
      const amount = input.amount ?? refundable;
      if (!Number.isInteger(amount) || amount < 1) throw new DomainValidationError('Refund amount must be a positive integer');
      if (amount > refundable) throw new DomainError('REFUND_EXCEEDS_BALANCE', `At most ${refundable} can be refunded on this payment`);
      const r = await tx
        .insertInto('refunds')
        .values({ propertyId: p.propertyId, reservationId: p.reservationId, paymentId: p.id, provider: p.provider, amount, currency: p.currency, reason: input.reason, requestedBy: user.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.log({ user, meta }, { action: 'payment.refund_request', entityType: 'Refund', entityId: r.id, propertyId: p.propertyId, after: { paymentId, amount, reason: input.reason } }, tx);
      return r;
    });
    void this.outbox.flush();
    return refund;
  }

  /** payment queue, kind REFUND: execute at the gateway (or settle offline), then book it. */
  async processRefund(refundId: string, ctx: JobContext): Promise<unknown> {
    const refund = await this.db
      .updateTable('refunds')
      .set({ status: RefundStatus.PROCESSING })
      .where('id', '=', refundId)
      .where('status', 'in', [RefundStatus.PENDING, RefundStatus.PROCESSING])
      .where('providerRefundId', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (!refund) return { status: 'SKIPPED_ALREADY_HANDLED' };
    const payment = await this.db.selectFrom('payments').selectAll().where('id', '=', refund.paymentId).executeTakeFirstOrThrow();
    try {
      if (payment.provider === PaymentProvider.RAZORPAY) {
        if (!payment.providerPaymentId) throw new DomainValidationError('Gateway payment has no provider payment id');
        const res = await this.razorpay.refund({ paymentId: payment.providerPaymentId, amount: refund.amount, refundReference: refund.id });
        await this.db.updateTable('refunds').set({ providerRefundId: res.refundId }).where('id', '=', refund.id).execute();
        if (res.status === 'PROCESSED') await this.finalizeRefund(refund.id);
        return { status: res.status };
      }
      // Cash / bank transfer: money is returned by staff; the ledger is updated now.
      await this.db.updateTable('refunds').set({ metadata: j({ settlement: 'offline' }) }).where('id', '=', refund.id).execute();
      await this.finalizeRefund(refund.id);
      return { status: 'PROCESSED_OFFLINE' };
    } catch (err) {
      const final = !isRetryable(err) || isFinalAttempt(ctx);
      this.logger[final ? 'error' : 'warn']({ event: 'refund_failed', refundId: refund.id, paymentId: refund.paymentId, final, attempt: ctx.attemptsMade + 1, error: (err as Error).message.slice(0, 200) });
      await this.db
        .updateTable('refunds')
        .set({ status: final ? RefundStatus.FAILED : RefundStatus.PENDING, lastError: (err as Error).message.slice(0, 2000) })
        .where('id', '=', refund.id)
        .execute();
      throw final ? nonRetryable(err) : err;
    }
  }

  private async finalizeRefundByProviderId(providerRefundId: string) {
    const r = await this.db.selectFrom('refunds').select('id').where('providerRefundId', '=', providerRefundId).executeTakeFirst();
    if (r) await this.finalizeRefund(r.id);
  }

  /** PROCESSING → PROCESSED plus payment/reservation totals, once (conditional transition). */
  async finalizeRefund(refundId: string): Promise<void> {
    await runInTransaction(this.db, async (tx) => {
      const refund = await tx
        .updateTable('refunds')
        .set({ status: RefundStatus.PROCESSED, processedAt: new Date() })
        .where('id', '=', refundId)
        .where('status', '<>', RefundStatus.PROCESSED)
        .returningAll()
        .executeTakeFirst();
      if (!refund) return;
      const p = await tx.selectFrom('payments').selectAll().where('id', '=', refund.paymentId).forUpdate().executeTakeFirstOrThrow();
      const refunded = p.amountRefunded + refund.amount;
      await tx
        .updateTable('payments')
        .set({ amountRefunded: refunded, status: refunded >= p.amount ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED })
        .where('id', '=', p.id)
        .execute();
      const r = await tx.selectFrom('reservations').select(['id', 'amountRefunded', 'amountPaid']).where('id', '=', refund.reservationId).forUpdate().executeTakeFirstOrThrow();
      const rRefunded = r.amountRefunded + refund.amount;
      await tx
        .updateTable('reservations')
        .set({ amountRefunded: rRefunded, paymentStatus: rRefunded >= r.amountPaid ? ReservationPaymentStatus.REFUNDED : ReservationPaymentStatus.PARTIALLY_REFUNDED })
        .where('id', '=', r.id)
        .execute();
      await this.audit.log({}, { action: 'payment.refund_processed', entityType: 'Refund', entityId: refund.id, propertyId: refund.propertyId, after: { amount: refund.amount } }, tx);
    });
  }

  // ------------------------------------------------------------ reads

  async get(id: string) {
    const p = await this.db.selectFrom('payments').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundError('Payment', id);
    const refunds = await this.db.selectFrom('refunds').selectAll().where('paymentId', '=', id).orderBy('createdAt', 'desc').execute();
    return { ...p, refunds };
  }

  listForReservation(reservationId: string) {
    return this.db.selectFrom('payments').selectAll().where('reservationId', '=', reservationId).orderBy('createdAt', 'desc').execute();
  }
}

