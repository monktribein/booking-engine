/**
 * Mounts the REAL page components (real AuthProvider, PropertyProvider, React Query, lib/api and fetch) against the
 * running seeded backend and asserts that data from the database reaches the screen. It also proves the failure
 * states: a 403 shows a permission message, not an empty table.
 */
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { authApi } from '@/lib/api/auth';
import { tokenStorage } from '@/lib/api/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ channel: 'mock', propertySlug: 'radha-ashram' }),
  useSearchParams: () => new URLSearchParams(),
}));

import { AuthProvider } from '@/lib/auth/auth-context';
import { PropertyProvider } from '@/lib/auth/property-context';
import DashboardHome from '@/app/dashboard/page';
import ReservationsPage from '@/app/dashboard/reservations/page';
import RoomsPage from '@/app/dashboard/rooms/page';
import InventoryPage from '@/app/dashboard/inventory/page';
import RatesPage from '@/app/dashboard/rates/page';
import GuestsPage from '@/app/dashboard/guests/page';
import PaymentsPage from '@/app/dashboard/payments/page';
import ReportsPage from '@/app/dashboard/reports/page';
import ChannelsPage from '@/app/dashboard/channels/page';
import ChannelDetailPage from '@/app/dashboard/channels/[channel]/page';
import SyncErrorsPage from '@/app/dashboard/channels/sync-logs/page';
import SettingsPage from '@/app/dashboard/settings/page';
import { PmsCalendar } from '@/components/calendar/PmsCalendar';
import { PublicBookingClient } from '@/app/stays/[propertySlug]/booking-client';
import BookingLookupPage from '@/app/booking/lookup/page';

const EMAIL = process.env.LIVE_OWNER_EMAIL ?? 'owner@tirvona.demo';
const PASSWORD = process.env.LIVE_OWNER_PASSWORD ?? 'SandboxPass-123';

function mount(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })}>
      <AuthProvider>
        <PropertyProvider>{ui}</PropertyProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
const T = { timeout: 15_000 };

beforeAll(async () => {
  await authApi.login({ email: EMAIL, password: PASSWORD });
});
afterEach(() => cleanup());

describe('dashboard screens render real data from the backend', () => {
  it('Dashboard home: property name, stat cards, channel list, recent reservations', async () => {
    mount(<DashboardHome />);
    expect(await screen.findByRole('heading', { name: 'Radha Ashram' }, T)).toBeInTheDocument();
    expect(await screen.findByText('Total Rooms', undefined, T)).toBeInTheDocument();
    expect(await screen.findByText('Mock OTA', undefined, T)).toBeInTheDocument();
    expect((await screen.findAllByText(/^TRV-/, undefined, T)).length).toBeGreaterThan(0);
  });

  it('Reservations: rows from the database with code, guest and status', async () => {
    mount(<ReservationsPage />);
    expect((await screen.findAllByText(/^TRV-/, undefined, T)).length).toBeGreaterThan(3);
    expect(await screen.findByText(/Priya/, undefined, T)).toBeInTheDocument();
  });

  it('Rooms: room types with real counts and room tiles', async () => {
    mount(<RoomsPage />);
    expect((await screen.findAllByText('Deluxe AC', undefined, T)).length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: /^Room 101,/ }, T)).toBeInTheDocument();
  });

  it('Inventory: 7-day matrix for each room type', async () => {
    mount(<InventoryPage />);
    expect(await screen.findAllByText('Sellable Available', undefined, T)).not.toHaveLength(0);
    expect((await screen.findAllByRole('button', { name: /^Stop sell/ }, T)).length).toBeGreaterThan(5);
  });

  it('Rates: rate plans and an (empty or real) promotions list', async () => {
    mount(<RatesPage />);
    expect(await screen.findByText('Standard Flexible', undefined, T)).toBeInTheDocument();
    expect(await screen.findByText('Promotions', undefined, T)).toBeInTheDocument();
  });

  it('Guests: directory rows', async () => {
    mount(<GuestsPage />);
    expect(await screen.findByText(/Priya/, undefined, T)).toBeInTheDocument();
  });

  it('Payments: reservations with paid / balance columns', async () => {
    mount(<PaymentsPage />);
    expect(await screen.findByText('Balance due', undefined, T)).toBeInTheDocument();
    expect((await screen.findAllByText(/^TRV-/, undefined, T)).length).toBeGreaterThan(0);
  });

  it('Reports: revenue KPIs and channel share from the real aggregation', async () => {
    mount(<ReportsPage />);
    expect(await screen.findByText('Room Revenue', undefined, T)).toBeInTheDocument();
    expect(await screen.findByText('Channel Performance Share', undefined, T)).toBeInTheDocument();
    expect(await screen.findByText('Nightly Occupancy', undefined, T)).toBeInTheDocument();
  });

  it('Channels: internal channels always on, unavailable OTAs flagged honestly', async () => {
    mount(<ChannelsPage />);
    expect(await screen.findByText('Mock OTA', undefined, T)).toBeInTheDocument();
    expect((await screen.findAllByText('Partner access needed', undefined, T)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Always on', undefined, T)).length).toBe(2);
  });

  it('Channel detail (MOCK): connect call to action when not connected', async () => {
    mount(<ChannelDetailPage />);
    expect(await screen.findByText(/Mock OTA Integration/, undefined, T)).toBeInTheDocument();
  });

  it('Sync errors: the owner is told they are not allowed (403), the table is NOT shown as empty', async () => {
    mount(<SyncErrorsPage />);
    expect(await screen.findByText('Not allowed', undefined, T)).toBeInTheDocument();
    expect(screen.queryByText('No sync errors')).not.toBeInTheDocument();
  });

  it('Settings: the property form is filled from the server record', async () => {
    mount(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText(/property name/i)).toHaveValue('Radha Ashram'), T);
  });

  it('PMS calendar: physical rooms on the tape chart', async () => {
    mount(<PmsCalendar />);
    expect(await screen.findByText(/^Room 101$/, undefined, T)).toBeInTheDocument();
  });
});

describe('public screens render real data without a login', () => {
  it('stays client: live availability for the default dates', async () => {
    tokenStorage.clear();
    const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PublicBookingClient propertySlug="radha-ashram" currency="INR" initialRoomTypes={[]} defaultCheckIn={d(24)} defaultCheckOut={d(26)} />
      </QueryClientProvider>
    );
    expect((await screen.findAllByText(/Standard Flexible|Non-refundable Saver/, undefined, T)).length).toBeGreaterThan(0);
    expect((await screen.findAllByRole('button', { name: /book now/i }, T)).length).toBeGreaterThan(0);
  });

  it('booking lookup: an unknown code + email shows "no booking", not a fabricated voucher', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<BookingLookupPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/booking code/i), 'TRV-DOESNOTEXIST');
    await user.type(screen.getByLabelText(/email/i), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: /lookup booking/i }));
    expect(await screen.findByRole('alert', undefined, T)).toHaveTextContent(/no booking matches/i);
  });
});
