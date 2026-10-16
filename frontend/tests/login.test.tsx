import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { tokenStorage } from '@/lib/api/client';
import { fail, mockFetch, ok } from './helpers';

const push = vi.fn();
let resetSearchRef: URLSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }), useSearchParams: () => resetSearchRef }));

import { AuthProvider } from '@/lib/auth/auth-context';
import LoginPage from '@/app/(auth)/login/page';
import RegisterPage from '@/app/(auth)/register/page';

const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>
  );

beforeEach(() => push.mockReset());

describe('login page', () => {
  it('starts with empty credentials: no pre-filled demo password, no "instant demo" buttons', async () => {
    wrap(<LoginPage />);
    expect(screen.getByLabelText(/email/i)).toHaveValue('');
    expect(screen.getByLabelText(/^password$/i)).toHaveValue('');
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
  });

  it('wrong password: shows the backend message, keeps the email, clears the password, no session, no redirect', async () => {
    mockFetch(() => fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password'));
    wrap(<LoginPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'owner@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'wrong-password-1');
    await user.click(screen.getByRole('button', { name: /sign in to dashboard/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(screen.getByLabelText(/email/i)).toHaveValue('owner@example.com');
    expect(screen.getByLabelText(/^password$/i)).toHaveValue('');
    expect(push).not.toHaveBeenCalled();
    expect(tokenStorage.getAccess()).toBeNull();
  });

  it('backend down: shows a connectivity error and signs nobody in, even for a demo-looking email', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    wrap(<LoginPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'owner@tirvona.demo');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in to dashboard/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot reach the server/i);
    expect(push).not.toHaveBeenCalled();
    expect(tokenStorage.getAccess()).toBeNull();
  });

  it('success redirects once and a double click sends one login request', async () => {
    const f = mockFetch((c) => (c.url.endsWith('/api/session/login') ? ok({ accessToken: 'jwt', expiresIn: 900, user: { _id: 'u', organizationId: 'o', name: 'O', email: 'o@x.co', role: 'PROPERTY_OWNER', status: 'ACTIVE', createdAt: '' } }) : fail(404, 'NOT_FOUND', 'x')));
    wrap(<LoginPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'o@x.co');
    await user.type(screen.getByLabelText(/^password$/i), 'correct-horse-9');
    const btn = screen.getByRole('button', { name: /sign in to dashboard/i });
    await user.dblClick(btn);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(f.count('/api/session/login')).toBe(1);
  });
});

describe('register page', () => {
  it('backend rejection (email taken) is shown, the form keeps its values, and no session is created', async () => {
    mockFetch(() => fail(409, 'EMAIL_TAKEN', 'An account with this email already exists'));
    wrap(<RegisterPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/organization|property|hotel/i), 'Gupta Hospitality');
    await user.type(screen.getByLabelText(/owner name/i), 'Asha Gupta');
    await user.type(screen.getByLabelText(/email/i), 'asha@example.com');
    await user.type(screen.getByLabelText(/password/i), 'correct-horse-9');
    await user.click(screen.getByRole('button', { name: /complete registration/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
    expect(screen.getByLabelText(/email/i)).toHaveValue('asha@example.com');
    expect(push).not.toHaveBeenCalled();
    expect(tokenStorage.getAccess()).toBeNull();
  });
});

import ResetPasswordPage from '@/app/(auth)/reset-password/page';


describe('reset-password page (target of the e-mailed link)', () => {
  it('without a token it explains the link is incomplete and offers no form', () => {
    resetSearchRef = new URLSearchParams();
    render(<ResetPasswordPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(/missing its token/i);
    expect(screen.queryByLabelText(/new password/i)).not.toBeInTheDocument();
  });

  it('mismatched confirmation never reaches the server', async () => {
    resetSearchRef = new URLSearchParams({ token: 't'.repeat(30) });
    const f = mockFetch(() => ok({ ok: true }));
    render(<ResetPasswordPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^new password/i), 'correct-horse-9');
    await user.type(screen.getByLabelText(/confirm password/i), 'correct-horse-8');
    await user.click(screen.getByRole('button', { name: /update password/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
    expect(f.count('/auth/reset-password')).toBe(0);
  });

  it('sends token + newPassword (no auth header) and confirms; an expired link shows the server message', async () => {
    resetSearchRef = new URLSearchParams({ token: 't'.repeat(30) });
    let n = 0;
    const f = mockFetch(() => (++n === 1 ? fail(400, 'TOKEN_INVALID', 'This reset link has expired') : ok({ ok: true })));
    render(<ResetPasswordPage />);
    const user = userEvent.setup();
    const type = async () => {
      await user.type(screen.getByLabelText(/^new password/i), 'correct-horse-9');
      await user.type(screen.getByLabelText(/confirm password/i), 'correct-horse-9');
      await user.click(screen.getByRole('button', { name: /update password/i }));
    };
    await type();
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i);
    await type();
    expect(await screen.findByText(/password updated/i)).toBeInTheDocument();
    const body = JSON.parse(f.calls[1].body!);
    expect(body).toEqual({ token: 't'.repeat(30), newPassword: 'correct-horse-9' });
    expect(f.calls[1].headers.Authorization).toBeUndefined();
  });
});
