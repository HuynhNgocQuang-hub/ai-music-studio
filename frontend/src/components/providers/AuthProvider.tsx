import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  ApiError,
  clearAuthToken,
  fetchAuthMe,
  getAuthToken,
  loginAccount,
  logoutAccount,
  oauthDevLogin,
  registerAccount,
  setAuthToken,
} from '@/lib/api/client';
import type { AuthQuota, AuthSessionResponse, AuthUser, CloudInfraStatus } from '@/types/project';

interface AuthContextValue {
  authenticated: boolean;
  user: AuthUser;
  quota: AuthQuota | null;
  cloud: CloudInfraStatus | null;
  loading: boolean;
  authModalOpen: boolean;
  setAuthModalOpen: (open: boolean) => void;
  login: (email: string, password: string) => Promise<AuthSessionResponse>;
  register: (email: string, password: string, displayName: string) => Promise<AuthSessionResponse>;
  oauthLogin: (provider: 'google' | 'github') => Promise<AuthSessionResponse>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const GUEST_USER: AuthUser = {
  user_id: 'guest',
  email: 'guest@local',
  display_name: 'Guest Producer',
  role: 'guest',
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<AuthUser>(GUEST_USER);
  const [quota, setQuota] = useState<AuthQuota | null>(null);
  const [cloud, setCloud] = useState<CloudInfraStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  const applySession = useCallback((res: AuthSessionResponse) => {
    setAuthenticated(Boolean(res.authenticated));
    setUser(res.user || GUEST_USER);
    setQuota(res.quota || null);
    setCloud(res.cloud || null);
    if (res.token) {
      setAuthToken(res.token);
    }
  }, []);

  const refreshAuth = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchAuthMe();
      if (!res.authenticated && getAuthToken()) {
        clearAuthToken();
      }
      applySession(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && getAuthToken()) {
        clearAuthToken();
        setAuthenticated(false);
        setUser(GUEST_USER);
        try {
          const guestRes = await fetchAuthMe();
          applySession(guestRes);
        } catch {
          // ignore if backend offline
        }
      }
    } finally {
      setLoading(false);
    }
  }, [applySession]);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await loginAccount({ email, password });
      applySession(res);
      return res;
    },
    [applySession]
  );

  const register = useCallback(
    async (email: string, password: string, displayName: string) => {
      const res = await registerAccount({ email, password, display_name: displayName });
      applySession(res);
      return res;
    },
    [applySession]
  );

  const oauthLogin = useCallback(
    async (provider: 'google' | 'github') => {
      const res = await oauthDevLogin(provider);
      applySession(res);
      return res;
    },
    [applySession]
  );

  const logout = useCallback(async () => {
    try {
      await logoutAccount();
    } catch {
      clearAuthToken();
    }
    setAuthenticated(false);
    setUser(GUEST_USER);
    await refreshAuth();
  }, [refreshAuth]);

  return (
    <AuthContext.Provider
      value={{
        authenticated,
        user,
        quota,
        cloud,
        loading,
        authModalOpen,
        setAuthModalOpen,
        login,
        register,
        oauthLogin,
        logout,
        refreshAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
