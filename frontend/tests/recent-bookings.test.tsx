import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fail, mockFetch, ok } from './helpers';
import BookingLookupPage from '@/app/booking/lookup/page';
import { forgetAllBookings, forgetBooking, isRemembered, listRecentBookings, rememberBooking } from '@/lib/booking/recent';

const reservation = (code = 'TRV-AAAA1111') => ({ reservationCode: code, status: 'CONFIRMED', propertyName: 'Radha Ashram', checkIn: '2026-11-01', checkOut: '2026-11-03', nights: 2, adults: 2, children: 0, rooms: [{ roomTypeName: 'Deluxe' }], subtotal: 700000, tax: 35000, discount: 0, total: 735000, currency: 'INR', paymentStatus: 'PAID', holdExpiresAt: null });

describe('remembered bookings (opt-in, this device only)', () => {
  it('stores, lists, replaces and forgets; never keeps more than 10; survives corrupt storage', () => {
    rememberBooking({ code: 'TRV-AAAA1111', email: ' Guest@Example.com ', propertyName: 'P', checkIn: '2026-11-01', checkOut: '2026-11-02' });
    expect(listRecentBookings()).toMatchObject([{ code: 'TRV-AAAA1111', email: 'guest@example.com' }]);
    rememberBooking({ code: 'TRV-AAAA1111', email: 'guest@example.com', propertyName: 'P2', checkIn: '2026-11-01', checkOut: '2026-11-02' });
    expect(listRecentBookings()).toHaveLength(1); // same booking replaced, not duplicated
    expect(listRecentBookings()[0].propertyName).toBe('P2');
    for (let i = 0; i < 12; i++) rememberBooking({ code: `TRV-BBBB${String(i).padStart(4, '0')}`, email: 'g@example.com', propertyName: 'P', checkIn: 'a', checkOut: 'b' });
    expect(listRecentBookings()).toHaveLength(10);
    expect(isRemembered('TRV-BBBB0011')).toBe(true);
    forgetBooking('TRV-BBBB0011');
    expect(isRemembered('TRV-BBBB0011')).toBe(false);
    forgetAllBookings();
    expect(listRecentBookings()).toEqual([]);

    localStorage.setItem('tirvona_recent_bookings', '{not json');
    expect(listRecentBookings()).toEqual([]);
    localStorage.setItem('tirvona_recent_bookings', JSON.stringify([{ code: 'bad' }, 42, null]));
    expect(listRecentBookings()).toEqual([]); // malformed entries are dropped, never trusted
  });
});

describe('booking lookup page', () => {
  it('nothing is remembered unless the guest asks: a lookup alone stores nothing', async () => {
    mockFetch(() => ok(reservation()));
    const user = userEvent.setup();
    render(<BookingLookupPage />);
    await user.type(screen.getByLabelText(/Booking Code/), 'trv-aaaa1111');
    await user.type(screen.getByLabelText(/Booking Email/), 'Guest@Example.com');
    await user.click(screen.getByRole('button', { name: 'Lookup Booking' }));
    expect(await screen.findByText('Radha Ashram')).toBeInTheDocument();
    expect(localStorage.getItem('tirvona_recent_bookings')).toBeNull();
    expect(screen.queryByText('Saved on this device')).not.toBeInTheDocument();
  });

  it('saving is explicit, the list then shows it, "View" re-opens it with the stored e-mail, and "Forget" removes it', async () => {
    const m = mockFetch((c) => (c.url.includes('/public/reservations/TRV-AAAA1111') ? ok(reservation()) : fail(404, 'NOT_FOUND', 'x')));
    const user = userEvent.setup();
    render(<BookingLookupPage />);
    await user.type(screen.getByLabelText(/Booking Code/), 'TRV-AAAA1111');
    await user.type(screen.getByLabelText(/Booking Email/), 'guest@example.com');
    await user.click(screen.getByRole('button', { name: 'Lookup Booking' }));
    await user.click(await screen.findByRole('button', { name: 'Save on this device' }));

    expect(await screen.findByText('Saved on this device')).toBeInTheDocument();
    expect(listRecentBookings()).toMatchObject([{ code: 'TRV-AAAA1111', email: 'guest@example.com', propertyName: 'Radha Ashram' }]);

    const before = m.calls.length;
    await user.click(screen.getByRole('button', { name: 'View' }));
    await waitFor(() => expect(m.calls.length).toBe(before + 1));
    expect(new URL(m.calls[m.calls.length - 1].url).searchParams.get('email')).toBe('guest@example.com');

    await user.click(screen.getByRole('button', { name: 'Forget TRV-AAAA1111' }));
    await waitFor(() => expect(screen.queryByText('Saved on this device')).not.toBeInTheDocument());
    expect(listRecentBookings()).toEqual([]);
  });

  it('a wrong code/email is reported, not remembered', async () => {
    mockFetch(() => fail(404, 'NOT_FOUND', 'nope'));
    const user = userEvent.setup();
    render(<BookingLookupPage />);
    await user.type(screen.getByLabelText(/Booking Code/), 'TRV-ZZZZ9999');
    await user.type(screen.getByLabelText(/Booking Email/), 'who@example.com');
    await user.click(screen.getByRole('button', { name: 'Lookup Booking' }));
    expect(await screen.findByText('No booking matches this code and email.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save on this device' })).not.toBeInTheDocument();
  });
});
