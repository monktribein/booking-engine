/**
 * Centralized HTTP Client for Tirvona NestJS API
 *
 * Rules:
 * - Unwraps { success: true, data: T } response envelope
 * - Throws structured ApiError ({ code, message, status, details }) on every failure.
 *   It never substitutes fabricated data for a failed request.
 * - Attaches JWT Bearer token
 * - Refreshes an expired access token. Refresh tokens rotate and are single-use, so
 *   concurrent 401s share ONE in-flight refresh (a second use of the same token would
 *   make the backend revoke the whole session family).
 * - A request is replayed at most once after a refresh. A 401 comes from the auth guard
 *   before any handler runs, so replaying a POST/PATCH/DELETE cannot double-apply it.
 * - Never leaks OTA credentials
 */

// Browser: the public API origin compiled in at build time. Server-side rendering inside a container network may use a
// private service URL (API_INTERNAL_URL, runtime-only, never sent to the browser) and falls back to the public one.
const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const API_BASE_URL = typeof window === 'undefined' ? process.env.API_INTERNAL_URL || PUBLIC_API_URL : PUBLIC_API_URL;

export const SESSION_EXPIRED_EVENT = 'tirvona:session-expired';

export class ApiError extends Error {
  code: string;
  details?: unknown;
  status: number;

  constructor(message: string, code: string = 'UNKNOWN_ERROR', status: number = 400, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined | null>;
  skipAuth?: boolean;
}

// The access token (15 minutes) lives in memory only. The refresh token is an HttpOnly cookie that JavaScript cannot read; it is used
// solely by the same-origin /api/session/* endpoints (lib/server/session-proxy.ts). A reload therefore starts without an access
// token and gets a new one from /api/session/refresh.
let accessToken: string | null = null;

// Earlier versions kept both tokens in localStorage. Remove them so a stale refresh token can never be read by injected script.
if (typeof window !== 'undefined') {
  try {
    localStorage.removeItem('tirvona_at');
    localStorage.removeItem('tirvona_rt');
  } catch {
    /* storage unavailable */
  }
}

export const tokenStorage = {
  getAccess: (): string | null => accessToken,
  setAccess: (token: string) => {
    accessToken = token;
  },
  clear: () => {
    accessToken = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('tirvona_user');
      localStorage.removeItem('tirvona_property_id');
    }
  },
};

/** True when the server set its readable "a session exists" flag (it contains nothing secret). Saves a pointless refresh call for visitors. */
export function hasSessionHint(): boolean {
  return typeof document !== 'undefined' && /(?:^|;\s*)tv_s=1(?:;|$)/.test(document.cookie);
}

const SESSION_HEADERS = { 'Content-Type': 'application/json', 'X-Tirvona-CSRF': '1' };

let refreshInFlight: Promise<string | null> | null = null;

/** Test helper: forget any in-flight refresh and the in-memory access token. */
export function __resetClientStateForTests() {
  refreshInFlight = null;
  accessToken = null;
}

function endSession() {
  tokenStorage.clear();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
}

/**
 * Gets a new access token from the server, which rotates the refresh-token cookie. Resolves with the access token, or null when
 * the session is definitively over (no cookie, or the refresh was refused). A transient network or server failure throws instead,
 * so the session is NOT destroyed by a brief outage. Refresh tokens are single-use: concurrent callers share ONE in-flight call.
 */
function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    let res: Response;
    try {
      res = await fetch('/api/session/refresh', { method: 'POST', headers: SESSION_HEADERS, credentials: 'same-origin', cache: 'no-store' });
    } catch {
      throw new ApiError('Network error: Unable to reach the server. Please check your connection.', 'NETWORK_ERROR', 0);
    }

    if (res.status >= 500) {
      throw new ApiError('The server could not refresh your session. Please try again.', `HTTP_${res.status}`, res.status);
    }

    let body: { success?: boolean; data?: { accessToken?: string } } | null = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const data = body?.success === true ? body.data : null;
    if (!res.ok || !data?.accessToken) {
      endSession();
      return null;
    }
    tokenStorage.setAccess(data.accessToken);
    return data.accessToken as string;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/** Called once when the app starts: turns the session cookie (if any) into an in-memory access token. */
export function restoreSession(): Promise<string | null> {
  return refreshAccessToken();
}

/** login / register / logout go through the app's own server so the refresh token stays in the HttpOnly cookie. */
export async function sessionRequest<T>(action: 'login' | 'register' | 'logout', body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/session/${action}`, {
      method: 'POST',
      headers: { ...SESSION_HEADERS, ...(action === 'logout' && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      credentials: 'same-origin',
      cache: 'no-store',
      body: body === undefined ? '{}' : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Network error: Unable to reach the server. Please check your connection.', 'NETWORK_ERROR', 0);
  }
  return parseApiResponse<T>(res);
}

export async function apiClient<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { params, skipAuth = false, headers = {}, ...customConfig } = options;

  let url = `${API_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, val]) => {
      if (val !== undefined && val !== null && val !== '') {
        searchParams.append(key, String(val));
      }
    });
    const qs = searchParams.toString();
    if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;
  }

  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(headers as Record<string, string>),
  };

  if (!skipAuth) {
    const token = tokenStorage.getAccess();
    if (token) {
      reqHeaders['Authorization'] = `Bearer ${token}`;
    }
  }

  const send = async (h: Record<string, string>): Promise<Response> => {
    try {
      return await fetch(url, { ...customConfig, headers: h });
    } catch {
      // Network errors or backend offline
      throw new ApiError('Network error: Unable to reach the server. Please check your connection.', 'NETWORK_ERROR', 0);
    }
  };

  const response = await send(reqHeaders);

  // 401 on an authenticated request (including /auth/me and /auth/logout): refresh once (shared), replay once.
  // Credential endpoints (login, register, forgot/reset password) are skipAuth, so a wrong password never triggers a refresh;
  // the refresh call itself is a direct fetch, so it cannot recurse into this branch.
  if (response.status === 401 && !skipAuth) {
    const newAccess = await refreshAccessToken();
    if (newAccess) {
      const retried = await send({ ...reqHeaders, Authorization: `Bearer ${newAccess}` });
      return parseApiResponse<T>(retried); // a second 401 is surfaced as-is; no further refresh
    }
  }

  return parseApiResponse<T>(response);
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const code = body?.error?.code || `HTTP_${response.status}`;
    const message = body?.error?.message || response.statusText || 'An unexpected error occurred.';
    const details = body?.error?.details;
    throw new ApiError(message, code, response.status, details);
  }

  if (body && typeof body === 'object' && 'success' in body) {
    if (body.success === true) {
      return body.data as T;
    } else {
      const err = body.error || { code: 'UNKNOWN_ERROR', message: 'Request failed.' };
      throw new ApiError(err.message, err.code, response.status, err.details);
    }
  }

  return (body as T) ?? ({} as T);
}
