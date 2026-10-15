import { Schema, Types } from 'mongoose';
import { COLLECTION, MODEL } from '../constants';
import { redactSecrets } from '../common/redact';
import { baseSchemaOptions, currency, enumOf, money, objectId } from '../common/schema-helpers';
import { PaymentProvider, PaymentStatus, RefundStatus } from '../enums';

/**
 * PCI scope: Tirvona never sees card data. Razorpay Checkout collects it and
 * we store only provider references (order_id, payment_id) and non-sensitive
 * metadata such as method, bank and card network/last4 as returned by the
 * provider. `metadata` is passed through redactSecrets, which also masks
 * anything that looks like a card number (Luhn-valid 13-19 digits).
 */

// ================================================================ payments

export interface Payment {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  reservationId: Types.ObjectId;
  provider: PaymentProvider;
  /** e.g. Razorpay pay_XXXX. Unique per provider when present. */
  providerPaymentId?: string;
  /** e.g. Razorpay order_XXXX, created before checkout. */
  providerOrderId?: string;
  amount: number;
  amountRefunded: number;
  currency: string;
  status: PaymentStatus;
  paidAt?: Date;
  failureReason?: string;
  metadata: Record<string, unknown>;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export const PaymentSchema = new Schema<Payment>(
  {
    propertyId: objectId(MODEL.Property),
    reservationId: objectId(MODEL.Reservation),
    provider: enumOf(PaymentProvider),
    providerPaymentId: { type: String, trim: true, maxlength: 100 },
    providerOrderId: { type: String, trim: true, maxlength: 100 },
    amount: money(),
    amountRefunded: money(false),
    currency: currency(),
    status: enumOf(PaymentStatus, true, PaymentStatus.PENDING),
    paidAt: { type: Date },
    failureReason: { type: String, maxlength: 500 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdBy: objectId(MODEL.User, false),
  },
  baseSchemaOptions(COLLECTION.payments),
);

PaymentSchema.pre('validate', function () {
  if (this.amountRefunded > this.amount) this.invalidate('amountRefunded', 'Cannot refund more than the payment amount');
  if (this.provider === PaymentProvider.RAZORPAY && !this.providerOrderId && !this.providerPaymentId) {
    this.invalidate('providerOrderId', 'Razorpay payments need an order or payment id');
  }
  this.metadata = redactSecrets(this.metadata ?? {});
});

PaymentSchema.index({ reservationId: 1 });
PaymentSchema.index(
  { provider: 1, providerOrderId: 1 },
  { partialFilterExpression: { providerOrderId: { $type: 'string' } } },
);
// Gateway webhook idempotency: the same captured payment is recorded once.
PaymentSchema.index(
  { provider: 1, providerPaymentId: 1 },
  { unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string' } } },
);
PaymentSchema.index({ propertyId: 1, createdAt: -1 });

// ================================================================ refunds

export interface Refund {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  reservationId: Types.ObjectId;
  paymentId: Types.ObjectId;
  provider: PaymentProvider;
  providerRefundId?: string;
  amount: number;
  currency: string;
  status: RefundStatus;
  reason?: string;
  requestedBy: Types.ObjectId | null;
  processedAt?: Date;
  lastError?: string;
  enqueuedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const RefundSchema = new Schema<Refund>(
  {
    propertyId: objectId(MODEL.Property),
    reservationId: objectId(MODEL.Reservation),
    paymentId: objectId(MODEL.Payment),
    provider: enumOf(PaymentProvider),
    providerRefundId: { type: String, trim: true, maxlength: 100 },
    amount: { ...money(), min: 1 },
    currency: currency(),
    status: enumOf(RefundStatus, true, RefundStatus.PENDING),
    reason: { type: String, trim: true, maxlength: 500 },
    requestedBy: objectId(MODEL.User, false),
    processedAt: { type: Date },
    lastError: { type: String, maxlength: 2000 },
    enqueuedAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  baseSchemaOptions(COLLECTION.refunds),
);

RefundSchema.pre('validate', function () {
  this.metadata = redactSecrets(this.metadata ?? {});
});

RefundSchema.index({ reservationId: 1 });
RefundSchema.index({ paymentId: 1 });
RefundSchema.index(
  { provider: 1, providerRefundId: 1 },
  { unique: true, partialFilterExpression: { providerRefundId: { $type: 'string' } } },
);
// Refund worker queue: PENDING/FAILED refunds, oldest first.
RefundSchema.index({ status: 1, createdAt: 1 });
