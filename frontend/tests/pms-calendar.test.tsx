import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fail, mockFetch, ok } from './helpers';

vi.mock('@/lib/auth/property-context', () => ({
  useProperty: () => ({ activeProperty: { _id: 'p1', name: 'Radha Ashram', currency: 'INR' }, properties: [], isLoading: false, error: null, reloadProperties: vi.fn(), setActiveProperty: vi.fn() }),
}));

import { PmsCalendar } from '@/components/calendar/PmsCalendar';

// Only Date is faked, so timers, promises and React Query behave normally.
const TODAY = new Date('2026-10-14T10:00:00');

const roomTypes = [{ _id: 'rt1', propertyId: 'p1', name: 'Deluxe AC', slug: 'deluxe', maxOccupancy: 3, basePrice: 350000, currency: 'INR', totalRooms: 2, amenities: [], status: 'ACTIVE' }];
const rooms = [
  { _id: 'r101', propertyId: 'p1', roomTypeId: 'rt1', roomNumber: '101', floor: '1', status: 'AVAILABLE' },
  { _id: 'r102', propertyId: 'p1', roomTypeId: 'rt1', roomNumber: '102', floor: '1', status: 'MAINTENANCE' },
];
const calendar = (extra: Record<string, unknown> = {}) => ({
  from: '2026-10-14',
  to: '2026-10-21',
  roomTypes: [{ roomTypeId: 'rt1', name: 'Deluxe AC', days: [] }],
  reservations: [
    { _id: 'res1', reservationCode: 'TRV-AAAA1111', source: 'AIRBNB', status: 'CONFIRMED', guest: { firstName: 'Emma', lastName: 'Clarke' }, checkIn: '2026-10-15T00:00:00.000Z', checkOut: '2026-10-17T00:00:00.000Z', reservationRooms: [{ roomTypeId: 'rt1', roomId: 'r101', roomNumber: '101' }] },
    { _id: 'res2', reservationCode: 'TRV-BBBB2222', source: 'DIRECT', status: 'CONFIRMED', guest: { firstName: 'Kenji', lastName: 'Sato' }, checkIn: '2026-10-16T00:00:00.000Z', checkOut: '2026-10-17T00:00:00.000Z', reservationRooms: [{ roomTypeId: 'rt1', roomId: null, roomNumber: null }] },
  ],
  blocks: [{ _id: 'blk1', propertyId: 'p1', roomTypeId: 'rt1', roomId: 'r102', startDate: '2026-10-14T00:00:00.000Z', endDate: '2026-10-16T00:00:00.000Z', quantity: 1, reason: 'MAINTENANCE', status: 'ACTIVE' }],
  ...extra,
});
const fullReservation = { _id: 'res1', propertyId: 'p1', reservationCode: 'TRV-AAAA1111', source: 'AIRBNB', status: 'CONFIRMED', guestId: 'g1', guest: { firstName: 'Emma', lastName: 'Clarke', email: 'emma@example.com' }, checkIn: '2026-10-15T00:00:00.000Z', checkOut: '2026-10-17T00:00:00.000Z', nights: 2, adults: 2, children: 0, reservationRooms: [{ _id: 'rr1', roomTypeId: 'rt1', roomTypeName: 'Deluxe AC', roomId: 'r101', roomNumber: '101', quantity: 1, ratePlanId: 'rp', ratePlan: { name: 'Flex' }, nightlyRates: [{ date: '2026-10-15', amount: 350000 }], subtotal: 700000, tax: 35000, total: 735000 }], subtotal: 700000, tax: 35000, discount: 0, total: 735000, currency: 'INR', amountPaid: 0, amountRefunded: 0, paymentStatus: 'UNPAID', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };

let handlers: { calendar: (url: string) => Response; rooms: () => Response; reservation: () => Response; block: (body: unknown) => Response };
const defaults = () => ({
  calendar: () => ok(calendar()),
  rooms: () => ok(rooms),
  reservation: () => ok(fullReservation),
  block: () => ok({ _id: 'blkNew', propertyId: 'p1', roomTypeId: 'rt1', roomId: 'r101', startDate: '2026-10-14', endDate: '2026-10-15', quantity: 1, reason: 'MAINTENANCE', status: 'ACTIVE' }, 201),
});

function setup(over: Partial<typeof handlers> = {}) {
  handlers = { ...defaults(), ...over };
  const f = mockFetch((c) => {
    if (c.url.includes('/properties/p1/room-types')) return ok(roomTypes);
    if (c.url.includes('/room-types/rt1/rooms')) return handlers.rooms();
    if (c.url.includes('/properties/p1/inventory')) return handlers.calendar(c.url);
    if (c.url.endsWith('/inventory/block') && c.method === 'POST') return handlers.block(JSON.parse(c.body!));
    if (c.url.includes('/reservations/res1')) return handlers.reservation();
    return fail(404, 'NOT_FOUND', c.url);
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PmsCalendar />
    </QueryClientProvider>
  );
  return f;
}
const inventoryUrls = (f: ReturnType<typeof setup>) => f.calls.filter((c) => c.url.includes('/properties/p1/inventory')).map((c) => new URL(c.url).searchParams);

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: TODAY }));
afterEach(() => vi.useRealTimers());

describe('PmsCalendar: rendering', () => {
  it('shows a busy skeleton while the data loads', () => {
    mockFetch(() => new Promise<Response>(() => undefined));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PmsCalendar />
      </QueryClientProvider>
    );
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it('lists the physical rooms and places each reservation on its room and nights only', async () => {
    setup();
    const row101 = (await screen.findByText('Room 101')).closest('tr')!;
    const cells = within(row101).getAllByRole('cell');
    // week view starting today (14 Oct): columns 14,15,16,17,18,19,20. Emma (101) stays the nights of the 15th and 16th.
    expect(cells[0]).not.toHaveTextContent('Emma');
    expect(cells[1]).toHaveTextContent('Emma');
    expect(cells[2]).toHaveTextContent('Emma');
    expect(cells[3]).not.toHaveTextContent('Emma'); // check-out day is free
    expect(within(row101).getAllByRole('button', { name: /reservation TRV-AAAA1111/i })).toHaveLength(2);
    expect(within((await screen.findByText('Room 102')).closest('tr')!).queryByText(/Emma/)).toBeNull();
  });

  it('shows maintenance blocks on their nights and lets staff release them', async () => {
    const f = setup();
    const row102 = (await screen.findByText('Room 102')).closest('tr')!;
    expect(within(row102).getAllByText('MAINTENANCE')).toHaveLength(2); // nights of the 14th and 15th (end is exclusive)
    expect(within(row102).getAllByRole('button', { name: /release block on room 102/i })).toHaveLength(2);
    void f;
  });

  it('lists bookings that have no room yet so they can be assigned', async () => {
    setup();
    expect(await screen.findByText(/Bookings without an assigned room/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /TRV-BBBB2222 • Kenji Sato/ })).toBeInTheDocument();
  });

  it('the channel filter hides reservations from other channels', async () => {
    setup();
    await screen.findAllByRole('button', { name: /reservation TRV-AAAA1111/i });
    await userEvent.selectOptions(screen.getByLabelText('Channel'), 'DIRECT');
    expect(screen.queryByRole('button', { name: /reservation TRV-AAAA1111/i })).toBeNull();
  });

  it('with no rooms it says so instead of drawing an empty grid', async () => {
    setup({ rooms: () => ok([]) });
    expect(await screen.findByText('No rooms yet')).toBeInTheDocument();
  });
});

describe('PmsCalendar: date selection', () => {
  it('starts on today with a 7-day window and asks the API for exactly that range', async () => {
    const f = setup();
    await screen.findByText('Room 101');
    const q = inventoryUrls(f)[0];
    expect([q.get('from'), q.get('to')]).toEqual(['2026-10-14', '2026-10-21']);
    expect(screen.getAllByRole('columnheader')).toHaveLength(8); // rooms column + 7 days
  });

  it('Next / Previous / Today move the window by a week and refetch each time', async () => {
    const f = setup();
    await screen.findByText('Room 101');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(inventoryUrls(f).at(-1)!.get('from')).toBe('2026-10-21'));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(inventoryUrls(f).at(-1)!.get('from')).toBe('2026-10-28'));
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(inventoryUrls(f).at(-1)!.get('from')).toBe('2026-10-21'));
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(inventoryUrls(f).at(-1)!.get('from')).toBe('2026-10-14'));
  });

  it('day / week / month views show 1 / 7 / 14 nights', async () => {
    const f = setup();
    await screen.findByText('Room 101');
    await userEvent.click(screen.getByRole('tab', { name: 'day' }));
    await waitFor(() => expect(screen.getAllByRole('columnheader')).toHaveLength(2));
    expect(inventoryUrls(f).at(-1)!.get('to')).toBe('2026-10-15');
    await userEvent.click(screen.getByRole('tab', { name: 'month' }));
    await waitFor(() => expect(screen.getAllByRole('columnheader')).toHaveLength(15));
    expect(inventoryUrls(f).at(-1)!.get('to')).toBe('2026-10-28');
  });

  it('highlights today in the header', async () => {
    setup();
    await screen.findByText('Room 101');
    const header = screen.getAllByRole('columnheader')[1];
    expect(header).toHaveTextContent('14 Oct');
    expect(header.className).toMatch(/indigo/);
  });
});

describe('PmsCalendar: failures are shown, never hidden', () => {
  it('a failing calendar request shows an error with Try again (no rooms drawn from fallback data); retry recovers', async () => {
    let failing = true;
    setup({ calendar: () => (failing ? fail(500, 'INTERNAL_ERROR', 'boom') : ok(calendar())) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/server error/i);
    expect(screen.queryByText('Room 101')).toBeNull();
    failing = false;
    await userEvent.click(within(alert).getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Room 101')).toBeInTheDocument();
  });

  it('a failing rooms request is reported too', async () => {
    setup({ rooms: () => fail(503, 'UNAVAILABLE', 'down') });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Room 101')).toBeNull();
  });

  it('a 403 on the calendar is a permission message, not an empty grid', async () => {
    setup({ calendar: () => fail(403, 'FORBIDDEN', 'Your role does not allow this action') });
    expect(await screen.findByRole('alert')).toHaveTextContent(/not allowed/i);
  });
});

describe('PmsCalendar: actions', () => {
  it('opening a reservation loads the full record and shows it in the drawer; a failed load shows the error and no drawer', async () => {
    setup();
    await userEvent.click((await screen.findAllByRole('button', { name: /reservation TRV-AAAA1111/i }))[0]);
    expect(await screen.findByText('Reservation TRV-AAAA1111')).toBeInTheDocument();
  });

  it('a failed reservation load is reported', async () => {
    setup({ reservation: () => fail(500, 'INTERNAL_ERROR', 'x') });
    await userEvent.click((await screen.findAllByRole('button', { name: /reservation TRV-AAAA1111/i }))[0]);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Reservation TRV-AAAA1111')).toBeNull();
  });

  it('blocking a free night sends the right room, room type and one-night range', async () => {
    const seen: unknown[] = [];
    setup({ block: (b) => (seen.push(b), ok({ _id: 'blkNew' }, 201)) });
    await userEvent.click(await screen.findByRole('button', { name: 'Block room 101 on 2026-10-14' }));
    await userEvent.click(screen.getByRole('button', { name: 'Block Room' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ propertyId: 'p1', roomTypeId: 'rt1', roomId: 'r101', startDate: '2026-10-14', endDate: '2026-10-15', reason: 'MAINTENANCE' });
  });

  it('a rejected block shows the server message and keeps the dialog open', async () => {
    setup({ block: () => fail(409, 'DUPLICATE', 'That night is already blocked') });
    await userEvent.click(await screen.findByRole('button', { name: 'Block room 101 on 2026-10-14' }));
    await userEvent.click(screen.getByRole('button', { name: 'Block Room' }));
    expect(await screen.findByText('That night is already blocked')).toBeInTheDocument();
    expect(screen.getByText(/Take this room out of sale/)).toBeInTheDocument();
  });
});
