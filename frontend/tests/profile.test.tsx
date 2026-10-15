import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fail, mockFetch, ok, type RecordedCall } from './helpers';

const refreshUser = vi.fn(async () => undefined);
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ user: { _id: 'u1', name: 'Asha Rao', email: 'asha@example.com', phone: '+919811111111', role: 'PROPERTY_OWNER' }, refreshUser }),
}));

import ProfilePage from '@/app/dashboard/profile/page';

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}><ProfilePage /></QueryClientProvider>);
const path = (c: RecordedCall) => new URL(c.url).pathname;

describe('profile page', () => {
  it('shows the account, keeps e-mail and role read-only, and saves only when something changed', async () => {
    const m = mockFetch(() => ok({ name: 'Asha R' }));
    const user = userEvent.setup();
    mount();
    expect(screen.getByLabelText('E-mail')).toBeDisabled();
    expect(screen.getByLabelText('Role')).toHaveValue('property owner');
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText('Name *'));
    await user.type(screen.getByLabelText('Name *'), 'Asha R');
    await user.click(save);
    await waitFor(() => expect(m.calls).toHaveLength(1));
    expect(m.calls[0].method).toBe('PATCH');
    expect(path(m.calls[0])).toBe('/users/me');
    expect(JSON.parse(m.calls[0].body!)).toEqual({ name: 'Asha R', phone: '+919811111111' });
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    expect(refreshUser).toHaveBeenCalled();
  });

  it('rejects a phone that is not international format without calling the server', async () => {
    const m = mockFetch(() => ok({}));
    const user = userEvent.setup();
    mount();
    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '98111 11111');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/international format/)).toBeInTheDocument();
    expect(m.calls).toHaveLength(0);
  });

  it('validates the new password locally (length, letter+digit, match, differs)', async () => {
    const m = mockFetch(() => ok({ ok: true }));
    const user = userEvent.setup();
    mount();
    const type = async (label: string, v: string) => {
      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), v);
    };
    const submit = () => user.click(screen.getByRole('button', { name: 'Change password' }));
    await type('Current password *', 'old-passw0rd-x');
    await type('New password *', 'short1');
    await type('Repeat new password *', 'short1');
    await submit();
    expect(await screen.findByText(/10 or more characters/)).toBeInTheDocument();
    await type('New password *', 'old-passw0rd-x');
    await type('Repeat new password *', 'old-passw0rd-x');
    await submit();
    expect(await screen.findByText(/different from the current/)).toBeInTheDocument();
    await type('New password *', 'new-passw0rd-y');
    await type('Repeat new password *', 'new-passw0rd-z');
    await submit();
    expect(await screen.findByText(/do not match/)).toBeInTheDocument();
    expect(m.calls).toHaveLength(0);
  });

  it('changes the password, clears the fields and says other sign-ins ended', async () => {
    const m = mockFetch(() => ok({ ok: true }));
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByLabelText('Current password *'), 'old-passw0rd-x');
    await user.type(screen.getByLabelText('New password *'), 'new-passw0rd-y');
    await user.type(screen.getByLabelText('Repeat new password *'), 'new-passw0rd-y');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/other sign-ins were ended/)).toBeInTheDocument();
    expect(path(m.calls[0])).toBe('/auth/change-password');
    expect(JSON.parse(m.calls[0].body!)).toEqual({ currentPassword: 'old-passw0rd-x', newPassword: 'new-passw0rd-y' });
    expect(screen.getByLabelText('Current password *')).toHaveValue('');
    expect(screen.getByLabelText('New password *')).toHaveValue('');
  });

  it('a wrong current password is shown on that field and nothing is cleared', async () => {
    mockFetch(() => fail(400, 'VALIDATION_ERROR', 'Current password is incorrect', { fields: { currentPassword: ['is incorrect'] } }));
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByLabelText('Current password *'), 'wrong-passw0rd');
    await user.type(screen.getByLabelText('New password *'), 'new-passw0rd-y');
    await user.type(screen.getByLabelText('Repeat new password *'), 'new-passw0rd-y');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The current password is incorrect.')).toBeInTheDocument();
    expect(screen.getByLabelText('New password *')).toHaveValue('new-passw0rd-y');
  });
});
