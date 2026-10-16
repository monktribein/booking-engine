import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MarketplacePanel, PartnersPanel } from '@/components/admin/panels';
import { API, mockFetch, ok, type RecordedCall } from './helpers';

let role = 'OPERATIONS_ADMIN';
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ user: { _id: 'u1', name: 'Op', role }, isLoading: false }) }));

const page = <T,>(items: T[]) => ok({ items, total: items.length, page: 1, limit: 50 });
const partner = (over: Record<string, unknown> = {}) => ({
  _id: 'o1', name: 'Sea View Stays', status: 'PENDING_APPROVAL', statusReason: null, ownerName: 'Asha', ownerEmail: 'asha@example.com',
  properties: 1, activeApiKeys: 0, createdAt: '2026-10-15T00:00:00.000Z', ...over,
});
const path = (c: RecordedCall) => c.url.replace(API, '').split('?')[0];
const mount = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>);

describe('Admin: partners', () => {
  it('approves a pending partner', async () => {
    role = 'OPERATIONS_ADMIN';
    const m = mockFetch((c) => (path(c) === '/admin/partners/o1/approve' ? ok({ _id: 'o1', status: 'ACTIVE' }) : page([partner()])));
    const user = userEvent.setup();
    mount(<PartnersPanel />);
    await user.click(await screen.findByRole('button', { name: 'Approve Sea View Stays' }));
    expect(await screen.findByText('Partner approved.')).toBeInTheDocument();
    expect(m.calls.some((c) => c.method === 'POST' && path(c) === '/admin/partners/o1/approve')).toBe(true);
  });

  it('rejecting needs a reason', async () => {
    role = 'OPERATIONS_ADMIN';
    const m = mockFetch((c) => (path(c) === '/admin/partners/o1/reject' ? ok({ _id: 'o1', status: 'REJECTED' }) : page([partner()])));
    const user = userEvent.setup();
    mount(<PartnersPanel />);
    await user.click(await screen.findByRole('button', { name: 'Reject Sea View Stays' }));
    const submit = screen.getByRole('button', { name: 'Reject partner' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason/), 'Documents missing');
    await user.click(submit);
    await screen.findByText('Partner rejected.');
    const call = m.calls.find((c) => path(c) === '/admin/partners/o1/reject');
    expect(JSON.parse(call!.body!)).toEqual({ reason: 'Documents missing' });
  });

  it('only a super admin sees suspend', async () => {
    mockFetch(() => page([partner({ status: 'ACTIVE' })]));
    role = 'OPERATIONS_ADMIN';
    const first = mount(<PartnersPanel />);
    await screen.findByText('Sea View Stays');
    expect(screen.queryByRole('button', { name: 'Suspend Sea View Stays' })).toBeNull();
    first.unmount();
    role = 'SUPER_ADMIN';
    mount(<PartnersPanel />);
    expect(await screen.findByRole('button', { name: 'Suspend Sea View Stays' })).toBeInTheDocument();
  });
});

describe('Admin: marketplace', () => {
  it('lists requested listings and approves one', async () => {
    role = 'OPERATIONS_ADMIN';
    const prop = { _id: 'p1', name: 'Palm Villa', city: 'Goa', state: 'Goa', status: 'ACTIVE', organizationName: 'Sea View Stays', marketplaceStatus: 'REQUESTED', marketplaceNote: null, marketplaceConsentAt: '2026-10-14T00:00:00.000Z' };
    const m = mockFetch((c) => (path(c) === '/admin/properties/p1/marketplace/approve' ? ok({}) : page([prop])));
    const user = userEvent.setup();
    mount(<MarketplacePanel />);
    await user.click(await screen.findByRole('button', { name: 'Approve listing Palm Villa' }));
    await screen.findByText('Listing updated.');
    expect(m.calls.some((c) => c.method === 'POST' && path(c).endsWith('/approve'))).toBe(true);
  });
});
