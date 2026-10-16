import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfiguredProviderPanel } from '@/components/channels/ConfiguredProviderPanel';
import { IcalExportPanel } from '@/components/channels/IcalExportPanel';
import { CsvImportDialog } from '@/components/reservations/CsvImportDialog';
import { ProvidersPanel } from '@/components/admin/ProvidersPanel';
import { API, fail, mockFetch, ok, type RecordedCall } from './helpers';

let role = 'SUPER_ADMIN';
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ user: { _id: 'u1', name: 'Admin', role }, isLoading: false }) }));

const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>);
const path = (c: RecordedCall) => c.url.replace(API, '').split('?')[0];

const rest = {
  _id: 'p1', code: 'ACME_STAY', name: 'Acme Stay', kind: 'PMS', protocol: 'REST_JSON', builtIn: false, operational: true,
  capabilities: ['listings', 'pushAvailability', 'pushRates', 'pullReservations', 'webhooks', 'polling'],
  authType: 'API_KEY_HEADER', requiredCredentials: ['API_KEY', 'WEBHOOK_SECRET'], supportsWebhooks: true, supportsPolling: true, sandboxAvailable: true, defaultPollIntervalSeconds: 300, version: 2,
};
const ical = { ...rest, _id: 'p2', code: 'ICAL', name: 'iCal calendar feed', protocol: 'ICAL', capabilities: ['listings', 'pullReservations', 'polling'], authType: 'FEED_URL', requiredCredentials: ['FEED_URLS'], supportsWebhooks: false, sandboxAvailable: false, defaultPollIntervalSeconds: 900 };
const detail = (over: Record<string, unknown> = {}) => ({
  channel: 'ACME_STAY', provider: { code: 'ACME_STAY', name: 'Acme Stay', version: 2 }, status: 'CONNECTED', environment: 'production', externalAccountId: null,
  connectedAt: '2026-10-10T08:00:00.000Z', lastSyncAt: '2026-10-16T08:00:00.000Z', lastError: null, capabilities: ['pushAvailability'],
  credentials: [{ kind: 'API_KEY', storedAt: '2026-10-10T08:00:00.000Z', rotatedAt: null }],
  polling: { intervalSeconds: 300, lastPollAt: '2026-10-16T08:00:00.000Z', lastPollError: null, cursor: null },
  webhook: { url: 'http://api.test/webhooks/c/KEY123', signatureHeader: 'X-Acme-Signature' }, ...over,
});

describe('Connecting a configured provider', () => {
  it('shows what the provider can and cannot do and asks only for the credentials it needs', async () => {
    mockFetch((c) => (path(c) === '/channel-providers' ? ok([rest]) : ok({})));
    wrap(<ConfiguredProviderPanel propertyId="prop1" channel="ACME_STAY" connected={false} />);
    expect(await screen.findByText('What Acme Stay supports')).toBeInTheDocument();
    expect(screen.getByText(/Send availability/)).toBeInTheDocument();
    expect(screen.getByText(/Not available with this provider/)).toBeInTheDocument();
    expect(screen.getByText(/Send restrictions/)).toBeInTheDocument(); // listed under what is NOT available
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/Webhook secret/)).toBeInTheDocument();
    expect(screen.getByLabelText('Environment')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Username/)).toBeNull();
  });

  it('sends the entered credentials once, reports success, and never shows them again', async () => {
    let connected = false;
    const m = mockFetch((c) => {
      if (path(c) === '/channel-providers') return ok([rest]);
      if (path(c).endsWith('/credentials') && c.method === 'POST') { connected = true; return ok(detail()); }
      if (path(c).endsWith('/connection')) return connected ? ok(detail()) : fail(404, 'NOT_FOUND', 'x');
      if (path(c).endsWith('/reconciliation')) return ok({ runs: [], issues: [] });
      return ok([]);
    });
    const user = userEvent.setup();
    const { rerender } = wrap(<ConfiguredProviderPanel propertyId="prop1" channel="ACME_STAY" connected={false} />);
    await user.type(await screen.findByLabelText('API key'), 'sk-live-12345');
    expect(screen.getByRole('button', { name: 'Test and connect' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Test and connect' }));
    await screen.findByText(/Acme Stay is connected/);
    const post = m.calls.find((c) => c.method === 'POST' && path(c).endsWith('/credentials'))!;
    expect(JSON.parse(post.body!)).toMatchObject({ credentials: { API_KEY: 'sk-live-12345' }, environment: 'production', pollIntervalSeconds: 300 });

    rerender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ConfiguredProviderPanel propertyId="prop1" channel="ACME_STAY" connected /></QueryClientProvider>);
    expect(await screen.findByText('Healthy')).toBeInTheDocument();
    expect(screen.getByTestId('webhook-url')).toHaveTextContent('http://api.test/webhooks/c/KEY123');
    expect(screen.getByText(/API key • set/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('sk-live-12345');
  });

  it('a provider that rejects the credentials is reported, not shown as connected', async () => {
    mockFetch((c) => {
      if (path(c) === '/channel-providers') return ok([rest]);
      if (path(c).endsWith('/credentials')) return fail(422, 'CHANNEL_CONNECTION_TEST_FAILED', 'Acme Stay rejected the credentials (401). Check or rotate the API credentials.');
      return ok({});
    });
    const user = userEvent.setup();
    wrap(<ConfiguredProviderPanel propertyId="prop1" channel="ACME_STAY" connected={false} />);
    await user.type(await screen.findByLabelText('API key'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Test and connect' }));
    expect(await screen.findByText(/rejected the credentials/)).toBeInTheDocument();
    expect(screen.queryByText('Healthy')).toBeNull();
    expect(screen.getByRole('button', { name: 'Test and connect' })).toBeInTheDocument();
  });

  it('iCal providers take calendar addresses, and say plainly what a calendar cannot carry', async () => {
    const m = mockFetch((c) => {
      if (path(c) === '/channel-providers') return ok([ical]);
      if (path(c).endsWith('/credentials')) return ok(detail({ channel: 'ICAL' }));
      return ok({});
    });
    const user = userEvent.setup();
    wrap(<ConfiguredProviderPanel propertyId="prop1" channel="ICAL" connected={false} />);
    expect(await screen.findByText(/no prices, guests or restrictions/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('API key')).toBeNull();
    await user.type(screen.getByLabelText('Calendar 1 name'), 'Airbnb – Deluxe');
    const address = screen.getByLabelText('Calendar 1 address');
    expect(address).toHaveAttribute('type', 'password'); // the address is a secret
    await user.type(address, 'https://example.com/cal.ics?s=abc');
    await user.click(screen.getByRole('button', { name: 'Test and connect' }));
    await waitFor(() => expect(m.calls.some((c) => c.method === 'POST' && path(c).endsWith('/credentials'))).toBe(true));
    const body = JSON.parse(m.calls.find((c) => c.method === 'POST' && path(c).endsWith('/credentials'))!.body!);
    expect(body.feeds).toEqual([{ name: 'Airbnb – Deluxe', url: 'https://example.com/cal.ics?s=abc' }]);
    expect(body.credentials).toBeUndefined();
  });

  it('lists reconciliation differences and lets staff resolve or ignore them', async () => {
    let issues = [{ _id: 'i1', kind: 'STATUS_MISMATCH', externalReservationId: 'BK-9', reservationId: 'r1', details: { remote: 'CANCELLED', local: 'CONFIRMED' }, createdAt: '2026-10-16T08:00:00.000Z' }];
    const m = mockFetch((c) => {
      if (path(c) === '/channel-providers') return ok([rest]);
      if (path(c).endsWith('/connection')) return ok(detail());
      if (path(c).includes('/reconciliation/issues/')) { issues = []; return ok({}); }
      if (path(c).endsWith('/reconciliation') && c.method === 'POST') return ok({ _id: 'run2', status: 'COMPLETED', issueCount: 1 });
      if (path(c).endsWith('/reconciliation')) return ok({ runs: [{ _id: 'run1', status: 'COMPLETED', startedAt: '2026-10-16T07:00:00.000Z', completedAt: null, remoteCount: 3, localCount: 3, issueCount: 1, error: null }], issues });
      return ok([]);
    });
    const user = userEvent.setup();
    wrap(<ConfiguredProviderPanel propertyId="prop1" channel="ACME_STAY" connected />);
    expect(await screen.findByText('Status differs')).toBeInTheDocument();
    expect(screen.getByText('BK-9')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ignore BK-9' }));
    await screen.findByText('No open differences.');
    const call = m.calls.find((c) => path(c).includes('/reconciliation/issues/i1'))!;
    expect(JSON.parse(call.body!)).toMatchObject({ status: 'IGNORED' });
  });
});

describe('Calendars Tirvona publishes', () => {
  it('shows a new calendar address once and offers revocation of existing ones', async () => {
    let feeds: unknown[] = [{ _id: 'f1', roomTypeId: 'rt1', roomType: 'Deluxe', label: 'For Airbnb', createdAt: '2026-10-01T00:00:00.000Z', lastFetchedAt: null, revokedAt: null }];
    const m = mockFetch((c) => {
      if (path(c).endsWith('/ical-feeds') && c.method === 'POST') { feeds = [...feeds, { _id: 'f2', roomTypeId: 'rt1', roomType: 'Deluxe', label: null, createdAt: '2026-10-16T00:00:00.000Z', lastFetchedAt: null, revokedAt: null }]; return ok({ _id: 'f2', url: 'http://api.test/ical/TOKENTOKEN.ics', note: 'shown once' }, 201); }
      if (path(c).includes('/ical-feeds/f1') && c.method === 'DELETE') { feeds = [{ ...(feeds[0] as object), revokedAt: '2026-10-16T00:00:00.000Z' }]; return ok({ ok: true }); }
      if (path(c).endsWith('/ical-feeds')) return ok(feeds);
      if (path(c).endsWith('/room-types')) return ok([{ _id: 'rt1', name: 'Deluxe' }]);
      return ok([]);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    wrap(<IcalExportPanel propertyId="prop1" />);
    expect(await screen.findByText(/no prices, no guest details/)).toBeInTheDocument();
    await screen.findByText('Deluxe', { selector: 'span' });
    await user.selectOptions(screen.getByLabelText('Room type'), 'rt1');
    await user.click(screen.getByRole('button', { name: 'Create calendar address' }));
    expect(await screen.findByText('http://api.test/ical/TOKENTOKEN.ics')).toBeInTheDocument();
    expect(JSON.parse(m.calls.find((c) => c.method === 'POST')!.body!)).toMatchObject({ roomTypeId: 'rt1' });
    await user.click(screen.getAllByRole('button', { name: /Revoke calendar/ })[0]);
    await screen.findByText('revoked');
  });
});

describe('CSV import', () => {
  const file = (text: string) => new File([text], 'bookings.csv', { type: 'text/csv' });
  it('guesses the columns, previews every row, and imports only after the check', async () => {
    const csv = 'Booking ref,Arrival,Departure,Adults,First name,Last name,Total\nR-1,2026-11-01,2026-11-03,2,Asha,Verma,7000\nR-2,bad,2026-11-03,1,Ben,Lee,5000';
    const check = { dryRun: true, roomType: 'Deluxe', totals: { rows: 2, ok: 1, imported: 0, duplicates: 0, errors: 1 }, rows: [
      { line: 2, reference: 'R-1', status: 'OK', errors: [], summary: { checkIn: '2026-11-01', checkOut: '2026-11-03', nights: 2, adults: 2, total: 700000, guest: 'Asha V' } },
      { line: 3, reference: 'R-2', status: 'ERROR', errors: ['check-in is not a valid YYYY-MM-DD date'] },
    ] };
    const m = mockFetch((c) => {
      if (path(c).endsWith('/room-types')) return ok([{ _id: 'rt1', name: 'Deluxe' }]);
      if (path(c).endsWith('/reservations/import')) {
        const body = JSON.parse(c.body!);
        return ok(body.dryRun ? check : { ...check, dryRun: false, totals: { rows: 2, ok: 0, imported: 1, duplicates: 0, errors: 1 }, rows: check.rows.map((r) => (r.status === 'OK' ? { ...r, status: 'IMPORTED' } : r)) });
      }
      return ok([]);
    });
    const user = userEvent.setup();
    wrap(<CsvImportDialog propertyId="prop1" currency="INR" isOpen onClose={() => undefined} />);
    await user.upload(screen.getByLabelText(/CSV file/), file(csv));
    await screen.findByText(/7 columns found/);
    expect(screen.getByLabelText(/Your booking reference/)).toHaveValue('Booking ref');
    expect(screen.getByLabelText(/Check-in date/)).toHaveValue('Arrival');
    expect(screen.getByLabelText(/Total price of the stay/)).toHaveValue('Total');
    expect(screen.getByRole('button', { name: 'Check the file' })).toBeDisabled(); // no room type yet
    await screen.findByRole('option', { name: 'Deluxe' });
    await user.selectOptions(screen.getByLabelText('Room type to book'), 'rt1');
    await user.click(screen.getByRole('button', { name: 'Check the file' }));
    const result = await screen.findByTestId('csv-result');
    expect(within(result).getByText(/Nothing has been saved yet/)).toBeInTheDocument();
    expect(within(result).getByText(/check-in is not a valid/)).toBeInTheDocument();
    expect(m.calls.filter((c) => path(c).endsWith('/import')).every((c) => JSON.parse(c.body!).dryRun === true)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Import 1 booking' }));
    await within(await screen.findByTestId('csv-result')).findByText(/Imported 1 booking/);
    expect(JSON.parse(m.calls.filter((c) => path(c).endsWith('/import')).at(-1)!.body!)).toMatchObject({ dryRun: false, roomTypeId: 'rt1', dateFormat: 'YYYY-MM-DD' });
  });

  it('refuses a file that is too large before sending anything', async () => {
    const m = mockFetch(() => ok([]));
    const user = userEvent.setup({ applyAccept: false });
    wrap(<CsvImportDialog propertyId="prop1" currency="INR" isOpen onClose={() => undefined} />);
    await user.upload(screen.getByLabelText(/CSV file/), new File(['x'.repeat(1024 * 1024 + 10)], 'big.csv', { type: 'text/csv' }));
    expect(await screen.findByText(/larger than 1 MB/)).toBeInTheDocument();
    expect(m.calls.some((c) => path(c).endsWith('/import'))).toBe(false);
  });
});

describe('Admin: providers', () => {
  const provider = { _id: 'p1', code: 'ACME_STAY', name: 'Acme Stay', kind: 'PMS', protocol: 'REST_JSON', status: 'ACTIVE', builtIn: false, currentVersionId: 'v1', createdAt: '2026-10-01T00:00:00.000Z' };
  const builtin = { ...provider, _id: 'p0', code: 'AIRBNB', name: 'Airbnb', protocol: 'CODE', builtIn: true, currentVersionId: null };
  const versions = [
    { _id: 'v2', version: 2, status: 'VALIDATED', definitionHash: 'a'.repeat(64), validation: { ok: true, errors: [], warnings: [] }, notes: null, publishedAt: null, createdAt: '2026-10-05T00:00:00.000Z' },
    { _id: 'v1', version: 1, status: 'PUBLISHED', definitionHash: 'b'.repeat(64), validation: { ok: true, errors: [], warnings: [] }, notes: 'first', publishedAt: '2026-10-02T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z' },
  ];

  it('lists providers; built-in ones are code, and a super admin can add and switch providers', async () => {
    role = 'SUPER_ADMIN';
    mockFetch(() => ok([builtin, provider]));
    wrap(<ProvidersPanel />);
    expect(await screen.findByText('Acme Stay')).toBeInTheDocument();
    expect(screen.getByText('built in (code)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New provider' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable Acme Stay' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Airbnb' })).toBeNull(); // nothing to edit: it is code
  });

  it('operations admins can read and validate but not create, publish or disable', async () => {
    role = 'OPERATIONS_ADMIN';
    mockFetch((c) => (path(c) === '/admin/channel-providers/p1' ? ok({ provider, versions }) : ok([provider])));
    const user = userEvent.setup();
    wrap(<ProvidersPanel />);
    await screen.findByText('Acme Stay');
    expect(screen.queryByRole('button', { name: 'New provider' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable Acme Stay' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open Acme Stay' }));
    await screen.findByText('v2');
    expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish version 2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as new version' })).toBeNull();
  });

  it('validates a definition on the server and lists each problem by path; publishes a validated version', async () => {
    role = 'SUPER_ADMIN';
    const m = mockFetch((c) => {
      if (path(c) === '/admin/channel-providers/validate') return ok({ ok: false, errors: [{ path: 'allowedHosts[0]', message: 'must be an exact DNS host name' }], warnings: [] });
      if (path(c) === '/admin/channel-providers/versions/v2/publish') return ok({});
      if (path(c) === '/admin/channel-providers/p1') return ok({ provider, versions });
      return ok([provider]);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    wrap(<ProvidersPanel />);
    await user.click(await screen.findByRole('button', { name: 'Open Acme Stay' }));
    await screen.findByText('v2');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    const v = await screen.findByTestId('validation');
    expect(within(v).getByText('allowedHosts[0]')).toBeInTheDocument();
    expect(within(v).getByText(/exact DNS host name/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish version 2' }));
    await screen.findByText(/Published\. New connections use this version/);
    expect(m.calls.some((c) => path(c) === '/admin/channel-providers/versions/v2/publish' && c.method === 'POST')).toBe(true);
  });

  it('refuses text that is not JSON without calling the server', async () => {
    role = 'SUPER_ADMIN';
    const m = mockFetch((c) => (path(c) === '/admin/channel-providers/p1' ? ok({ provider, versions }) : ok([provider])));
    const user = userEvent.setup();
    wrap(<ProvidersPanel />);
    await user.click(await screen.findByRole('button', { name: 'Open Acme Stay' }));
    await screen.findByText('v2');
    const box = screen.getByLabelText('Provider definition');
    await user.clear(box);
    await user.type(box, 'not json');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
    expect(m.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a dry run sends the credentials for that call only and shows each step', async () => {
    role = 'SUPER_ADMIN';
    const m = mockFetch((c) => {
      if (path(c).endsWith('/dry-run')) return ok({ passed: true, steps: [{ step: 'healthCheck', ok: true, detail: 'reachable in 12 ms' }, { step: 'listListings', ok: true, detail: '3 listing(s)' }] });
      if (path(c) === '/admin/channel-providers/p1') return ok({ provider, versions });
      return ok([provider]);
    });
    const user = userEvent.setup();
    wrap(<ProvidersPanel />);
    await user.click(await screen.findByRole('button', { name: 'Open Acme Stay' }));
    await user.click(await screen.findByRole('button', { name: 'Test version 2' }));
    await user.type(screen.getByLabelText('API key'), 'sandbox-key-1');
    await user.click(screen.getByRole('button', { name: 'Run test' }));
    const res = await screen.findByTestId('dry-run-result');
    expect(within(res).getByText(/All checks passed/)).toBeInTheDocument();
    expect(within(res).getByText('3 listing(s)', { exact: false })).toBeInTheDocument();
    expect(JSON.parse(m.calls.find((c) => c.url.endsWith('/dry-run'))!.body!)).toEqual({ environment: 'sandbox', credentials: { API_KEY: 'sandbox-key-1' } });
    expect(document.body.textContent).not.toContain('sandbox-key-1');
  });
});
