import { apiClient, tokenStorage } from './client';
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

/** Backend contract: POST /auth/login | /auth/register -> { accessToken, refreshToken, expiresIn, user } */
export type AuthSession = AuthTokens & { user: User };

function persistSession(res: AuthSession): { user: User; tokens: AuthTokens } {
  if (!res?.accessToken || !res?.user) {
    // Never treat a malformed "success" as a session.
    throw new Error('The server returned an invalid sign-in response.');
  }
  tokenStorage.setAccess(res.accessToken);
  if (res.refreshToken) tokenStorage.setRefresh(res.refreshToken);
  const { user, ...tokens } = res;
  return { user, tokens };
}

export const authApi = {
  async login(payload: LoginPayload): Promise<{ user: User; tokens: AuthTokens }> {
    const res = await apiClient<AuthSession>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
      skipAuth: true,
    });
    return persistSession(res);
  },

  async register(payload: RegisterPayload): Promise<{ user: User; tokens: AuthTokens }> {
    const body: RegisterPayload = { ...payload };
    if (!body.phone) delete body.phone; // backend rejects an empty phone (E.164)
    const res = await apiClient<AuthSession>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
      skipAuth: true,
    });
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
      if (tokenStorage.getAccess()) {
        await apiClient('/auth/logout', { method: 'POST' });
      }
    } catch {
      // Server-side revocation is best effort; the local session is removed regardless.
    } finally {
      tokenStorage.clear();
    }
  },
};
