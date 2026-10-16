import { apiClient, sessionRequest, tokenStorage } from './client';
import { AuthTokens, User } from '@/types';

export interface LoginPayload {
  email: string;
  password: string;
}

export interface RegisterPayload {
  organizationName: string;
  name: string;
  email: string;
  password: string;
  phone?: string;
}

/**
 * POST /api/session/login | register -> { accessToken, expiresIn, user }. The app's server keeps the refresh token in an HttpOnly
 * cookie: it is never part of this response and never reaches JavaScript.
 */
export type AuthSession = AuthTokens & { user: User };

function persistSession(res: AuthSession): { user: User; tokens: AuthTokens } {
  if (!res?.accessToken || !res?.user) {
    // Never treat a malformed "success" as a session.
    throw new Error('The server returned an invalid sign-in response.');
  }
  tokenStorage.setAccess(res.accessToken);
  tokenStorage.setUser(res.user);
  const { user, ...tokens } = res;
  return { user, tokens };
}

export const authApi = {
  async login(payload: LoginPayload): Promise<{ user: User; tokens: AuthTokens }> {
    const res = await sessionRequest<AuthSession>('login', payload);
    return persistSession(res);
  },

  async register(payload: RegisterPayload): Promise<{ user: User; tokens: AuthTokens }> {
    const body: RegisterPayload = { ...payload };
    if (!body.phone) delete body.phone; // backend rejects an empty phone (E.164)
    const res = await sessionRequest<AuthSession>('register', body);
    return persistSession(res);
  },

  me(): Promise<User> {
    return apiClient<User>('/auth/me');
  },

  /** Own name/phone. The e-mail and role are not editable here. */
  updateProfile(payload: { name?: string; phone?: string }): Promise<User> {
    return apiClient<User>('/users/me', { method: 'PATCH', body: JSON.stringify(payload) });
  },

  /** Needs the current password. The server ends every other login of this account and keeps this one. */
  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return apiClient<{ ok: boolean }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
  },

  forgotPassword(email: string): Promise<{ ok: boolean }> {
    return apiClient<{ ok: boolean }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
      skipAuth: true,
    });
  },

  /** Sets a new password from an e-mailed token. The server revokes all sessions of the user. */
  resetPassword(token: string, newPassword: string): Promise<{ ok: boolean }> {
    return apiClient<{ ok: boolean }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
      skipAuth: true,
    });
  },

  /** Local session state is always cleared, even if the server call fails. */
  async logout(): Promise<void> {
    try {
      await sessionRequest('logout'); // revokes the session on the API and clears the cookie
    } catch {
      // Server-side revocation is best effort; the local session is removed regardless.
    } finally {
      tokenStorage.clear();
    }
  },
};
