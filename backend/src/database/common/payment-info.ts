/**
 * What is known about the money of a CHANNEL booking, and where that knowledge came from. Read-only visibility: nothing here
 * collects, transfers or pays out money.
 *
 * The rule that shapes every function in this file: absence is information. A field that was not reported stays undefined/NULL and is
 * shown as "not reported". It is never defaulted to paid, unpaid or collected.
 */

export type CollectionModel = 'CHANNEL' | 'PROPERTY';
export type PaymentInfoSource = 'PROVIDER' | 'OPERATOR_CONFIG';
export type ProviderPaymentStatus = 'UNPAID' | 'PAID' | 'PARTIALLY_PAID' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED';
export type PayoutStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export const COLLECTION_MODELS: readonly CollectionModel[] = ['CHANNEL', 'PROPERTY'];
export const PROVIDER_PAYMENT_STATUSES: readonly ProviderPaymentStatus[] = ['UNPAID', 'PAID', 'PARTIALLY_PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED'];
export const PAYOUT_STATUSES: readonly PayoutStatus[] = ['PENDING', 'COMPLETED', 'FAILED'];

/** What an adapter hands over with a reservation event. Every field is optional; an empty object means "nothing is known". */
export interface ChannelPaymentInfo {
  /** Who collects the guest's money. Needs `collectionSource`; without it the claim is dropped. */
  collectedBy?: CollectionModel;
  /** PROVIDER: the channel reported it for this booking. OPERATOR_CONFIG: an operator declared it for the whole provider. */
  collectionSource?: PaymentInfoSource;
  /**
   * The fields below must be copied from the provider's own response by the adapter, never computed or defaulted. They are
   * provider-reported by construction (there is no other writer).
   */
  providerStatusRaw?: string;
  /** The reading of that word, only when it is certain (the operator's mapping lists it). */
  providerStatus?: ProviderPaymentStatus;
  payoutStatusRaw?: string;
  payoutStatus?: PayoutStatus;
  payoutDate?: Date;
  /** Minor units, as reported. */
  commissionAmount?: number;
  netAmount?: number;
}

/** The nullable column values for a reservation row. */
export interface PaymentInfoColumns {
  collectionModel: CollectionModel | null;
  collectionSource: PaymentInfoSource | null;
  providerPaymentStatusRaw: string | null;
  providerPaymentStatus: ProviderPaymentStatus | null;
  payoutStatusRaw: string | null;
  payoutStatus: PayoutStatus | null;
  payoutDate: Date | null;
  commissionAmount: number | null;
  netAmount: number | null;
  paymentInfoUpdatedAt: Date | null;
}

export const NO_PAYMENT_INFO: PaymentInfoColumns = {
  collectionModel: null,
  collectionSource: null,
  providerPaymentStatusRaw: null,
  providerPaymentStatus: null,
  payoutStatusRaw: null,
  payoutStatus: null,
  payoutDate: null,
  commissionAmount: null,
  netAmount: null,
  paymentInfoUpdatedAt: null,
};

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
const minor = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);

/** True when a provider-reported field is present (a collection model alone does not count). */
export const hasProviderPaymentFields = (c: PaymentInfoColumns): boolean =>
  c.providerPaymentStatusRaw !== null ||
  c.providerPaymentStatus !== null ||
  c.payoutStatusRaw !== null ||
  c.payoutStatus !== null ||
  c.payoutDate !== null ||
  c.commissionAmount !== null ||
  c.netAmount !== null;

/**
 * Turns whatever an adapter supplied into storable columns, dropping anything that cannot be backed up:
 *  - a collection claim without a source is dropped (provenance is mandatory);
 *  - values outside the allowed lists, negative or fractional money and unparseable dates are dropped, not repaired.
 * Nothing is ever defaulted: a missing field stays NULL, which the product shows as "not reported".
 */
export function normalizePaymentInfo(info: ChannelPaymentInfo | undefined | null, now: Date = new Date()): PaymentInfoColumns {
  if (!info) return { ...NO_PAYMENT_INFO };
  const source = oneOf<PaymentInfoSource>(['PROVIDER', 'OPERATOR_CONFIG'], info.collectionSource);
  const model = source ? oneOf(COLLECTION_MODELS, info.collectedBy) : null;
  const cols: PaymentInfoColumns = {
    collectionModel: model,
    collectionSource: model ? source : null,
    providerPaymentStatusRaw: text(info.providerStatusRaw),
    providerPaymentStatus: oneOf(PROVIDER_PAYMENT_STATUSES, info.providerStatus),
    payoutStatusRaw: text(info.payoutStatusRaw),
    payoutStatus: oneOf(PAYOUT_STATUSES, info.payoutStatus),
    payoutDate: info.payoutDate instanceof Date && !Number.isNaN(info.payoutDate.getTime()) ? info.payoutDate : null,
    commissionAmount: minor(info.commissionAmount),
    netAmount: minor(info.netAmount),
    paymentInfoUpdatedAt: null,
  };
  if (!model && !hasProviderPaymentFields(cols)) return { ...NO_PAYMENT_INFO };
  cols.paymentInfoUpdatedAt = hasProviderPaymentFields(cols) ? now : null;
  return cols;
}

/**
 * The reservation payment status a NEW channel booking starts with:
 *  - the channel collects (declared or reported) -> CHANNEL_COLLECTED, which means "the channel is responsible for collection". It does
 *    NOT mean the guest has paid; the provider's own status, when reported, is stored separately;
 *  - the property collects -> UNPAID (the guest still owes the property);
 *  - nothing known -> UNKNOWN.
 */
export function initialChannelPaymentStatus(cols: Pick<PaymentInfoColumns, 'collectionModel'>): 'CHANNEL_COLLECTED' | 'UNPAID' | 'UNKNOWN' {
  if (cols.collectionModel === 'CHANNEL') return 'CHANNEL_COLLECTED';
  if (cols.collectionModel === 'PROPERTY') return 'UNPAID';
  return 'UNKNOWN';
}
