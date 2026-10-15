import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DeveloperSection } from '@/components/settings/developer-section';
import { API, fail, mockFetch, ok, type RecordedCall } from './helpers';

const FULL_KEY = 'tvk_ab12cd34_' + 'Z'.repeat(43);
const key = (over: Record<string, unknown> = {}) => ({
  _id: 'k1',
  name: 'Marketplace',
  keyPrefix: 'tvk_ab12cd34_',
  scopes: ['availability:read', 'reservations:write'],
  propertyIds: [],
  status: 'ACTIVE',
  expiresAt: null,
  lastUsedAt: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  ...over,
});
const endpoint = (over: Record<string, unknown> = {}) => ({
  _id: 'e1',
  url: 'https://api.example.com/hooks',
  events: ['reservation.confirmed'],
  propertyIds: [],
  status: 'ACTIVE',
  createdAt: '2026-10-15T00:00:00.000Z',
  ...over,
});

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><DeveloperSection /></QueryClientProvider>);
const path = (c: RecordedCall) => c.url.replace(API, '').split('?')[0];

describe('Developer settings: API keys', () => {
  it('lists keys by prefix only and never shows a secret', async () => {
    mockFetch((c) => (path(c) === '/api-keys' ? ok([key()]) : ok([])));
    mount();
    expect(await screen.findByText('Marketplace')).toBeInTheDocument();
    expect(screen.getByText(/tvk_ab12cd34_…/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Z'.repeat(10));
  });

  it('creating a key shows the full key once, with a warning, and sends name + scopes', async () => {
    const list = [key()];
    const m = mockFetch((c) => {
      if (path(c) === '/api-keys' && c.method === 'POST') {
        list.push(key({ _id: 'k2', name: 'Website' }));
        return ok({ ...key({ _id: 'k2', name: 'Website' }), key: FULL_KEY }, 201);
      }
      return path(c) === '/api-keys' ? ok(list) : ok([]);
    });
    const user = userEvent.setup();
    mount();
    await screen.findByText('Marketplace');
    await user.type(screen.getByLabelText(/Key name/), 'Website');
    await user.click(screen.getByRole('button', { name: 'Create API key' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(FULL_KEY);
    expect(alert).toHaveTextContent(/shown only once/i);
    const post = m.calls.find((c) => c.method === 'POST' && path(c) === '/api-keys')!;
    expect(JSON.parse(post.body!)).toEqual({ name: 'Website', scopes: ['properties:read', 'availability:read', 'reservations:read', 'reservations:write'] });

    // the list refreshed and holds only the prefix; dismissing removes the key from the page for good
    expect(await screen.findByText('Website')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: /close|dismiss/i }));
    await waitFor(() => expect(document.body.textContent).not.toContain(FULL_KEY));
  });

  it('cannot submit without a name or any permission', async () => {
    mockFetch(() => ok([]));
    const user = userEvent.setup();
    mount();
    const submit = await screen.findByRole('button', { name: 'Create API key' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Key name/), 'Valid name');
    expect(submit).toBeEnabled();
    for (const box of screen.getAllByRole('checkbox').slice(0, 4)) if ((box as HTMLInputElement).checked) await user.click(box);
    expect(submit).toBeDisabled();
  });

  it('shows the server\'s reason and no key when creation is refused', async () => {
    mockFetch((c) => (c.method === 'POST' ? fail(403, 'FORBIDDEN', 'Your role does not allow this action') : ok([])));
    const user = userEvent.setup();
    mount();
    await user.type(await screen.findByLabelText(/Key name/), 'Website');
    await user.click(screen.getByRole('button', { name: 'Create API key' }));
    expect(await screen.findByText('Your role does not allow this action')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('tvk_');
  });

  it('revokes only after confirmation', async () => {
    const m = mockFetch((c) => (c.method === 'DELETE' ? ok(key({ status: 'REVOKED' })) : path(c) === '/api-keys' ? ok([key()]) : ok([])));
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm');
    mount();
    const revoke = await screen.findByRole('button', { name: 'Revoke Marketplace' });

    confirm.mockReturnValueOnce(false);
    await user.click(revoke);
    expect(m.calls.some((c) => c.method === 'DELETE')).toBe(false);

    confirm.mockReturnValueOnce(true);
    await user.click(revoke);
    await waitFor(() => expect(m.calls.some((c) => c.method === 'DELETE' && path(c) === '/api-keys/k1')).toBe(true));
    expect(await screen.findByText(/stopped working immediately/)).toBeInTheDocument();
  });

  it('shows a retryable error instead of an empty list when loading fails', async () => {
    mockFetch((c) => (path(c) === '/api-keys' ? fail(500, 'INTERNAL_ERROR', 'boom') : ok([])));
    mount();
    expect(await screen.findAllByRole('button', { name: 'Try again' })).not.toHaveLength(0);
    expect(screen.queryByText('No API keys yet')).not.toBeInTheDocument();
  });
});

describe('Developer settings: webhooks', () => {
  it('registers an endpoint and shows the signing secret once', async () => {
    const m = mockFetch((c) => {
      if (path(c) === '/webhook-endpoints' && c.method === 'POST') return ok({ ...endpoint(), secret: 'whsec_ONLYONCE' }, 201);
      return path(c) === '/webhook-endpoints' ? ok([endpoint()]) : ok([]);
    });
    const user = userEvent.setup();
    mount();
    await user.type(await screen.findByLabelText(/Endpoint URL/), 'https://api.example.com/hooks');
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    expect(await screen.findByText(/whsec_ONLYONCE/)).toBeInTheDocument();
    const post = m.calls.find((c) => c.method === 'POST' && path(c) === '/webhook-endpoints')!;
    expect(JSON.parse(post.body!)).toEqual({ url: 'https://api.example.com/hooks', events: ['reservation.created', 'reservation.confirmed', 'reservation.cancelled'] });
  });

  it('sends a test event, toggles status, and deletes only after confirmation', async () => {
    const m = mockFetch((c) => {
      if (c.method === 'POST' && path(c) === '/webhook-endpoints/e1/test') return ok({ deliveryId: 'd1', eventId: 'evt_1' }, 202);
      if (c.method === 'PATCH') return ok(endpoint({ status: 'DISABLED' }));
      if (c.method === 'DELETE') return ok({ ok: true });
      return path(c) === '/webhook-endpoints' ? ok([endpoint()]) : ok([]);
    });
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm');
    mount();
    await screen.findByText('https://api.example.com/hooks');

    await user.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText(/Test event queued/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(JSON.parse(m.calls.find((c) => c.method === 'PATCH')!.body!)).toEqual({ status: 'DISABLED' }));

    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: /Delete https/ }));
    expect(m.calls.some((c) => c.method === 'DELETE')).toBe(false);
    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: /Delete https/ }));
    await waitFor(() => expect(m.calls.some((c) => c.method === 'DELETE' && path(c) === '/webhook-endpoints/e1')).toBe(true));
  });

  it('shows failed deliveries with the reason and lets the owner redeliver', async () => {
    const m = mockFetch((c) => {
      if (path(c) === '/webhook-endpoints/e1/deliveries/d1/redeliver') return ok({ _id: 'd1', status: 'PENDING' }, 202);
      if (path(c) === '/webhook-endpoints/e1/deliveries') {
        return ok({ total: 1, items: [{ _id: 'd1', eventId: 'evt_1', eventType: 'reservation.confirmed', status: 'FAILED', attempts: 12, lastError: 'Endpoint responded with HTTP 503', createdAt: '2026-10-15T00:00:00.000Z' }] });
      }
      return path(c) === '/webhook-endpoints' ? ok([endpoint()]) : ok([]);
    });
    const user = userEvent.setup();
    mount();
    await screen.findByText('https://api.example.com/hooks');
    await user.click(screen.getByRole('button', { name: 'Deliveries' }));
    expect(await screen.findByText(/Endpoint responded with HTTP 503/)).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Redeliver' }));
    await waitFor(() => expect(m.calls.some((c) => c.method === 'POST' && path(c).endsWith('/redeliver'))).toBe(true));
    expect(await screen.findByText('Delivery queued again.')).toBeInTheDocument();
  });
});
