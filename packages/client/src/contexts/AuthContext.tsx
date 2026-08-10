import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import type { AuthResponse, AuthUser } from "../services/authApi";
import {
  loginApi,
  registerApi,
  getMeApi,
  updateProfileApi,
} from "../services/authApi";
import {
  setUnauthorizedHandler,
  saveStoredAuth,
  clearStoredAuth,
  getAuthGeneration,
  getToken,
  getTokenAuthScope,
  invalidateAuthRefresh,
} from "../services/http";
import {
  clearPrivatePhotoCaches,
  preparePrivatePhotoCachesForScope,
} from "../services/privatePhotoCacheLifecycle";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: { username: string; email: string; displayName: string; password: string }) => Promise<void>;
  logout: () => void;
  updateProfile: (displayName: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function authCacheScope(user: AuthUser): string {
  return `${user.id}:${user.role}`;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const authSyncGeneration = useRef(0);
  const authSyncController = useRef<AbortController | null>(null);
  const currentUserRef = useRef<AuthUser | null>(user);
  currentUserRef.current = user;

  const cancelAuthSync = useCallback(() => {
    authSyncGeneration.current += 1;
    authSyncController.current?.abort();
    authSyncController.current = null;
  }, []);

  const logout = useCallback(() => {
    cancelAuthSync();
    clearStoredAuth();
    void clearPrivatePhotoCaches();
    setUser(null);
    setLoading(false);
  }, [cancelAuthSync]);

  useEffect(() => () => cancelAuthSync(), [cancelAuthSync]);

  // Restore session on mount
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    const generation = authSyncGeneration.current;
    const controller = new AbortController();
    authSyncController.current = controller;
    getMeApi(controller.signal)
      .then(async (restoredUser) => {
        if (controller.signal.aborted || generation !== authSyncGeneration.current) return;
        const restoredScope = authCacheScope(restoredUser);
        if (getTokenAuthScope() !== restoredScope) {
          logout();
          return;
        }
        await preparePrivatePhotoCachesForScope(restoredScope);
        if (!controller.signal.aborted && generation === authSyncGeneration.current) {
          setUser(restoredUser);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && generation === authSyncGeneration.current) logout();
      })
      .finally(() => {
        if (authSyncController.current === controller) authSyncController.current = null;
        if (!controller.signal.aborted && generation === authSyncGeneration.current) {
          setLoading(false);
        }
      });
    return () => {
      if (authSyncController.current === controller) authSyncController.current = null;
      controller.abort();
    };
  }, [logout]);

  const saveAuth = useCallback(async (resp: AuthResponse): Promise<boolean> => {
    const previousUser = currentUserRef.current;
    const nextScope = authCacheScope(resp.user);
    if (getTokenAuthScope(resp.token) !== nextScope) {
      logout();
      return false;
    }
    if (previousUser && authCacheScope(previousUser) !== nextScope) {
      currentUserRef.current = null;
      setUser(null);
    }
    cancelAuthSync();
    saveStoredAuth(resp.token, resp.refreshToken);
    const generation = authSyncGeneration.current;
    await preparePrivatePhotoCachesForScope(nextScope);
    if (generation === authSyncGeneration.current && getToken() === resp.token) {
      currentUserRef.current = resp.user;
      setUser(resp.user);
      return true;
    }
    return false;
  }, [cancelAuthSync, logout]);

  const login = useCallback(async (username: string, password: string) => {
    const resp = await loginApi(username, password);
    if (!await saveAuth(resp)) throw new Error("登录状态已变更，请重试");
  }, [saveAuth]);

  const register = useCallback(async (data: { username: string; email: string; displayName: string; password: string }) => {
    const resp = await registerApi(data);
    if (!await saveAuth(resp)) throw new Error("登录状态已变更，请重试");
  }, [saveAuth]);

  const updateProfile = useCallback(async (displayName: string) => {
    const expectedUser = currentUserRef.current;
    if (!expectedUser) throw new Error("登录状态已失效");
    const syncGeneration = authSyncGeneration.current;
    const authGeneration = getAuthGeneration();
    const resp = await updateProfileApi({ displayName });
    if (
      syncGeneration !== authSyncGeneration.current
      || authGeneration !== getAuthGeneration()
      || currentUserRef.current?.id !== expectedUser.id
    ) {
      throw new Error("登录状态已变更，个人资料未应用");
    }
    if (resp.user.id !== expectedUser.id) {
      logout();
      throw new Error("登录状态已变更，个人资料未应用");
    }
    if (!await saveAuth(resp)) throw new Error("登录状态已变更，个人资料未应用");
  }, [logout, saveAuth]);

  // Auto-logout when any API call receives 401 (token expired)
  useEffect(() => {
    setUnauthorizedHandler((failedToken) => {
      if (!failedToken || getToken() === failedToken) logout();
    });
  }, [logout]);

  // localStorage events notify other tabs. Clear their private data immediately
  // on logout or token replacement, then adopt the replacement account locally.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "cloudphoto_token") return;
      const currentScope = user ? authCacheScope(user) : null;
      const replacementScope = event.newValue ? getTokenAuthScope(event.newValue) : null;
      if (replacementScope && replacementScope === currentScope) return;
      invalidateAuthRefresh();
      cancelAuthSync();
      const generation = authSyncGeneration.current;
      setUser(null);
      void clearPrivatePhotoCaches();
      if (event.newValue === null) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const controller = new AbortController();
      authSyncController.current = controller;
      void getMeApi(controller.signal)
        .then(async (nextUser) => {
          const nextScope = authCacheScope(nextUser);
          if (getTokenAuthScope() !== nextScope) {
            logout();
            return;
          }
          await preparePrivatePhotoCachesForScope(nextScope);
          if (!controller.signal.aborted && generation === authSyncGeneration.current) {
            setUser(nextUser);
          }
        })
        .catch(() => {
          // Keep this tab signed out if the replacement token is invalid.
        })
        .finally(() => {
          if (authSyncController.current === controller) authSyncController.current = null;
          if (!controller.signal.aborted && generation === authSyncGeneration.current) {
            setLoading(false);
          }
        });
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [cancelAuthSync, logout, user?.id, user?.role]);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
