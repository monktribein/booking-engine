/**
 * Server-side session endpoints (/api/session/login | register | refresh | logout).
 *
 * Why this exists: the API issues a long-lived refresh token. If the browser kept it in localStorage, any script injected into
 * the page (XSS) could steal it and keep the session alive for 30 days. Here the refresh token is stored ONLY in an HttpOnly
 * cookie that JavaScript cannot read. Signing in, rotating and signing out go through this server, which talks to the API on the
 * browser's behalf. The short-lived access token (15 minutes) is returned to the page and kept in memory only.
 *
 * Cookie: HttpOnly, SameSite=Strict, Secure on https, scoped to /api/session so it is sent to nothing else.
 * CSRF: the cookie is only ever used by these endpoints. Each request must carry the custom header X-Tirvona-CSRF (a cross-site
 * page cannot add it without a CORS preflight, which these endpoints never grant), and an Origin / Fetch-Metadata that is not
 * cross-site. SameSite=Strict already stops the browser from sending the cookie on a cross-site request.
 *
 * Nothing in this file logs or returns the refresh token to the browser.
 */

export const CSRF_HEADER = 'x-tirvona-csrf';
const COOKIE = 'tv_rt';
const SECURE_COOKIE = '__Secure-tv_rt';
/** A readable, non-secret flag so the page does not call refresh for visitors who never signed in. It grants nothing. */
export const SESSION_HINT_COOKIE = 'tv_s';
const REFRESH_MAX_AGE = 30 * 24 * 3600;

export type SessionAction = 'login' | 'register' | 'refresh' | 'logout';
export const SESSION_ACTIONS: readonly SessionAction[] = ['login', 'register', 'refresh', 'logout'];

export interface SessionDeps {
  /** API origin used server-side, e.g. https://api.example.com */
  apiBase: string;
  /** Shared secret that lets the API trust the forwarded client address (see backend common/client-ip.ts). */
  bffSecret?: string;
  fetch?: typeof fetch;
}

const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
  const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const [k, v] of Object.entries(headers)) for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
  return new Response(JSON.stringify(body), { status, headers: h });
};
const failure = (status: number, code: string, message: string, headers?: Record<string, string | string[]>) => json(status, { success: false, error: { code, message } }, headers);

function isSecure(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  return (proto ?? new URL(req.url).protocol.replace(':', '')) === 'https';
}

function cookie(name: string, value: string, opts: { maxAge: number; httpOnly: boolean; path: string; sameSite: 'Strict' | 'Lax'; secure: boolean }): string {
  return [`${name}=${value}`, `Path=${opts.path}`, `Max-Age=${opts.maxAge}`, `SameSite=${opts.sameSite}`, ...(opts.httpOnly ? ['HttpOnly'] : []), ...(opts.secure ? ['Secure'] : [])].join('; ');
}

const setSessionCookies = (req: Request, refreshToken: string) => [
  cookie(isSecure(req) ? SECURE_COOKIE : COOKIE, refreshToken, { maxAge: REFRESH_MAX_AGE, httpOnly: true, path: '/api/session', sameSite: 'Strict', secure: isSecure(req) }),
  cookie(SESSION_HINT_COOKIE, '1', { maxAge: REFRESH_MAX_AGE, httpOnly: false, path: '/', sameSite: 'Lax', secure: isSecure(req) }),
];
const clearSessionCookies = (req: Request) => [
  cookie(COOKIE, '', { maxAge: 0, httpOnly: true, path: '/api/session', sameSite: 'Strict', secure: false }),
  cookie(SECURE_COOKIE, '', { maxAge: 0, httpOnly: true, path: '/api/session', sameSite: 'Strict', secure: true }),
  cookie(SESSION_HINT_COOKIE, '', { maxAge: 0, httpOnly: false, path: '/', sameSite: 'Lax', secure: isSecure(req) }),
];

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** Rejects cross-site requests. Returns an error response, or null when the request may proceed. */
export function rejectCrossSite(req: Request): Response | null {
  if (req.headers.get(CSRF_HEADER) !== '1') return failure(403, 'CSRF_REJECTED', 'Missing CSRF header');
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return failure(403, 'CSRF_REJECTED', 'Cross-site request refused');
  const origin = req.headers.get('origin');
  if (origin) {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return failure(403, 'CSRF_REJECTED', 'Bad origin');
    }
    if (originHost !== host) return failure(403, 'CSRF_REJECTED', 'Cross-origin request refused');
  }
  return null;
}

function clientAddress(req: Request): string | undefined {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip')?.trim() || undefined;
}

interface Upstream {
  status: number;
  body: { success?: boolean; data?: { accessToken?: string; refreshToken?: string; expiresIn?: number; user?: unknown }; error?: unknown } | null;
}

async function callApi(req: Request, deps: SessionDeps, path: string, init: { body?: string; authorization?: string }): Promise<Upstream | { networkError: true }> {
  const ip = clientAddress(req);
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': req.headers.get('user-agent')?.slice(0, 300) ?? 'tirvona-web' };
  if (init.authorization) headers.authorization = init.authorization;
  if (deps.bffSecret && ip) {
    headers['x-tirvona-bff-secret'] = deps.bffSecret;
    headers['x-tirvona-client-ip'] = ip;
  }
  try {
    const res = await (deps.fetch ?? fetch)(`${deps.apiBase.replace(/\/+$/, '')}${path}`, { method: 'POST', headers, body: init.body ?? '{}', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    return { status: res.status, body: (await res.json().catch(() => null)) as Upstream['body'] };
  } catch {
    return { networkError: true };
  }
}

/** The envelope the page receives: the access token and the user, never the refresh token. */
function sessionResponse(req: Request, up: Upstream): Response {
  const data = up.body?.data;
  if (!data?.accessToken || !data.refreshToken || !data.user) return failure(502, 'BAD_UPSTREAM', 'The server returned an invalid sign-in response.');
  return json(200, { success: true, data: { accessToken: data.accessToken, expiresIn: data.expiresIn, user: data.user } }, { 'set-cookie': setSessionCookies(req, data.refreshToken) });
}

export async function handleSession(action: string, req: Request, deps: SessionDeps): Promise<Response> {
  if (!(SESSION_ACTIONS as readonly string[]).includes(action)) return failure(404, 'NOT_FOUND', 'Unknown session action');
  if (req.method !== 'POST') return failure(405, 'METHOD_NOT_ALLOWED', 'Use POST');
  const blocked = rejectCrossSite(req);
  if (blocked) return blocked;

  if (action === 'login' || action === 'register') {
    const up = await callApi(req, deps, `/auth/${action}`, { body: await req.text() });
    if ('networkError' in up) return failure(502, 'NETWORK_ERROR', 'Unable to reach the server.');
    // Failures (wrong password, validation, rate limit) pass through unchanged; no cookie is touched.
    if (up.status >= 400 || up.body?.success !== true) return json(up.status >= 400 ? up.status : 502, up.body ?? { success: false, error: { code: 'BAD_UPSTREAM', message: 'Unexpected response' } });
    return sessionResponse(req, up);
  }

  if (action === 'refresh') {
    const token = readCookie(req, SECURE_COOKIE) ?? readCookie(req, COOKIE);
    if (!token) return failure(401, 'NO_SESSION', 'No active session', { 'set-cookie': clearSessionCookies(req).slice(2) }); // only the readable hint is cleaned
    const up = await callApi(req, deps, '/auth/refresh', { body: JSON.stringify({ refreshToken: token }) });
    if ('networkError' in up) return failure(503, 'NETWORK_ERROR', 'Unable to reach the server.'); // keep the cookie: a brief outage must not sign anyone out
    if (up.status >= 500) return failure(503, 'UPSTREAM_ERROR', 'The server could not refresh your session.');
    if (up.status === 401 || up.status === 403 || up.body?.success !== true) {
      return json(401, up.body ?? { success: false, error: { code: 'TOKEN_INVALID', message: 'Session ended' } }, { 'set-cookie': clearSessionCookies(req) });
    }
    return sessionResponse(req, up);
  }

  // logout: revoke on the server (best effort), always clear the cookies.
  const authorization = req.headers.get('authorization') ?? undefined;
  if (authorization) await callApi(req, deps, '/auth/logout', { authorization });
  return json(200, { success: true, data: { ok: true } }, { 'set-cookie': clearSessionCookies(req) });
}
