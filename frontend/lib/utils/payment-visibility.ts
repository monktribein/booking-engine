/**
 * How the dashboard describes the money of a reservation. Pure functions, no I/O.
 *
 * The rule: a state is only shown when something reliable backs it. A channel booking whose payment the channel did not report is
 * "Unavailable", never "Paid", "Unpaid" or "Collected". Every description says where it comes from.
 */
import { Reservation, ReservationPaymentStatus, ReservationSource, ReservationStatus } from '@/types';
import { formatCurrency } from '@/lib/utils/currency';
import { formatDate } from '@/lib/utils/dates';

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

export interface Line {
  label: string;
  tone: Tone;
  /** Where this comes from, or why it is unavailable. */
  detail: string;
}

export interface PaymentVisibility {
  /** True for a booking owned by an external channel (an OTA, a configured provider, an iCal feed, an import). */
  isChannel: boolean;
  /** The headline: who collects and in what state. */
  summary: Line;
  /** What the channel itself says about the payment (channel bookings only). */
  providerStatus: Line;
  payout: Line;
  commission: Line;
  net: Line;
  refund: Line;
  /** The balance the property is owed, only when it can be known. */
  balanceDue: { known: boolean; amount: number };
}

const NOT_CHANNEL: ReadonlySet<string> = new Set([
  ReservationSource.TIRVONA,
  ReservationSource.DIRECT,
  ReservationSource.API,
  ReservationSource.WALK_IN,
  ReservationSource.PHONE,
  ReservationSource.AGENT,
  ReservationSource.OTHER,
]);

export const isChannelBooking = (source: string): boolean => !NOT_CHANNEL.has(source);

const sourceName = (source: string): string => source.replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const UNAVAILABLE = (why: string): Line => ({ label: 'Unavailable', tone: 'muted', detail: why });

const PROVIDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  UNPAID: { label: 'Not paid', tone: 'warn' },
  PAID: { label: 'Paid', tone: 'good' },
  PARTIALLY_PAID: { label: 'Partially paid', tone: 'warn' },
  REFUNDED: { label: 'Refunded', tone: 'muted' },
  PARTIALLY_REFUNDED: { label: 'Partially refunded', tone: 'muted' },
  FAILED: { label: 'Payment failed', tone: 'bad' },
};

export function describePayment(r: Reservation): PaymentVisibility {
  const isChannel = isChannelBooking(r.source);
  const cp = r.channelPayment;
  const who = sourceName(r.source);
  const paid = r.amountPaid ?? 0;
  const refunded = r.amountRefunded ?? 0;
  const cancelled = r.status === ReservationStatus.CANCELLED;

  // ---- bookings owned by Tirvona: the payments recorded here are the facts
  if (!isChannel) {
    const ledger: Record<string, Line> = {
      [ReservationPaymentStatus.UNPAID]: { label: 'Unpaid', tone: 'warn', detail: 'Nothing recorded in Tirvona yet' },
      [ReservationPaymentStatus.PARTIALLY_PAID]: { label: 'Partially paid', tone: 'warn', detail: 'Payments recorded in Tirvona' },
      [ReservationPaymentStatus.PAID]: { label: 'Paid by guest', tone: 'good', detail: 'Payments recorded in Tirvona' },
      [ReservationPaymentStatus.PARTIALLY_REFUNDED]: { label: 'Partially refunded', tone: 'muted', detail: 'Refunds recorded in Tirvona' },
      [ReservationPaymentStatus.REFUNDED]: { label: 'Refunded', tone: 'muted', detail: 'Refunds recorded in Tirvona' },
    };
    const summary = ledger[r.paymentStatus] ?? UNAVAILABLE('This payment status is not recognised');
    const na = (what: string): Line => ({ label: 'Not applicable', tone: 'muted', detail: `${what} applies to channel bookings only` });
    return {
      isChannel,
      summary,
      providerStatus: na('A channel payment status'),
      payout: na('Payout information'),
      commission: na('Commission'),
      net: na('Net amount'),
      refund: refunded > 0 ? { label: `Refunded ${formatCurrency(refunded, r.currency)}`, tone: 'muted', detail: 'Refunds recorded in Tirvona' } : { label: 'No refund', tone: 'muted', detail: 'No refund recorded in Tirvona' },
      balanceDue: { known: true, amount: Math.max(0, r.total - (paid - refunded)) },
    };
  }

  // ---- channel bookings: only what was reported or declared
  let summary: Line;
  if (r.paymentStatus === ReservationPaymentStatus.CHANNEL_COLLECTED && cp?.collectionModel === 'CHANNEL') {
    summary = {
      label: 'Collected by channel',
      tone: 'muted',
      detail: cp.collectionSource === 'PROVIDER' ? `${who} reported that it collects the payment` : `Declared in the ${who} provider configuration. ${who} has not reported that the guest paid`,
    };
  } else if (cp?.collectionModel === 'PROPERTY') {
    summary = {
      label: paid > 0 ? (paid >= r.total ? 'Paid to property' : 'Partly paid to property') : 'Property collects',
      tone: paid >= r.total && paid > 0 ? 'good' : 'warn',
      detail: cp.collectionSource === 'PROVIDER' ? `${who} reported that the guest pays the property` : `Declared in the ${who} provider configuration. Payments recorded in Tirvona: ${formatCurrency(paid, r.currency)}`,
    };
  } else if (paid > 0 && (r.paymentStatus === ReservationPaymentStatus.PAID || r.paymentStatus === ReservationPaymentStatus.PARTIALLY_PAID)) {
    summary = { label: r.paymentStatus === ReservationPaymentStatus.PAID ? 'Paid to property' : 'Partly paid to property', tone: 'good', detail: `Payments recorded in Tirvona (${formatCurrency(paid, r.currency)}); ${who} has not said who collects` };
  } else {
    summary = UNAVAILABLE(`${who} has not reported who collects the payment, and nothing is recorded in Tirvona`);
  }

  const providerStatus: Line = (() => {
    if (cp?.providerPaymentStatus) {
      const m = PROVIDER_STATUS[cp.providerPaymentStatus];
      return { label: m.label, tone: m.tone, detail: `Reported by ${who}${cp.providerPaymentStatusRaw ? ` as "${cp.providerPaymentStatusRaw}"` : ''}` };
    }
    if (cp?.providerPaymentStatusRaw) return { label: `"${cp.providerPaymentStatusRaw}"`, tone: 'muted', detail: `Reported by ${who}; Tirvona has no mapping for this word, so it is not interpreted` };
    return UNAVAILABLE(`${who} has not reported a payment status for this booking`);
  })();

  const payout: Line = (() => {
    if (cp?.payoutStatus) {
      const date = cp.payoutDate ? ` on ${formatDate(cp.payoutDate)}` : '';
      if (cp.payoutStatus === 'COMPLETED') return { label: `Payout completed${date}`, tone: 'good', detail: `Reported by ${who}` };
      if (cp.payoutStatus === 'PENDING') return { label: `Payout pending${date}`, tone: 'warn', detail: `Reported by ${who}` };
      return { label: 'Payout failed', tone: 'bad', detail: `Reported by ${who}` };
    }
    if (cp?.payoutStatusRaw) return { label: `"${cp.payoutStatusRaw}"`, tone: 'muted', detail: `Reported by ${who}; Tirvona has no mapping for this word, so it is not interpreted` };
    return UNAVAILABLE(`${who} has not reported payout information`);
  })();

  const money = (v: number | undefined, what: string): Line =>
    v === undefined ? UNAVAILABLE(`${who} has not reported the ${what}`) : { label: formatCurrency(v, r.currency), tone: 'muted', detail: `Reported by ${who}` };

  const refund: Line = (() => {
    if (cp?.providerPaymentStatus === 'REFUNDED' || cp?.providerPaymentStatus === 'PARTIALLY_REFUNDED') {
      return { label: PROVIDER_STATUS[cp.providerPaymentStatus].label, tone: 'muted', detail: `Reported by ${who}` };
    }
    if (refunded > 0) return { label: `Refunded ${formatCurrency(refunded, r.currency)}`, tone: 'muted', detail: 'Refunds recorded in Tirvona' };
    if (cancelled) return UNAVAILABLE(`The booking is cancelled. Whether ${who} refunded the guest has not been reported`);
    return { label: 'No refund', tone: 'muted', detail: 'No refund recorded or reported' };
  })();

  // The property is owed a balance only when it is known to collect; otherwise there is no number to show.
  const propertyCollects = cp?.collectionModel === 'PROPERTY' || paid > 0;
  return {
    isChannel,
    summary,
    providerStatus,
    payout,
    commission: money(cp?.commissionAmount, 'commission'),
    net: money(cp?.netAmount, 'net amount'),
    refund,
    balanceDue: { known: propertyCollects, amount: Math.max(0, r.total - (paid - refunded)) },
  };
}

/** The short text for a table cell. */
export const paymentSummaryLabel = (r: Reservation): string => describePayment(r).summary.label;

export const toneClass = (t: Tone): string =>
  t === 'good'
    ? 'text-emerald-700 dark:text-emerald-400'
    : t === 'warn'
      ? 'text-amber-700 dark:text-amber-400'
      : t === 'bad'
        ? 'text-rose-700 dark:text-rose-400'
        : 'text-slate-600 dark:text-slate-400';

