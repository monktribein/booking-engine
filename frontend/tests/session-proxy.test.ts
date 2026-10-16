import { describe, expect, it, vi } from 'vitest';
import { handleSession } from '@/lib/server/session-proxy';

const REFRESH = 'refresh-token-from-the-api-0123456789';
const USER = { _id: 'u1', organizationId: 'o1', name: 'Owner', email: 'o@example.com', role: 'PROPERTY_OWNER', status: 'ACTIVE' };
const upstreamOk = { success: true, data: { accessToken: 'access-jwt', refreshToken: REFRESH, expiresIn: 900, user: USER } };

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  });
  const deps = { apiBase: 'https://api.example.com/', bffSecret: 'b'.repeat(40), fetch: fetchMock as unknown as typeof fetch };
  return { calls, deps };
}

const post = (action: string, init: { headers?: Record<string, string>; body?: unknown; url?: string } = {}) =>
  new Request(init.url ?? `https://app.example.com/api/session/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tirvona-csrf': '1', origin: 'https://app.example.com', host: 'app.example.com', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', ...(init.headers ?? {}) },
    body: init.body === undefined ? '{}' : JSON.stringify(init.body),
  });

const cookiesOf = (res: Response) => res.headers.getSetCookie();
const sessionCookie = (res: Response) => cookiesOf(res).find((c) => /^(__Secure-)?tv_rt=/.test(c));

describe('session proxy: sign-in keeps the refresh token in an HttpOnly cookie', () => {
  it('login: the cookie is HttpOnly + SameSite=Strict + scoped to /api/session, and the body never carries the refresh token', async () => {
    const { deps, calls } = setup(() => reply(200, upstreamOk));
    const res = await handleSession('login', post('login', { body: { email: 'o@example.com', password: 'pw' } }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { accessToken: 'access-jwt', expiresIn: 900, user: USER } });
    expect(JSON.stringify(body)).not.toContain(REFRESH);

    const c = sessionCookie(res)!;
    expect(c).toContain(`=${REFRESH}`);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).toMatch(/Path=\/api\/session/);
    expect(c).toMatch(/Max-Age=2592000/);
    expect(c).toMatch(/Secure/); // https request
    expect(c.startsWith('__Secure-tv_rt=')).toBe(true);
    const hint = cookiesOf(res).find((x) => x.startsWith('tv_s='))!;
    expect(hint).not.toMatch(/HttpOnly/); // readable flag, holds nothing secret
    expect(hint).toContain('tv_s=1');
    expect(hint).not.toContain(REFRESH);
    expect(res.headers.get('cache-control')).toBe('no-store');

    // The API call: the credentials are passed through, the real client address is forwarded with the shared secret.
    expect(calls[0].url).toBe('https://api.example.com/auth/login');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: 'o@example.com', password: 'pw' });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['x-tirvona-client-ip']).toBe('203.0.113.9');
    expect(h['x-tirvona-bff-secret']).toBe('b'.repeat(40));
  });

  it('a plain-http local run still works: no Secure flag, plain cookie name', async () => {
    const { deps } = setup(() => reply(200, upstreamOk));
    const res = await handleSession('login', post('login', { url: 'http://localhost:3001/api/session/login', headers: { origin: 'http://localhost:3001', host: 'localhost:3001' } }), deps);
    const c = sessionCookie(res)!;
    expect(c.startsWith('tv_rt=')).toBe(true);
    expect(c).not.toMatch(/Secure/);
    expect(c).toMatch(/HttpOnly/);
  });

  it('a failed login passes the API status and message through and sets no cookie', async () => {
    const { deps } = setup(() => reply(401, { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }));
    const res = await handleSession('login', post('login'), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
    expect(cookiesOf(res)).toEqual([]);
  });

  it('rate limits (429) and validation errors (400) are passed through unchanged', async () => {
    for (const [status, code] of [[429, 'RATE_LIMITED'], [400, 'VALIDATION_ERROR']] as const) {
      const { deps } = setup(() => reply(status, { success: false, error: { code, message: 'x' } }));
      const res = await handleSession('register', post('register'), deps);
      expect([res.status, (await res.json()).error.code]).toEqual([status, code]);
      expect(cookiesOf(res)).toEqual([]);
    }
  });

  it('an invalid "success" from the API (no refresh token) is refused and sets nothing', async () => {
    const { deps } = setup(() => reply(200, { success: true, data: { accessToken: 'a', user: USER } }));
    const res = await handleSession('login', post('login'), deps);
    expect(res.status).toBe(502);
    expect(cookiesOf(res)).toEqual([]);
  });

  it('API unreachable on login: an error, no session', async () => {
    const { deps } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const res = await handleSession('login', post('login'), deps);
    expect(res.status).toBe(502);
    expect(cookiesOf(res)).toEqual([]);
  });

  it('without the shared secret configured, the forwarding headers are not sent', async () => {
    const { deps, calls } = setup(() => reply(200, upstreamOk));
    await handleSession('login', post('login'), { ...deps, bffSecret: undefined });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['x-tirvona-bff-secret']).toBeUndefined();
    expect(h['x-tirvona-client-ip']).toBeUndefined();
  });
});

describe('session proxy: refresh rotates the cookie', () => {
  const withCookie = (value = REFRESH, name = '__Secure-tv_rt') => ({ cookie: `other=1; ${name}=${value}; tv_s=1` });

  it('exchanges the cookie for an access token and stores the ROTATED refresh token', async () => {
    const { deps, calls } = setup(() => reply(200, { success: true, data: { accessToken: 'access-2', refreshToken: 'rotated-refresh-token-0123456789', expiresIn: 900, user: USER } }));
    const res = await handleSession('refresh', post('refresh', { headers: withCookie() }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).data.accessToken).toBe('access-2');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ refreshToken: REFRESH });
    expect(sessionCookie(res)).toContain('=rotated-refresh-token-0123456789');
  });

  it('no cookie: 401 NO_SESSION and the API is not called', async () => {
    const { deps, calls } = setup(() => reply(200, upstreamOk));
    const res = await handleSession('refresh', post('refresh'), deps);
    expect([res.status, (await res.json()).error.code]).toEqual([401, 'NO_SESSION']);
    expect(calls).toHaveLength(0);
  });

  it('a refused or reused token ends the session: 401 and every cookie is cleared', async () => {
    const { deps } = setup(() => reply(401, { success: false, error: { code: 'TOKEN_REUSED', message: 'reused' } }));
    const res = await handleSession('refresh', post('refresh', { headers: withCookie() }), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('TOKEN_REUSED');
    const cleared = cookiesOf(res);
    expect(cleared.some((c) => /tv_rt=;.*Max-Age=0/.test(c))).toBe(true);
    expect(cleared.some((c) => /^tv_s=;.*Max-Age=0/.test(c))).toBe(true);
  });

  it('a server error or an outage does NOT sign anyone out: 503 and the cookie is left alone', async () => {
    for (const respond of [() => reply(503, { success: false }), () => { throw new TypeError('offline'); }] as const) {
      const { deps } = setup(respond);
      const res = await handleSession('refresh', post('refresh', { headers: withCookie() }), deps);
      expect(res.status).toBe(503);
      expect(cookiesOf(res)).toEqual([]);
    }
  });

  it('also accepts the cookie name used on plain http', async () => {
    const { deps, calls } = setup(() => reply(200, upstreamOk));
    await handleSession('refresh', post('refresh', { headers: withCookie(REFRESH, 'tv_rt') }), deps);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ refreshToken: REFRESH });
  });
});

describe('session proxy: logout', () => {
  it('revokes on the API with the access token and clears the cookies', async () => {
    const { deps, calls } = setup(() => reply(200, { success: true, data: { ok: true } }));
    const res = await handleSession('logout', post('logout', { headers: { authorization: 'Bearer access-jwt' } }), deps);
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://api.example.com/auth/logout');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer access-jwt');
    expect(cookiesOf(res).filter((c) => /Max-Age=0/.test(c))).toHaveLength(3);
  });

  it('clears the cookies even when the API is down or no access token is sent', async () => {
    const { deps, calls } = setup(() => {
      throw new TypeError('offline');
    });
    const res = await handleSession('logout', post('logout', { headers: { authorization: 'Bearer x' } }), deps);
    expect(res.status).toBe(200);
    expect(cookiesOf(res).filter((c) => /Max-Age=0/.test(c))).toHaveLength(3);
    const none = await handleSession('logout', post('logout'), deps);
    expect(none.status).toBe(200);
    expect(calls).toHaveLength(1); // no API call without a token
  });
});

describe('session proxy: CSRF', () => {
  it('refuses a request without the custom header, from another origin, or marked cross-site by the browser', async () => {
    const { deps, calls } = setup(() => reply(200, upstreamOk));
    const cases: [string, Request][] = [
      ['no CSRF header', post('login', { headers: { 'x-tirvona-csrf': '' } })],
      ['another origin', post('login', { headers: { origin: 'https://evil.example.net' } })],
      ['sec-fetch-site cross-site', post('login', { headers: { 'sec-fetch-site': 'cross-site' } })],
      ['sec-fetch-site same-site (a sibling subdomain)', post('login', { headers: { 'sec-fetch-site': 'same-site' } })],
      ['a malformed origin', post('login', { headers: { origin: 'not a url' } })],
    ];
    for (const [label, req] of cases) {
      const res = await handleSession('login', req, deps);
      expect([label, res.status, (await res.json()).error.code]).toEqual([label, 403, 'CSRF_REJECTED']);
      expect(cookiesOf(res)).toEqual([]);
    }
    expect(calls).toHaveLength(0); // nothing reached the API
  });

  it('applies to every action, including the one that uses the cookie', async () => {
    const { deps } = setup(() => reply(200, upstreamOk));
    for (const action of ['login', 'register', 'refresh', 'logout']) {
      const res = await handleSession(action, post(action, { headers: { origin: 'https://evil.example.net', cookie: `tv_rt=${REFRESH}` } }), deps);
      expect([action, res.status]).toEqual([action, 403]);
    }
  });

  it('accepts a same-origin browser request behind a proxy (x-forwarded-host) and Fetch-Metadata same-origin', async () => {
    const { deps } = setup(() => reply(200, upstreamOk));
    const res = await handleSession('login', post('login', { headers: { host: 'internal:3000', 'x-forwarded-host': 'app.example.com', 'sec-fetch-site': 'same-origin' } }), deps);
    expect(res.status).toBe(200);
  });

  it('unknown actions are 404 and other methods are 405', async () => {
    const { deps } = setup(() => reply(200, upstreamOk));
    expect((await handleSession('whoami', post('whoami'), deps)).status).toBe(404);
    expect((await handleSession('login', new Request('https://app.example.com/api/session/login', { method: 'GET' }), deps)).status).toBe(405);
  });
});
