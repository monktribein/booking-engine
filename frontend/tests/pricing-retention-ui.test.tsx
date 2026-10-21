import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fail, mockFetch, ok, type RecordedCall } from './helpers';
import { BookingSummaryCard } from '@/components/booking/BookingSummary';
import { RateRulesPanel, describeAdjustment, describeDays } from '@/components/rates/RateRulesPanel';
import { RetentionSection } from '@/components/settings/retention-section';
import RoomsManagementPage from '@/app/dashboard/rooms/page';

vi.mock('@/lib/auth/property-context', () => ({
  useProperty: () => ({ activeProperty: { _id: 'p1', name: 'Radha Ashram', currency: 'INR', timezone: 'Asia/Kolkata' }, isLoading: false, error: null, reloadProperties: vi.fn() }),
}));

const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>);
const path = (c: RecordedCall) => new URL(c.url).pathname;

describe('booking summary', () => {
  it('itemises extra-guest charges inside the subtotal and explains a promo that did not apply', () => {
    render(
      <BookingSummaryCard propertyName="Radha Ashram" roomTypeName="Deluxe" ratePlanName="Flexible" checkIn="2026-12-01" checkOut="2026-12-03" adults={3} currency="INR" subtotal={80000} extraGuestCharges={10000} discount={0} tax={4000} total={84000} promoProblem="Promo code is not valid: the booking must be worth at least 5000 before the discount" />,
    );
    expect(screen.getByText(/Room · 2 nights/)).toBeInTheDocument();
    expect(screen.getByText('₹700')).toBeInTheDocument(); // 80,000 - 10,000 paise
    expect(screen.getByText('Extra guests')).toBeInTheDocument();
    expect(screen.getByText('₹100')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/at least 5000/);
    expect(screen.getByText('₹840')).toBeInTheDocument(); // total, shown exactly as the server priced it
  });
});

describe('rate rule wording', () => {
  it('describes weekdays and adjustments the way a manager would say them', () => {
    expect(describeDays(null)).toBe('Every day');
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
    expect(describeDays([6, 0])).toBe('Weekends (Sat, Sun)');
    expect(describeDays([1, 3])).toBe('Mon, Wed');
    expect(describeAdjustment({ adjustment: 'FIXED', amount: 450000, percent: null }, 'INR')).toBe('₹4,500 per night');
    expect(describeAdjustment({ adjustment: 'PERCENT', amount: null, percent: 20 }, 'INR')).toBe('+20% of the base price');
    expect(describeAdjustment({ adjustment: 'PERCENT', amount: null, percent: -15 }, 'INR')).toBe('-15% of the base price');
  });
});

describe('rate rules panel', () => {
  const plans = [{ _id: 'rp1', name: 'Standard', roomTypeId: 'rt1', basePrice: 350000, currency: 'INR', isActive: true }] as never;
  const rule = { _id: 'r1', propertyId: 'p1', roomTypeId: 'rt1', ratePlanId: null, name: 'Diwali week', startDate: '2026-11-05', endDate: '2026-11-12', daysOfWeek: null, adjustment: 'FIXED', amount: 520000, percent: null, priority: 0, status: 'ACTIVE' };

  it('lists rules, previews the server price per night with the rule behind it, and sends cents to the API', async () => {
    const m = mockFetch((c) => {
      if (path(c).endsWith('/rate-rules') && c.method === 'GET') return ok([rule]);
      if (path(c).endsWith('/rate-calendar')) return ok([{ date: '2026-11-05', base: 350000, rate: 520000, ruleId: 'r1', ruleName: 'Diwali week' }, { date: '2026-11-12', base: 350000, rate: 350000, ruleId: null, ruleName: null }]);
      if (path(c).endsWith('/rate-rules') && c.method === 'POST') return ok({ ...rule, _id: 'r2', name: 'Weekend' }, 201);
      return fail(404, 'NOT_FOUND', 'x');
    });
    const user = userEvent.setup();
    wrap(<RateRulesPanel propertyId="p1" timezone="Asia/Kolkata" currency="INR" roomTypeId="rt1" roomTypeName="Deluxe" plans={plans} />);

    expect(await screen.findByText('Diwali week')).toBeInTheDocument();
    expect(screen.getByText('₹5,200 per night')).toBeInTheDocument();
    const preview = screen.getByRole('list', { name: 'Effective nightly prices' });
    expect(within(preview).getByText('Diwali week')).toBeInTheDocument();
    expect(within(preview).getByText('Base price')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New rate rule' }));
    await user.type(screen.getByLabelText('Name *'), 'Weekend');
    await user.click(screen.getByLabelText('Fri'));
    await user.click(screen.getByLabelText('Sat'));
    await user.clear(screen.getByLabelText('Nightly price (₹) *'));
    await user.type(screen.getByLabelText('Nightly price (₹) *'), '4500');
    await user.click(screen.getByRole('button', { name: 'Save rate rule' }));
    await waitFor(() => expect(m.calls.some((c) => c.method === 'POST')).toBe(true));
    const post = JSON.parse(m.calls.find((c) => c.method === 'POST')!.body!);
    expect(post).toMatchObject({ roomTypeId: 'rt1', name: 'Weekend', adjustment: 'FIXED', amount: 450000, daysOfWeek: [5, 6], priority: 0 });
  });

  it('shows the server reason when a rule would be ambiguous', async () => {
    mockFetch((c) => {
      if (c.method === 'POST') return fail(409, 'RATE_RULE_CONFLICT', 'Rule "Diwali week" already sets the price for some of these nights at the same priority.');
      if (path(c).endsWith('/rate-calendar')) return ok([]);
      return ok([]);
    });
    const user = userEvent.setup();
    wrap(<RateRulesPanel propertyId="p1" timezone="Asia/Kolkata" currency="INR" roomTypeId="rt1" roomTypeName="Deluxe" plans={plans} />);
    await user.click(await screen.findByRole('button', { name: 'New rate rule' }));
    await user.type(screen.getByLabelText('Name *'), 'Clash');
    await user.click(screen.getByRole('button', { name: 'Save rate rule' }));
    expect(await screen.findByText(/already sets the price/)).toBeInTheDocument();
  });
});

describe('data retention settings', () => {
  const overview = (over: Record<string, unknown> = {}, runs: unknown[] = []) => ({ policy: { guestAnonymizeAfterDays: null, notificationRedactAfterDays: null, inboundPayloadRedactAfterDays: null, enabled: false, approvedAt: null, awaitingApproval: false, ...over }, runs });

  it('starts unconfigured: no period is preset, nothing can be approved or run, and a saved change must be approved again', async () => {
    let policy = overview();
    const m = mockFetch((c) => {
      if (c.method === 'PUT') {
        const b = JSON.parse(c.body!);
        policy = overview({ guestAnonymizeAfterDays: b.guestAnonymizeAfterDays, notificationRedactAfterDays: b.notificationRedactAfterDays, inboundPayloadRedactAfterDays: b.inboundPayloadRedactAfterDays, awaitingApproval: true });
        return ok(policy);
      }
      return ok(policy);
    });
    const user = userEvent.setup();
    wrap(<RetentionSection onNotice={vi.fn()} />);
    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(screen.getByLabelText('Anonymise guests after (days)')).toHaveValue(null);
    expect(screen.getByRole('button', { name: 'Approve policy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview (dry run)' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Anonymise guests after (days)'), '730');
    await user.click(screen.getByRole('button', { name: 'Save periods' }));
    await waitFor(() => expect(m.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(JSON.parse(m.calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ guestAnonymizeAfterDays: 730, notificationRedactAfterDays: null, inboundPayloadRedactAfterDays: null });
    expect(await screen.findByText('Waiting for approval')).toBeInTheDocument();
  });

  it('a dry run reports counts without changing anything; "Run now" asks for confirmation and sends the confirmation phrase', async () => {
    const m = mockFetch((c) => {
      if (path(c).endsWith('/dry-run')) return ok({ dryRun: true, applied: false, summary: { guests: 4, reservations: 6, notifications: 12, inboundEvents: 3 }, moreGuests: false });
      if (path(c).endsWith('/run')) return ok({ dryRun: false, applied: true, summary: { guests: 4, reservations: 6, notifications: 12, inboundEvents: 3 }, moreGuests: false });
      return ok(overview({ guestAnonymizeAfterDays: 730, enabled: true, approvedAt: '2026-10-19T10:00:00Z' }, [{ id: 'run1', dryRun: true, triggeredBy: 'user:u1', summary: { guests: 1, reservations: 1, notifications: 0 }, createdAt: '2026-10-19T09:00:00Z' }]));
    });
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    wrap(<RetentionSection onNotice={vi.fn()} />);
    expect(await screen.findByText('Approved and active')).toBeInTheDocument();
    expect(screen.getByText(/1 guests · 1 reservations · 0 messages · 0 channel events/)).toBeInTheDocument(); // run log shows counts only

    await user.click(screen.getByRole('button', { name: 'Preview (dry run)' }));
    expect(await screen.findByText(/would anonymise 4 guest\(s\).*3 channel event payload/)).toBeInTheDocument();
    expect(m.calls.filter((c) => path(c).endsWith('/run'))).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(m.calls.filter((c) => path(c).endsWith('/run'))).toHaveLength(0); // declined: nothing sent
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(m.calls.filter((c) => path(c).endsWith('/run'))).toHaveLength(1));
    expect(JSON.parse(m.calls.find((c) => path(c).endsWith('/run'))!.body!)).toEqual({ confirm: 'ANONYMIZE' });
    confirm.mockRestore();
  });
});

describe('room retirement dialog', () => {
  const rt = { _id: 'rt1', propertyId: 'p1', name: 'Deluxe', slug: 'deluxe', maxOccupancy: 3, basePrice: 350000, currency: 'INR', totalRooms: 2, amenities: [], status: 'ACTIVE' };
  const rooms = [
    { _id: 'room1', propertyId: 'p1', roomTypeId: 'rt1', roomNumber: '101', status: 'AVAILABLE' },
    { _id: 'room9', propertyId: 'p1', roomTypeId: 'rt1', roomNumber: '109', status: 'RETIRED', retiredAt: '2026-09-01T00:00:00Z', retiredReason: 'Merged with 110' },
  ];

  it('asks the server first: shows the upcoming reservations that block it and keeps the button disabled', async () => {
    const m = mockFetch((c) => {
      if (path(c).endsWith('/room-types') && c.method === 'GET') return ok([rt]);
      if (path(c).includes('/room-types/rt1/rooms')) return ok(rooms);
      if (path(c).endsWith('/rooms/room1/retirement-check')) {
        return ok({ canRetire: false, alreadyRetired: false, occupied: false, activeBlocks: 0, upcomingReservations: [{ reservationId: 'x', reservationCode: 'TRV-ABCD1234', status: 'CONFIRMED', checkIn: '2026-12-05', checkOut: '2026-12-07' }] });
      }
      return fail(404, 'NOT_FOUND', 'x');
    });
    const user = userEvent.setup();
    wrap(<RoomsManagementPage />);
    // Retired rooms are listed separately with a Reinstate action, and are not part of the live room grid.
    expect(await screen.findByText('Retired rooms (1)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reinstate room 109' })).toBeInTheDocument();
    expect(m.calls.some((c) => c.url.includes('includeRetired=true'))).toBe(true);

    await user.click(await screen.findByRole('button', { name: /Room 101, Available/ }));
    await user.click(screen.getByRole('button', { name: /Retire room/ }));
    expect(await screen.findByText(/TRV-ABCD1234 \(2026-12-05 to 2026-12-07\)/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reason *'), 'Renovation');
    expect(screen.getByRole('button', { name: 'Retire Room' })).toBeDisabled();
    expect(m.calls.filter((c) => path(c).endsWith('/retire'))).toHaveLength(0);
  });
});
