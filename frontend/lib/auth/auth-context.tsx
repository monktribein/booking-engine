'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { User, UserRole } from '@/types';
import { authApi, ApiError, hasSessionHint, LoginPayload, RegisterPayload, restoreSession, SESSION_EXPIRED_EVENT, tokenStorage } from '../api';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** Set when the stored session could not be verified for a reason other than "signed out". */
  sessionError: ApiError | null;
  login: (payload: LoginPayload) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-reads the signed-in user (after the profile changed). */
  refreshUser: () => Promise<void>;
  hasRole: (roles: UserRole[]) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  // Starts true: the stored token is verified against the backend before anything renders as signed in.
  const [isLoading, setIsLoading] = useState(true);
  const [sessionError, setSessionError] = useState<ApiError | null>(null);
  const initRan = useRef(false);

  useEffect(() => {
    if (initRan.current) return; // avoid a duplicate /auth/me under React strict mode
    initRan.current = true;

    async function initAuth() {
      // The refresh token is an HttpOnly cookie we cannot read; the server leaves a readable flag when a session exists.
      if (!tokenStorage.getAccess() && !hasSessionHint()) {
        setIsLoading(false);
        return;
      }
      try {
        if (!tokenStorage.getAccess() && !(await restoreSession())) return; // the session ended: stay signed out
        setUser(await authApi.me());
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          tokenStorage.clear(); // token is definitively invalid
        } else {
          setSessionError(err instanceof ApiError ? err : new ApiError('Could not verify your session.', 'UNKNOWN_ERROR', 0));
        }
      } finally {
        setIsLoading(false);
      }
    }
    void initAuth();
  }, []);

  // The API client fires this when a refresh is refused: drop the in-memory user too.
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      queryClient.clear(); // nothing from the ended session may stay cached
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [queryClient]);

  const login = useCallback(async (payload: LoginPayload) => {
    const res = await authApi.login(payload); // throws on failure: no user is set
    queryClient.clear(); // never show a previous user's cached data
    setSessionError(null);
    setUser(res.user);
  }, [queryClient]);

  const register = useCallback(async (payload: RegisterPayload) => {
    const res = await authApi.register(payload);
    queryClient.clear();
    setSessionError(null);
    setUser(res.user);
  }, [queryClient]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      queryClient.clear();
    }
  }, [queryClient]);

  const refreshUser = useCallback(async () => {
    setUser(await authApi.me());
  }, []);

  const hasRole = (roles: UserRole[]): boolean => {
    if (!user) return false;
    if (user.role === UserRole.SUPER_ADMIN) return true;
    return roles.includes(user.role);
  };

  return (
    <AuthContext.Provider
      value={{ user, isLoading, isAuthenticated: !!user, sessionError, login, register, logout, refreshUser, hasRole }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
