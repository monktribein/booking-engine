import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockFetch, ok, type RecordedCall } from './helpers';
import { mapChannelPayment, mapReservation } from '@/lib/api/mappers';
import { describePayment, isChannelBooking } from '@/lib/utils/payment-visibility';
import { PaymentVisibilityPanel } from '@/components/payments/PaymentVisibilityPanel';
import PaymentsPage from '@/app/dashboard/payments/page';
import { Reservation, ReservationPaymentStatus, ReservationStatus } from '@/types';

vi.mock('@/lib/auth/property-context', () => ({
  useProperty: () => ({ activeProperty: { _id: 'p1', name: 'Radha Ashram', currency: 'INR', timezone: 'Asia/Kolkata' }, isLoading: false, error: null, reloadProperties: vi.fn() }),
}));

const base = (over: Partial<Reservation> = {}): Reservation =>
  ({
    _id: 'r1',
    propertyId: 'p1',
    code: 'TRV-AAAA1111',
    source: 'AIRBNB',
    status: ReservationStatus.CONFIRMED,
    paymentStatus: ReservationPaymentStatus.UNKNOWN,
    guest: { _id: 'g', propertyId: 'p1', firstName: 'Asha', lastName: 'Verma' },
    checkIn: '2027-03-10',
    checkOut: '2027-03-12',
    adults: 2,
    rooms: [],
    subtotal: 800000,
    taxAmount: 0,
    discountAmount: 0,
    total: 800000,
    currency: 'INR',
    amountPaid: 0,
    amountRefunded: 0,
    ...over,
  }) as Reservation;

const ALL_LINES = (r: Reservation) => {
  const v = describePayment(r);
  return [v.summary, v.providerStatus, v.payout, v.commission, v.net, v.refund];
};

describe('describePayment: unreported data is never shown as paid or collected', () => {
  it.each(['AIRBNB', 'BOOKING_COM', 'AGODA', 'MOCK', 'ICAL', 'CSV_IMPORT', 'ACME_STAY'])('a %s booking with nothing reported is Unavailable everywhere', (source) => {
    const v = describePayment(base({ source: source as never }));
    expect(v.isChannel).toBe(true);
    expect(v.summary).toMatchObject({ label: 'Unavailable', tone: 'muted' });
    for (const line of [v.providerStatus, v.payout, v.commission, v.net]) expect(line.label).toBe('Unavailable');
    expect(v.balanceDue.known).toBe(false);
    for (const line of ALL_LINES(base({ source: source as never }))) expect(line.label).not.toMatch(/\b(paid|collected|completed|pending)\b/i);
  });

  it('a historical UNKNOWN row with a stray amount of 0 does not become "unpaid" or "paid"', () => {
    const v = describePayment(base({ amountPaid: 0 }));
    expect(v.summary.label).toBe('Unavailable');
  });

  it('"collected by channel" is a declaration unless the channel reported it, and never says the guest paid', () => {
    const declared = describePayment(base({ paymentStatus: ReservationPaymentStatus.CHANNEL_COLLECTED, channelPayment: { collectionModel: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG' } }));
    expect(declared.summary.label).toBe('Collected by channel');
    expect(declared.summary.detail).toMatch(/Declared in the Airbnb provider configuration/);
    expect(declared.summary.detail).toMatch(/has not reported that the guest paid/);
    expect(declared.providerStatus.label).toBe('Unavailable');
    expect(declared.payout.label).toBe('Unavailable');
    expect(declared.balanceDue.known).toBe(false);
    const reported = describePayment(base({ paymentStatus: ReservationPaymentStatus.CHANNEL_COLLECTED, channelPayment: { collectionModel: 'CHANNEL', collectionSource: 'PROVIDER' } }));
    expect(reported.summary.detail).toMatch(/Airbnb reported that it collects/);
    expect(reported.providerStatus.label).toBe('Unavailable');
  });

  it('shows the provider status, payout, commission and net exactly as reported, with their source', () => {
    const v = describePayment(
      base({
        paymentStatus: ReservationPaymentStatus.CHANNEL_COLLECTED,
        channelPayment: { collectionModel: 'CHANNEL', collectionSource: 'PROVIDER', providerPaymentStatus: 'PAID', providerPaymentStatusRaw: 'captured', payoutStatus: 'COMPLETED', payoutDate: '2027-03-20T00:00:00.000Z', commissionAmount: 123400, netAmount: 676600 },
      }),
    );
    expect(v.providerStatus).toMatchObject({ label: 'Paid', tone: 'good' });
    expect(v.providerStatus.detail).toMatch(/Reported by Airbnb as "captured"/);
    expect(v.payout.label).toMatch(/^Payout completed on /);
    expect(v.commission.label).toBe('₹1,234');
    expect(v.net.label).toBe('₹6,766');
  });

  it('distinguishes payout pending, payout failed and a word nobody mapped (shown raw, not interpreted)', () => {
    const cp = (c: object) => describePayment(base({ paymentStatus: ReservationPaymentStatus.CHANNEL_COLLECTED, channelPayment: { collectionModel: 'CHANNEL', collectionSource: 'PROVIDER', ...c } }));
    expect(cp({ payoutStatus: 'PENDING' }).payout.label).toBe('Payout pending');
    expect(cp({ payoutStatus: 'FAILED' }).payout).toMatchObject({ label: 'Payout failed', tone: 'bad' });
    const raw = cp({ providerPaymentStatusRaw: 'settled-ish', payoutStatusRaw: 'queued' });
    expect(raw.providerStatus).toMatchObject({ label: '"settled-ish"', tone: 'muted' });
    expect(raw.providerStatus.detail).toMatch(/no mapping/);
    expect(raw.payout).toMatchObject({ label: '"queued"', tone: 'muted' });
  });

  it('property collection is its own state, and a payment recorded here does not claim the channel reported it', () => {
    const declared = describePayment(base({ paymentStatus: ReservationPaymentStatus.UNPAID, channelPayment: { collectionModel: 'PROPERTY', collectionSource: 'OPERATOR_CONFIG' } }));
    expect(declared.summary.label).toBe('Property collects');
    expect(declared.balanceDue).toEqual({ known: true, amount: 800000 });
    const recorded = describePayment(base({ paymentStatus: ReservationPaymentStatus.PAID, amountPaid: 800000 }));
    expect(recorded.summary.label).toBe('Paid to property');
    expect(recorded.summary.detail).toMatch(/Payments recorded in Tirvona.*Airbnb has not said who collects/);
    expect(recorded.providerStatus.label).toBe('Unavailable');
  });

  it('refunds: a cancelled channel booking is never shown as refunded unless a refund was recorded or reported', () => {
    const cancelled = describePayment(base({ status: ReservationStatus.CANCELLED, paymentStatus: ReservationPaymentStatus.CHANNEL_COLLECTED, channelPayment: { collectionModel: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG' } }));
    expect(cancelled.refund.label).toBe('Unavailable');
    expect(cancelled.refund.detail).toMatch(/Whether Airbnb refunded the guest has not been reported/);
    const unknown = describePayment(base({ status: ReservationStatus.CANCELLED }));
    expect(unknown.refund.label).toBe('Unavailable');
    expect(describePayment(base({ channelPayment: { collectionModel: 'CHANNEL', collectionSource: 'PROVIDER', providerPaymentStatus: 'REFUNDED' } })).refund.label).toBe('Refunded');
    expect(describePayment(base({ status: ReservationStatus.CANCELLED, amountPaid: 800000, amountRefunded: 800000, paymentStatus: ReservationPaymentStatus.REFUNDED })).refund.label).toBe('Refunded ₹8,000');
  });

  it('bookings owned by Tirvona keep their ledger wording (direct payments are unchanged)', () => {
    const direct = (over: Partial<Reservation>) => describePayment(base({ source: 'DIRECT' as never, ...over }));
    expect(isChannelBooking('DIRECT')).toBe(false);
    expect(direct({ paymentStatus: ReservationPaymentStatus.PAID, amountPaid: 800000 }).summary.label).toBe('Paid by guest');
    expect(direct({ paymentStatus: ReservationPaymentStatus.UNPAID }).summary.label).toBe('Unpaid');
    expect(direct({ paymentStatus: ReservationPaymentStatus.PARTIALLY_PAID, amountPaid: 100 }).balanceDue).toEqual({ known: true, amount: 799900 });
    expect(direct({ paymentStatus: ReservationPaymentStatus.PAID }).payout.label).toBe('Not applicable');
  });
});

describe('mapChannelPayment', () => {
  it('leaves null columns undefined and returns nothing when nothing was reported', () => {
    expect(mapChannelPayment({ collectionModel: null, collectionSource: null, commissionAmount: null })).toBeUndefined();
    expect(mapChannelPayment({})).toBeUndefined();
    expect(mapChannelPayment({ collectionModel: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG', netAmount: null })).toEqual({ collectionModel: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG' });
    expect(mapChannelPayment({ commissionAmount: 0 })).toEqual({ commissionAmount: 0 }); // a reported zero is information
  });

  it('a raw reservation without payment columns maps to UNKNOWN-capable data, not a default', () => {
    const r = mapReservation({ _id: 'r', propertyId: 'p', reservationCode: 'TRV-1', source: 'AIRBNB', status: 'CONFIRMED', paymentStatus: 'UNKNOWN', guest: {}, checkIn: '2027-01-01', checkOut: '2027-01-02', subtotal: 1, tax: 0, discount: 0, total: 1, currency: 'INR', reservationRooms: [] });
    expect(r.paymentStatus).toBe('UNKNOWN');
    expect(r.channelPayment).toBeUndefined();
  });
});

describe('PaymentVisibilityPanel', () => {
  it('marks every unreported value as unavailable and offers no paid/collected wording for a channel booking', () => {
    render(<PaymentVisibilityPanel reservation={base()} />);
    const region = screen.getByRole('region', { name: 'Payment visibility' });
    expect(within(region).getByText('Channel payment (read-only)')).toBeInTheDocument();
    expect(region.querySelectorAll('[data-unavailable="true"]').length).toBeGreaterThanOrEqual(6); // collection, status, payout, commission, net, refund, balance
    expect(within(region).queryByText(/^Paid/)).toBeNull();
    expect(within(region).queryByText(/Collected by channel/)).toBeNull();
    expect(within(region).getByText(/It is not known whether the guest still owes the property anything/)).toBeInTheDocument();
  });

  it('shows reported values with their source', () => {
    render(<PaymentVisibilityPanel reservation={base({ paymentStatus: ReservationPaymentStatus.CHANNEL_COLLECTED, channelPayment: { collectionModel: 'CHANNEL', collectionSource: 'PROVIDER', payoutStatus: 'PENDING', commissionAmount: 50000 } })} />);
    const region = screen.getByRole('region', { name: 'Payment visibility' });
    expect(within(region).getByText('Collected by channel')).toBeInTheDocument();
    expect(within(region).getByText('Payout pending')).toBeInTheDocument();
    expect(within(region).getByText('₹500')).toBeInTheDocument();
    expect(within(region).getAllByText(/Reported by Airbnb/).length).toBeGreaterThanOrEqual(2);
  });

  it('a direct booking shows its ledger state and no channel rows', () => {
    render(<PaymentVisibilityPanel reservation={base({ source: 'DIRECT' as never, paymentStatus: ReservationPaymentStatus.PAID, amountPaid: 800000 })} />);
    const region = screen.getByRole('region', { name: 'Payment visibility' });
    expect(within(region).getByText('Paid by guest')).toBeInTheDocument();
    expect(within(region).queryByText('Payout')).toBeNull();
  });
});

describe('payments page', () => {
  const raw = (over: Record<string, unknown>) => ({
    _id: 'r1', propertyId: 'p1', reservationCode: 'TRV-AAAA1111', source: 'AIRBNB', status: 'CONFIRMED', paymentStatus: 'UNKNOWN', guest: { firstName: 'Asha', lastName: 'Verma' },
    checkIn: '2027-03-10', checkOut: '2027-03-12', adults: 2, subtotal: 800000, tax: 0, discount: 0, total: 800000, currency: 'INR', amountPaid: 0, amountRefunded: 0, reservationRooms: [],
    collectionModel: null, collectionSource: null, ...over,
  });
  const renderPage = (items: unknown[]) => {
    mockFetch((c: RecordedCall) => {
      const p = new URL(c.url).pathname;
      if (p.endsWith('/reservations')) return ok({ items, page: 1, limit: 20, total: items.length });
      if (p.includes('/payments')) return ok([]);
      return ok({});
    });
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PaymentsPage />
      </QueryClientProvider>,
    );
  };

  it('lists an unreported channel booking as Unavailable (status and balance), never as unpaid, paid or collected', async () => {
    renderPage([raw({})]);
    const row = (await screen.findByText('TRV-AAAA1111')).closest('tr')!;
    expect(within(row).getAllByText('Unavailable').length).toBe(2);
    expect(within(row).queryByText(/^(Unpaid|Paid|Collected)/)).toBeNull();
    expect(within(row).getByText('Channel booking')).toBeInTheDocument();
  });

  it('the drawer of a channel-collected booking shows the panel and does not offer to record a payment', async () => {
    const user = userEvent.setup();
    renderPage([raw({ paymentStatus: 'CHANNEL_COLLECTED', collectionModel: 'CHANNEL', collectionSource: 'OPERATOR_CONFIG' })]);
    await user.click(await screen.findByRole('button', { name: /Payments for TRV-AAAA1111/ }));
    const region = await screen.findByRole('region', { name: 'Payment visibility' });
    expect(within(region).getByText('Collected by channel')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Record Payment/ })).toBeDisabled());
  });
});
