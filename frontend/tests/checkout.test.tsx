import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fail, mockFetch, ok } from './helpers';

const push = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useParams: () => ({ propertySlug: 'radha-ashram' }),
  useSearchParams: () => search,
}));

type Callbacks = { onSuccess: (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => void; onDismiss: () => void; onFailure: (m: string) => void };
const openRazorpay = vi.fn<(params: unknown, name: string, cb: Callbacks) => Promise<void>>();
vi.mock('@/lib/payments/razorpay-checkout', () => ({ openRazorpayCheckout: (...a: Parameters<typeof openRazorpay>) => openRazorpay(...a) }));

import BookingCheckoutPage from '@/app/booking/[propertySlug]/page';

const property = { slug: 'radha-ashram', name: 'Radha Ashram', description: 'd', address: 'a', city: 'c', state: 's', country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', checkInTime: '12:00', checkOutTime: '10:00', taxPercent: 5, amenities: [], images: [], roomTypes: [{ _id: 'rt1', name: 'Deluxe', maxOccupancy: 3, amenities: [], images: [], fromPrice: 350000 }] };
const availability = [
  {
    roomTypeId: 'rt1', name: 'Deluxe', maxOccupancy: 3, availableUnits: 5, bookable: true, reasons: [],
    ratePlans: [{ ratePlanId: 'rp1', code: 'STD', name: 'Standard Flexible', mealPlan: 'ROOM_ONLY', cancellationPolicy: { description: 'Free cancellation' }, nightly: 350000, subtotal: 700000, tax: 35000, discount: 0, total: 735000 }],
  },
];
const holdIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const checkoutParams = { provider: 'RAZORPAY', keyId: 'rzp_test_public', orderId: 'order_ABC123456', amount: 735000, currency: 'INR', reservationCode: 'TRV-AAAA1111', prefill: {} };
const pendingResult = (hold = holdIn(20 * 60_000)) => ({
  reservation: { reservationCode: 'TRV-AAAA1111', status: 'PENDING', propertyName: 'Radha Ashram', checkIn: '2026-11-01', checkOut: '2026-11-03', nights: 2, adults: 2, children: 0, rooms: [], subtotal: 700000, tax: 35000, discount: 0, total: 735000, currency: 'INR', paymentStatus: 'UNPAID', holdExpiresAt: hold },
  payment: checkoutParams,
  created: true,
});

type Handlers = { create?: (n: number) => Response; verify?: (n: number) => Response };
function setup(h: Handlers = {}) {
  let creates = 0;
  let verifies = 0;
  const f = mockFetch((c) => {
    if (c.url.includes('/public/properties/radha-ashram/availability')) return ok(availability);
    if (c.url.includes('/public/properties/radha-ashram')) return ok(property);
    if (c.url.endsWith('/public/reservations') && c.method === 'POST') return (h.create ?? (() => ok(pendingResult(), 201)))(++creates);
    if (c.url.endsWith('/payments/verify')) return (h.verify ?? (() => ok({ payment: {}, reservation: { reservationCode: 'TRV-AAAA1111', status: 'CONFIRMED', paymentStatus: 'PAID' } })))(++verifies);
    return fail(404, 'NOT_FOUND', c.url);
  });
  search = new URLSearchParams({ roomTypeId: 'rt1', ratePlanId: 'rp1', checkIn: '2026-11-01', checkOut: '2026-11-03', adults: '2', children: '0' });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BookingCheckoutPage />
    </QueryClientProvider>
  );
  return f;
}

async function fillAndReserve() {
  const user = userEvent.setup();
  await screen.findByText('Standard Flexible'); // server quote is on screen
  await user.type(screen.getByLabelText(/first name/i), 'Priya');
  await user.type(screen.getByLabelText(/last name/i), 'Sharma');
  await user.type(screen.getByLabelText(/phone/i), '+91 98765 43210');
  await user.type(screen.getByLabelText(/email/i), 'Priya@Example.com');
  await user.click(screen.getByRole('button', { name: /reserve & pay/i }));
  return user;
}

beforeEach(() => {
  push.mockReset();
  openRazorpay.mockReset();
  openRazorpay.mockResolvedValue(undefined);
});

describe('public checkout (Razorpay)', () => {
  it('shows the SERVER quote (no client-side price maths)', async () => {
    setup();
    expect(await screen.findByText('Standard Flexible')).toBeInTheDocument();
    expect(screen.getAllByText(/7,350/).length).toBeGreaterThan(0); // 735000 paise total as formatted by the app
  });

  it('creates ONE hold with an Idempotency-Key, normalised guest data, then opens Checkout with the server order', async () => {
    const f = setup();
    await fillAndReserve();
    await waitFor(() => expect(openRazorpay).toHaveBeenCalledTimes(1));
    const create = f.calls.find((c) => c.url.endsWith('/public/reservations'))!;
    expect(create.headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    const body = JSON.parse(create.body!);
    expect(body.guest).toMatchObject({ phone: '+919876543210', email: 'priya@example.com' });
    expect(body.rooms).toEqual([{ roomTypeId: 'rt1', ratePlanId: 'rp1', quantity: 1 }]);
    expect(openRazorpay.mock.calls[0][0]).toMatchObject({ orderId: 'order_ABC123456', keyId: 'rzp_test_public' });
    expect(f.count('/payments/verify')).toBe(0); // opening Checkout confirms nothing
  });

  it('a double-click on Reserve creates a single reservation', async () => {
    const f = setup({ create: () => ok(pendingResult(), 201) });
    const user = await fillAndReserve();
    const btn = screen.queryByRole('button', { name: /reserve & pay/i });
    if (btn) await user.click(btn);
    await waitFor(() => expect(openRazorpay).toHaveBeenCalled());
    expect(f.count('/public/reservations')).toBe(1);
  });

  it('payment success: sends the three Razorpay values to the server for verification, then goes to confirmation', async () => {
    const f = setup();
    await fillAndReserve();
    await waitFor(() => expect(openRazorpay).toHaveBeenCalled());
    const cb = openRazorpay.mock.calls[0][2];
    await act(async () => cb.onSuccess({ razorpay_order_id: 'order_ABC123456', razorpay_payment_id: 'pay_XYZ123456', razorpay_signature: 's'.repeat(64) }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/booking/radha-ashram/confirmation?code=TRV-AAAA1111'));
    const verify = f.calls.find((c) => c.url.endsWith('/payments/verify'))!;
    expect(JSON.parse(verify.body!)).toEqual({ razorpayOrderId: 'order_ABC123456', razorpayPaymentId: 'pay_XYZ123456', razorpaySignature: 's'.repeat(64) });
    expect(verify.headers.Authorization).toBeUndefined(); // guest, anonymous
  });

  it('does NOT navigate to confirmation when the server rejects verification; retry re-sends only the verification', async () => {
    const f = setup({
      verify: (n) => (n === 1 ? fail(400, 'PAYMENT_SIGNATURE_INVALID', 'Payment signature verification failed') : ok({ payment: {}, reservation: { reservationCode: 'TRV-AAAA1111', status: 'CONFIRMED', paymentStatus: 'PAID' } })),
    });
    await fillAndReserve();
    await waitFor(() => expect(openRazorpay).toHaveBeenCalled());
    await act(async () => openRazorpay.mock.calls[0][2].onSuccess({ razorpay_order_id: 'order_ABC123456', razorpay_payment_id: 'pay_1', razorpay_signature: 'f'.repeat(64) }));
    expect(await screen.findByText(/could not confirm your payment/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /retry confirmation/i }));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(f.count('/payments/verify')).toBe(2);
    expect(f.count('/public/reservations')).toBe(1); // never a second booking
  });

  it('cancelled checkout window keeps the hold and lets the guest pay again without creating another booking', async () => {
    const f = setup();
    await fillAndReserve();
    await waitFor(() => expect(openRazorpay).toHaveBeenCalledTimes(1));
    await act(async () => openRazorpay.mock.calls[0][2].onDismiss());
    expect(await screen.findByText(/payment was not completed/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /pay now/i }));
    await waitFor(() => expect(openRazorpay).toHaveBeenCalledTimes(2));
    expect(openRazorpay.mock.calls[1][0]).toMatchObject({ orderId: 'order_ABC123456' }); // same order
    expect(f.count('/public/reservations')).toBe(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('failed payment shows the gateway message and stays on the page', async () => {
    setup();
    await fillAndReserve();
    await waitFor(() => expect(openRazorpay).toHaveBeenCalled());
    await act(async () => openRazorpay.mock.calls[0][2].onFailure('Your bank declined the payment'));
    expect(await screen.findByText(/bank declined/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('inventory conflict: shows the server message, keeps the typed details, creates nothing', async () => {
    setup({ create: () => fail(409, 'ROOM_NOT_AVAILABLE', 'Deluxe is no longer available for these dates') });
    await fillAndReserve();
    expect(await screen.findByText(/no longer available for these dates/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/first name/i)).toHaveValue('Priya');
    expect(openRazorpay).not.toHaveBeenCalled();
  });

  it('a network error on create can be retried and reuses the SAME Idempotency-Key', async () => {
    let n = 0;
    const f = mockFetchFlaky(() => ++n);
    void f;
    await fillAndReserve();
    expect(await screen.findByText(/cannot reach|unable to reach/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /reserve & pay/i }));
    await waitFor(() => expect(openRazorpay).toHaveBeenCalled());
    const keys = f.calls.filter((c) => c.url.endsWith('/public/reservations')).map((c) => c.headers['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('server confirms immediately (no online payment required): goes straight to confirmation, Checkout never opens', async () => {
    setup({ create: () => ok({ ...pendingResult(), reservation: { ...pendingResult().reservation, status: 'CONFIRMED', holdExpiresAt: null }, payment: null }, 201) });
    await fillAndReserve();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/booking/radha-ashram/confirmation?code=TRV-AAAA1111'));
    expect(openRazorpay).not.toHaveBeenCalled();
  });

  it('hold expiry: after the countdown the page says so and no longer offers to pay', async () => {
    setup({ create: () => ok(pendingResult(holdIn(1500)), 201) });
    await fillAndReserve();
    await waitFor(() => expect(openRazorpay).toHaveBeenCalled());
    await act(async () => openRazorpay.mock.calls[0][2].onDismiss());
    expect(await screen.findByText(/your hold has expired/i, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay now/i })).not.toBeInTheDocument();
  });
});

/** Like setup(), but the first POST /public/reservations fails at the network level. */
function mockFetchFlaky(counter: () => number) {
  const f = mockFetch((c) => {
    if (c.url.includes('/availability')) return ok(availability);
    if (c.url.includes('/public/properties/radha-ashram')) return ok(property);
    if (c.url.endsWith('/public/reservations')) {
      if (counter() === 1) throw new TypeError('fetch failed');
      return ok(pendingResult(), 201);
    }
    return fail(404, 'NOT_FOUND', c.url);
  });
  search = new URLSearchParams({ roomTypeId: 'rt1', ratePlanId: 'rp1', checkIn: '2026-11-01', checkOut: '2026-11-03', adults: '2', children: '0' });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BookingCheckoutPage />
    </QueryClientProvider>
  );
  return f;
}
