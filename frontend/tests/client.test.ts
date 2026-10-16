import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient, restoreSession, SESSION_EXPIRED_EVENT, sessionRequest, tokenStorage } from '@/lib/api/client';
import { fail, mockFetch, ok } from './helpers';

describe('apiClient: envelope and errors', () => {
  it('unwraps { success: true, data }', async () => {
    mockFetch(() => ok({ hello: 'world' }));
    await expect(apiClient('/x', { skipAuth: true })).resolves.toEqual({ hello: 'world' });
  });

  it('keeps HTTP status, backend code, message and details on failure', async () => {
    mockFetch(() => fail(409, 'ROOM_NOT_AVAILABLE', 'No rooms left', { nights: 2 }));
    const err = await apiClient('/x', { skipAuth: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'ROOM_NOT_AVAILABLE', message: 'No rooms left', details: { nights: 2 } });
  });

  it('turns a dead network into NETWORK_ERROR (status 0), never into data', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await apiClient('/x', { skipAuth: true }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ApiError', code: 'NETWORK_ERROR', status: 0 });
  });

  it('handles a non-JSON 502 as HTTP_502', async () => {
    mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const err = await apiClient('/x', { skipAuth: true }).catch((e) => e);
    expect(err).toMatchObject({ code: 'HTTP_502', status: 502 });
  });

  it('serialises params and drops empty ones', async () => {
    const f = mockFetch(() => ok([]));
    await apiClient('/x', { skipAuth: true, params: { a: 1, b: '', c: undefined, d: null, e: 'yes' } });
    expect(f.calls[0].url).toBe('http://localhost:3000/x?a=1&e=yes');
  });
});

describe('apiClient: 401 refresh (the refresh token is an HttpOnly cookie handled by /api/session/refresh)', () => {
  const REFRESH = '/api/session/refresh';
  const seed = () => tokenStorage.setAccess('old-access');

  it('refreshes once for concurrent 401s and replays each request once with the new token', async () => {
    seed();
    const f = mockFetch(async (c) => {
      if (c.url.endsWith(REFRESH)) {
        await new Promise((r) => setTimeout(r, 15));
        return ok({ accessToken: 'new-access', expiresIn: 900, user: {} });
      }
      return c.headers.Authorization === 'Bearer new-access' ? ok({ fine: true }) : fail(401, 'TOKEN_EXPIRED', 'expired');
    });
    const [a, b, c] = await Promise.all([apiClient('/a'), apiClient('/b'), apiClient('/c')]);
    expect([a, b, c]).toEqual([{ fine: true }, { fine: true }, { fine: true }]);
    // Refresh tokens are single-use: a second refresh with the same cookie would revoke the whole session family.
    expect(f.count(REFRESH)).toBe(1);
    expect(tokenStorage.getAccess()).toBe('new-access');
    expect(f.calls.filter((x) => x.url.endsWith('/a')).length).toBe(2); // original + one replay
  });

  it('the refresh call is same-origin, carries the CSRF header and no token in its body', async () => {
    seed();
    const f = mockFetch((c) => (c.url.endsWith(REFRESH) ? ok({ accessToken: 'n' }) : c.headers.Authorization === 'Bearer n' ? ok({}) : fail(401, 'TOKEN_EXPIRED', 'expired')));
    await apiClient('/a');
    const call = f.calls.find((x) => x.url.endsWith(REFRESH))!;
    expect(call.url).toBe(REFRESH); // relative: never sent to the API origin directly
    expect(call.method).toBe('POST');
    expect(call.headers['X-Tirvona-CSRF']).toBe('1');
    expect(call.body).toBeUndefined();
    expect(f.fn.mock.calls.find(([u]) => String(u) === REFRESH)![1]).toMatchObject({ credentials: 'same-origin' });
  });

  it('when refresh is refused: clears the session, announces it, surfaces the 401, and does not loop', async () => {
    seed();
    const events: string[] = [];
    window.addEventListener(SESSION_EXPIRED_EVENT, () => events.push('expired'));
    const f = mockFetch((c) => (c.url.endsWith(REFRESH) ? fail(401, 'TOKEN_INVALID', 'revoked') : fail(401, 'TOKEN_EXPIRED', 'expired')));
    const err = await apiClient('/a').catch((e) => e);
    expect(err).toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });
    expect(f.count(REFRESH)).toBe(1);
    expect(f.calls.filter((x) => x.url.endsWith('/a')).length).toBe(1); // not replayed without a new token
    expect(tokenStorage.getAccess()).toBeNull();
    expect(events).toEqual(['expired']);
  });

  it('a second 401 after a successful refresh is returned, not refreshed again', async () => {
    seed();
    const f = mockFetch((c) => (c.url.endsWith(REFRESH) ? ok({ accessToken: 'n' }) : fail(401, 'TOKEN_INVALID', 'still no')));
    const err = await apiClient('/a').catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(f.count(REFRESH)).toBe(1);
    expect(f.calls.filter((x) => x.url.endsWith('/a')).length).toBe(2);
  });

  it('keeps the session when refresh fails only because the network is down', async () => {
    seed();
    mockFetch((c) => {
      if (c.url.endsWith(REFRESH)) throw new TypeError('offline');
      return fail(401, 'TOKEN_EXPIRED', 'expired');
    });
    const err = await apiClient('/a').catch((e) => e);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(tokenStorage.getAccess()).toBe('old-access'); // not destroyed by a brief outage
  });

  it('does not touch the session when the refresh endpoint has a 5xx', async () => {
    seed();
    mockFetch((c) => (c.url.endsWith(REFRESH) ? fail(503, 'UNAVAILABLE', 'down') : fail(401, 'TOKEN_EXPIRED', 'expired')));
    await apiClient('/a').catch(() => undefined);
    expect(tokenStorage.getAccess()).toBe('old-access');
  });

  it('never refreshes for public / credential (skipAuth) requests', async () => {
    seed();
    const f = mockFetch(() => fail(401, 'UNAUTHORIZED', 'nope'));
    await apiClient('/public/x', { skipAuth: true }).catch(() => undefined);
    await apiClient('/auth/forgot-password', { method: 'POST', skipAuth: true }).catch(() => undefined);
    expect(f.count(REFRESH)).toBe(0);
  });

  it('DOES refresh for /auth/me (authenticated): a reload with an expired access token must not sign the user out', async () => {
    seed();
    const f = mockFetch((c) => {
      if (c.url.endsWith(REFRESH)) return ok({ accessToken: 'new-access' });
      return c.headers.Authorization === 'Bearer new-access' ? ok({ email: 'o@x.co' }) : fail(401, 'TOKEN_EXPIRED', 'expired');
    });
    await expect(apiClient('/auth/me')).resolves.toEqual({ email: 'o@x.co' });
    expect(f.count(REFRESH)).toBe(1);
  });
});

describe('session storage: nothing secret reaches JavaScript-readable storage', () => {
  it('a sign-in stores the short-lived access token in memory only, never a refresh token, never in localStorage', async () => {
    mockFetch(() => ok({ accessToken: 'access-1', expiresIn: 900, user: { _id: 'u1' } }));
    await sessionRequest('login', { email: 'a@b.co', password: 'x' });
    // sessionRequest only carries the response; the caller (authApi) keeps the token in memory.
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/access-1|refresh/i);
    expect(JSON.stringify(document.cookie)).not.toMatch(/refresh|tv_rt/i);
  });

  it('sessionRequest posts to the same-origin session route with the CSRF header and never to the API origin', async () => {
    const f = mockFetch(() => ok({ accessToken: 'a', user: {} }));
    await sessionRequest('login', { email: 'a@b.co', password: 'pw' });
    const [url, init] = f.fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session/login');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect((init.headers as Record<string, string>)['X-Tirvona-CSRF']).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@b.co', password: 'pw' });
  });

  it('logout sends the current access token so the API can revoke the session, and surfaces failures as ApiError', async () => {
    tokenStorage.setAccess('at-9');
    const f = mockFetch(() => ok({ ok: true }));
    await sessionRequest('logout');
    expect(f.calls[0].headers.Authorization).toBe('Bearer at-9');
    mockFetch(() => fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password'));
    await expect(sessionRequest('login', {})).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
  });

  it('restoreSession exchanges the cookie for an access token, or reports that there is no session', async () => {
    mockFetch(() => ok({ accessToken: 'restored' }));
    await expect(restoreSession()).resolves.toBe('restored');
    expect(tokenStorage.getAccess()).toBe('restored');
    mockFetch(() => fail(401, 'NO_SESSION', 'No active session'));
    await expect(restoreSession()).resolves.toBeNull();
    expect(tokenStorage.getAccess()).toBeNull();
  });

  it('removes tokens that older versions left in localStorage', async () => {
    localStorage.setItem('tirvona_rt', 'old-refresh-token');
    localStorage.setItem('tirvona_at', 'old-access-token');
    vi.resetModules();
    await import('@/lib/api/client');
    expect(localStorage.getItem('tirvona_rt')).toBeNull();
    expect(localStorage.getItem('tirvona_at')).toBeNull();
  });
});
