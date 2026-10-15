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

// Token storage helpers
export const tokenStorage = {
  getAccess: (): string | null => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('tirvona_at');
  },
  setAccess: (token: string) => {
    if (typeof window !== 'undefined') localStorage.setItem('tirvona_at', token);
  },
  getRefresh: (): string | null => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('tirvona_rt');
  },
  setRefresh: (token: string) => {
    if (typeof window !== 'undefined') localStorage.setItem('tirvona_rt', token);
  },
  clear: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('tirvona_at');
      localStorage.removeItem('tirvona_rt');
      localStorage.removeItem('tirvona_user');
      localStorage.removeItem('tirvona_property_id');
    }
  },
};

let refreshInFlight: Promise<string | null> | null = null;

/** Test helper: forget any in-flight refresh. */
export function __resetClientStateForTests() {
  refreshInFlight = null;
}

function endSession() {
  tokenStorage.clear();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
}

/**
 * Exchanges the stored refresh token for new tokens. Resolves with the new access token,
 * or null when the session is definitively over (refresh refused). A transient network
 * failure throws instead, so the session is NOT destroyed by a brief outage.
 */
function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  const refreshToken = tokenStorage.getRefresh();
  if (!refreshToken) return Promise.resolve(null);

  refreshInFlight = (async () => {
    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      throw new ApiError('Network error: Unable to reach the server. Please check your connection.', 'NETWORK_ERROR', 0);
    }

    if (res.status >= 500) {
      throw new ApiError('The server could not refresh your session. Please try again.', `HTTP_${res.status}`, res.status);
    }

    let body: { success?: boolean; data?: { accessToken?: string; refreshToken?: string } } | null = null;
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
    if (data.refreshToken) tokenStorage.setRefresh(data.refreshToken);
    return data.accessToken as string;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
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
