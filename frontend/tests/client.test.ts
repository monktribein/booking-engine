import { describe, expect, it } from 'vitest';
import { ApiError, apiClient, SESSION_EXPIRED_EVENT, tokenStorage } from '@/lib/api/client';
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

describe('apiClient: 401 refresh', () => {
  const seed = () => {
    tokenStorage.setAccess('old-access');
    tokenStorage.setRefresh('refresh-1');
  };

  it('refreshes once for concurrent 401s and replays each request once with the new token', async () => {
    seed();
    const f = mockFetch(async (c) => {
      if (c.url.endsWith('/auth/refresh')) {
        await new Promise((r) => setTimeout(r, 15));
        return ok({ accessToken: 'new-access', refreshToken: 'refresh-2', expiresIn: 900 });
      }
      return c.headers.Authorization === 'Bearer new-access' ? ok({ fine: true }) : fail(401, 'TOKEN_EXPIRED', 'expired');
    });
    const [a, b, c] = await Promise.all([apiClient('/a'), apiClient('/b'), apiClient('/c')]);
    expect([a, b, c]).toEqual([{ fine: true }, { fine: true }, { fine: true }]);
    // Refresh tokens are single-use: a second refresh with the same token would revoke the session family.
    expect(f.count('/auth/refresh')).toBe(1);
    expect(tokenStorage.getAccess()).toBe('new-access');
    expect(tokenStorage.getRefresh()).toBe('refresh-2');
    expect(f.calls.filter((x) => x.url.endsWith('/a')).length).toBe(2); // original + one replay
  });

  it('when refresh is refused: clears the session, announces it, surfaces the 401, and does not loop', async () => {
    seed();
    const events: string[] = [];
    window.addEventListener(SESSION_EXPIRED_EVENT, () => events.push('expired'));
    const f = mockFetch((c) => (c.url.endsWith('/auth/refresh') ? fail(401, 'TOKEN_INVALID', 'revoked') : fail(401, 'TOKEN_EXPIRED', 'expired')));
    const err = await apiClient('/a').catch((e) => e);
    expect(err).toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });
    expect(f.count('/auth/refresh')).toBe(1);
    expect(f.calls.filter((x) => x.url.endsWith('/a')).length).toBe(1); // not replayed without a new token
    expect(tokenStorage.getAccess()).toBeNull();
    expect(tokenStorage.getRefresh()).toBeNull();
    expect(events).toEqual(['expired']);
  });

  it('a second 401 after a successful refresh is returned, not refreshed again', async () => {
    seed();
    const f = mockFetch((c) => (c.url.endsWith('/auth/refresh') ? ok({ accessToken: 'n', refreshToken: 'r2' }) : fail(401, 'TOKEN_INVALID', 'still no')));
    const err = await apiClient('/a').catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(f.count('/auth/refresh')).toBe(1);
    expect(f.calls.filter((x) => x.url.endsWith('/a')).length).toBe(2);
  });

  it('keeps the session when refresh fails only because the network is down', async () => {
    seed();
    mockFetch((c) => {
      if (c.url.endsWith('/auth/refresh')) throw new TypeError('offline');
      return fail(401, 'TOKEN_EXPIRED', 'expired');
    });
    const err = await apiClient('/a').catch((e) => e);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(tokenStorage.getRefresh()).toBe('refresh-1'); // not destroyed by a brief outage
  });

  it('does not touch the session when the refresh endpoint has a 5xx', async () => {
    seed();
    mockFetch((c) => (c.url.endsWith('/auth/refresh') ? fail(503, 'UNAVAILABLE', 'down') : fail(401, 'TOKEN_EXPIRED', 'expired')));
    await apiClient('/a').catch(() => undefined);
    expect(tokenStorage.getRefresh()).toBe('refresh-1');
  });

  it('never refreshes for public / credential (skipAuth) requests', async () => {
    seed();
    const f = mockFetch(() => fail(401, 'UNAUTHORIZED', 'nope'));
    await apiClient('/public/x', { skipAuth: true }).catch(() => undefined);
    await apiClient('/auth/login', { method: 'POST', skipAuth: true }).catch(() => undefined);
    expect(f.count('/auth/refresh')).toBe(0);
  });

  it('DOES refresh for /auth/me (authenticated): a reload with an expired access token must not sign the user out', async () => {
    seed();
    const f = mockFetch((c) => {
      if (c.url.endsWith('/auth/refresh')) return ok({ accessToken: 'new-access', refreshToken: 'refresh-2' });
      return c.headers.Authorization === 'Bearer new-access' ? ok({ email: 'o@x.co' }) : fail(401, 'TOKEN_EXPIRED', 'expired');
    });
    await expect(apiClient('/auth/me')).resolves.toEqual({ email: 'o@x.co' });
    expect(f.count('/auth/refresh')).toBe(1);
  });

  it('sends no refresh request when there is no refresh token', async () => {
    tokenStorage.setAccess('a');
    const f = mockFetch(() => fail(401, 'TOKEN_EXPIRED', 'expired'));
    await apiClient('/a').catch(() => undefined);
    expect(f.count('/auth/refresh')).toBe(0);
  });
});
