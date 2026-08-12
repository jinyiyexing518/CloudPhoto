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
import { authCacheOwner } from "../services/authScope";

const PRIVATE_CACHE_FAILURE = { code: "PRIVATE_CACHE_FAILED" } as const;
const logPrivateCacheFailure = () => console.error(PRIVATE_CACHE_FAILURE);

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: { username: string; email: string; displayName: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (displayName: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

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

  const logout = useCallback(async () => {
    cancelAuthSync();
    clearStoredAuth();
    const cleanup = clearPrivatePhotoCaches();
    currentUserRef.current = null;
    setUser(null);
    setLoading(false);
    await cleanup;
  }, [cancelAuthSync]);

  const restoreCurrentUser = useCallback(async (
    controller: AbortController,
    generation: number,
  ) => {
    const nextUser = await getMeApi(controller.signal);
    if (controller.signal.aborted || generation !== authSyncGeneration.current) return;
    const nextScope = authCacheOwner(nextUser.id, nextUser.role);
    if (getTokenAuthScope() !== nextScope) {
      await logout();
      return;
    }
    if (await preparePrivatePhotoCachesForScope(nextScope) === false) return;
    if (!controller.signal.aborted && generation === authSyncGeneration.current) {
      currentUserRef.current = nextUser;
      setUser(nextUser);
    }
  }, [logout]);

  useEffect(() => () => cancelAuthSync(), [cancelAuthSync]);

  // Restore session on mount
  useEffect(() => {
    const generation = authSyncGeneration.current;
    const controller = new AbortController();
    authSyncController.current = controller;
    void (async () => {
      try {
        if (!getToken()) {
          await clearPrivatePhotoCaches();
          return;
        }
        await restoreCurrentUser(controller, generation);
      } catch {
        if (!controller.signal.aborted && generation === authSyncGeneration.current) {
          await logout().catch(logPrivateCacheFailure);
        }
      } finally {
        if (authSyncController.current === controller) authSyncController.current = null;
        if (!controller.signal.aborted && generation === authSyncGeneration.current) {
          setLoading(false);
        }
      }
    })();
    return () => {
      if (authSyncController.current === controller) authSyncController.current = null;
      controller.abort();
    };
  }, [logout, restoreCurrentUser]);

  const saveAuth = useCallback(async (resp: AuthResponse): Promise<boolean> => {
    const previousUser = currentUserRef.current;
    const nextScope = authCacheOwner(resp.user.id, resp.user.role);
    if (getTokenAuthScope(resp.token) !== nextScope) {
      await logout();
      return false;
    }
    if (previousUser && authCacheOwner(previousUser.id, previousUser.role) !== nextScope) {
      currentUserRef.current = null;
      setUser(null);
    }
    cancelAuthSync();
    saveStoredAuth(resp.token, resp.refreshToken);
    const generation = authSyncGeneration.current;
    if (
      await preparePrivatePhotoCachesForScope(nextScope) !== false
      && generation === authSyncGeneration.current
      && getToken() === resp.token
    ) {
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
      await logout();
      throw new Error("登录状态已变更，个人资料未应用");
    }
    if (!await saveAuth(resp)) throw new Error("登录状态已变更，个人资料未应用");
  }, [logout, saveAuth]);

  // Auto-logout when any API call receives 401 (token expired)
  useEffect(() => {
    setUnauthorizedHandler(async (failedToken) => {
      if (!failedToken || getToken() === failedToken) await logout();
    });
  }, [logout]);

  // localStorage events notify other tabs. Clear their private data immediately
  // on logout or token replacement, then adopt the replacement account locally.
  useEffect(() => {
    const handleStorage = async (event: StorageEvent) => {
      if (event.key !== "cloudphoto_token") return;
      const currentScope = user ? authCacheOwner(user.id, user.role) : null;
      const replacementScope = event.newValue ? getTokenAuthScope(event.newValue) : null;
      if (replacementScope && replacementScope === currentScope) return;
      invalidateAuthRefresh();
      cancelAuthSync();
      const generation = authSyncGeneration.current;
      const cleanup = clearPrivatePhotoCaches();
      currentUserRef.current = null;
      setUser(null);
      try {
        await cleanup;
      } catch {
        setLoading(false);
        logPrivateCacheFailure();
        return;
      }
      if (!getToken()) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const controller = new AbortController();
      authSyncController.current = controller;
      try {
        await restoreCurrentUser(controller, generation);
      } catch {
        // Keep this tab signed out if the replacement token is invalid.
      } finally {
        if (authSyncController.current === controller) authSyncController.current = null;
        if (!controller.signal.aborted && generation === authSyncGeneration.current) {
          setLoading(false);
        }
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [cancelAuthSync, restoreCurrentUser, user?.id, user?.role]);

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
