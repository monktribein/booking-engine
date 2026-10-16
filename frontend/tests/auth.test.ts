import { describe, expect, it } from 'vitest';
import { authApi } from '@/lib/api/auth';
import { tokenStorage } from '@/lib/api/client';
import { assertProductionRuntimeConfig, isDemoMode, UnsafeConfigError } from '@/lib/config';
import { fail, mockFetch, ok } from './helpers';

// What /api/session/login returns: the access token and the user. The refresh token stays in an HttpOnly cookie on the server side
// of the app and is never part of this response.
const session = {
  accessToken: 'jwt-from-server',
  expiresIn: 900,
  user: { _id: 'u1', organizationId: 'o1', name: 'Owner', email: 'owner@example.com', role: 'PROPERTY_OWNER', status: 'ACTIVE', createdAt: '2026-01-01' },
};

const noSession = () => {
  expect(tokenStorage.getAccess()).toBeNull();
  expect(localStorage.getItem('tirvona_user')).toBeNull();
};

describe('login', () => {
  it('keeps the access token in memory only (no refresh token, nothing in localStorage) and returns the user', async () => {
    const f = mockFetch(() => ok(session));
    const res = await authApi.login({ email: 'owner@example.com', password: 'correct-horse-9' });
    expect(res.user.email).toBe('owner@example.com');
    expect(tokenStorage.getAccess()).toBe('jwt-from-server');
    expect(f.calls[0].url).toBe('/api/session/login'); // through the app's own server, which holds the refresh-token cookie
    expect(f.calls[0].headers['X-Tirvona-CSRF']).toBe('1');
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/jwt-from-server|refresh/i);
  });

  it('wrong password: rejects with the backend status/message and creates no session', async () => {
    mockFetch(() => fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password'));
    const err = await authApi.login({ email: 'owner@example.com', password: 'bad' }).catch((e) => e);
    expect(err).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    noSession();
  });

  it.each(['owner@tirvona.demo', 'demo@x.com', 'admin@x.com'])('backend offline + demo-looking email (%s): rejects, fabricates nothing', async (email) => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await authApi.login({ email, password: 'anything' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    noSession();
  });

  it('a 500 from the server is an error, not a session', async () => {
    mockFetch(() => fail(500, 'INTERNAL_ERROR', 'boom'));
    await expect(authApi.login({ email: 'a@b.co', password: 'x' })).rejects.toMatchObject({ status: 500 });
    noSession();
  });

  it('a malformed "success" without tokens/user is rejected and stores nothing', async () => {
    mockFetch(() => ok({ accessToken: 'only-a-token' }));
    await expect(authApi.login({ email: 'a@b.co', password: 'x' })).rejects.toThrow(/invalid sign-in response/i);
    noSession();
  });
});

describe('register', () => {
  const payload = { organizationName: 'Org', name: 'Asha', email: 'asha@example.com', password: 'correct-horse-9', phone: '' };

  it('success stores the issued session; empty phone is not sent', async () => {
    const f = mockFetch(() => ok(session, 201));
    await authApi.register(payload);
    expect(JSON.parse(f.calls[0].body!)).not.toHaveProperty('phone');
    expect(tokenStorage.getAccess()).toBe('jwt-from-server');
  });

  it('backend rejection (email taken): rejects and creates no session', async () => {
    mockFetch(() => fail(409, 'EMAIL_TAKEN', 'Email already registered'));
    await expect(authApi.register(payload)).rejects.toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    noSession();
  });

  it('backend offline: rejects (the old code invented a session here)', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(authApi.register(payload)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    noSession();
  });
});

describe('me / forgot-password / logout', () => {
  it('me() failure is an error, never the cached or a demo user', async () => {
    localStorage.setItem('tirvona_user', JSON.stringify({ name: 'Stale' }));
    mockFetch(() => fail(500, 'INTERNAL_ERROR', 'boom'));
    await expect(authApi.me()).rejects.toMatchObject({ status: 500 });
  });

  it('forgotPassword failure is surfaced (not reported as sent)', async () => {
    mockFetch(() => fail(503, 'UNAVAILABLE', 'down'));
    await expect(authApi.forgotPassword('a@b.co')).rejects.toMatchObject({ status: 503 });
  });

  it('logout always clears local state, even if the server call fails', async () => {
    tokenStorage.setAccess('a');
    localStorage.setItem('tirvona_user', '{}');
    localStorage.setItem('tirvona_property_id', 'p1');
    mockFetch(() => fail(500, 'INTERNAL_ERROR', 'boom'));
    await authApi.logout();
    noSession();
    expect(localStorage.getItem('tirvona_property_id')).toBeNull();
  });

  it('logout calls the server with the access token, then clears', async () => {
    tokenStorage.setAccess('a');
    const f = mockFetch(() => ok({ ok: true }));
    await authApi.logout();
    expect(f.calls[0]).toMatchObject({ method: 'POST' });
    expect(f.calls[0].url).toBe('/api/session/logout'); // revokes on the API and clears the HttpOnly cookie
    expect(f.calls[0].headers.Authorization).toBe('Bearer a');
    expect(tokenStorage.getAccess()).toBeNull();
  });
});

describe('demo mode is fail-closed in production', () => {
  it('is off by default', () => {
    expect(isDemoMode({ NODE_ENV: 'development' })).toBe(false);
    expect(isDemoMode({ NODE_ENV: 'production' })).toBe(false);
  });

  it('may be enabled outside production (it only pre-fills the e-mail field)', () => {
    expect(isDemoMode({ NODE_ENV: 'development', NEXT_PUBLIC_DEMO_MODE: 'true' })).toBe(true);
    expect(isDemoMode({ NODE_ENV: 'test', NEXT_PUBLIC_DEMO_MODE: ' TRUE ' })).toBe(true);
  });

  it('throws when requested in a production build, whatever the casing', () => {
    expect(() => isDemoMode({ NODE_ENV: 'production', NEXT_PUBLIC_DEMO_MODE: 'true' })).toThrow(UnsafeConfigError);
    expect(() => isDemoMode({ NODE_ENV: 'production', NEXT_PUBLIC_DEMO_MODE: 'TRUE' })).toThrow(UnsafeConfigError);
  });

  it('other values do not enable it', () => {
    expect(isDemoMode({ NODE_ENV: 'development', NEXT_PUBLIC_DEMO_MODE: '1' })).toBe(false);
    expect(isDemoMode({ NODE_ENV: 'development', NEXT_PUBLIC_DEMO_MODE: 'false' })).toBe(false);
  });
});

describe('production runtime configuration is validated at startup', () => {
  const ok = { NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://api.example.com' };
  const msg = (env: Record<string, string | undefined>) => {
    try {
      assertProductionRuntimeConfig(env);
      return '';
    } catch (e) {
      expect(e).toBeInstanceOf(UnsafeConfigError);
      return (e as Error).message;
    }
  };

  it('accepts a correct production configuration, and does nothing outside production', () => {
    expect(msg(ok)).toBe('');
    expect(msg({ NODE_ENV: 'development' })).toBe('');
  });

  it('refuses to start without a browser-facing API URL', () => {
    expect(msg({ NODE_ENV: 'production' })).toMatch(/NEXT_PUBLIC_API_URL is required/);
    expect(msg({ ...ok, NEXT_PUBLIC_API_URL: 'not a url' })).toMatch(/not a valid URL/);
    expect(msg({ ...ok, NEXT_PUBLIC_API_URL: 'https://api.example.com/v1' })).toMatch(/origin without path/);
  });

  it('refuses a plain-http API unless explicitly allowed for a local production-mode run', () => {
    expect(msg({ ...ok, NEXT_PUBLIC_API_URL: 'http://api.example.com' })).toMatch(/must be https/);
    expect(msg({ ...ok, NEXT_PUBLIC_API_URL: 'http://localhost:3000', ALLOW_INSECURE_API_URL: 'true' })).toBe('');
  });

  it('refuses demo mode, a broken internal URL and secret-looking public variables', () => {
    expect(msg({ ...ok, NEXT_PUBLIC_DEMO_MODE: 'true' })).toMatch(/DEMO_MODE/);
    expect(msg({ ...ok, API_INTERNAL_URL: 'nope' })).toMatch(/API_INTERNAL_URL/);
    expect(msg({ ...ok, NEXT_PUBLIC_RAZORPAY_KEY_SECRET: 'x' })).toMatch(/looks like a secret/);
    expect(msg({ ...ok, NEXT_PUBLIC_JWT: 'x' })).toMatch(/looks like a secret/);
    expect(msg({ ...ok, NEXT_PUBLIC_RAZORPAY_KEY_ID: 'rzp_test_x' })).toBe(''); // the public key id is fine
  });
});
