import { ApiError, apiClient, tokenStorage } from '@/lib/api/client';
import type { User } from '@/types';

/**
 * Signs in for the live tests (which run in Node, against a running API). The browser app signs in through its own server so the
 * refresh token stays in an HttpOnly cookie; Node has no cookie jar and the live tests do not need one, so they call the API
 * directly and keep only the short-lived access token, exactly as the page does in memory.
 */
export async function liveLogin(payload: { email: string; password: string }): Promise<{ user: User }> {
  const res = await apiClient<{ accessToken: string; user: User }>('/auth/login', { method: 'POST', body: JSON.stringify(payload), skipAuth: true });
  tokenStorage.setAccess(res.accessToken);
  return { user: res.user };
}

export { ApiError };
