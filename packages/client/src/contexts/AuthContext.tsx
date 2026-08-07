import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import {
  AuthUser,
  AuthResponse,
  getMeApi,
  loginApi,
  registerApi,
} from "../services/authApi";
import {
  clearStoredAuth,
  getToken,
  saveStoredAuth,
  setUnauthorizedHandler,
  subscribeAuthIdentityChanges,
} from "../services/http";
import {
  clearPrivatePhotoCaches,
  preparePrivatePhotoCachesForOwner,
} from "../services/photoListCache";
import {
  authCacheOwner,
  decodeAuthorizationSnapshot,
} from "../services/photoLoadingPolicy";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: { username: string; email: string; displayName: string; password: string }) => Promise<void>;
  logout: () => void;
  updateUser: (u: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function userCacheOwner(user: AuthUser): string {
 return authCacheOwner(user.id, user.role);
}

function responseMatchesAuthorization(user: AuthUser, token: string | null): boolean {
 return decodeAuthorizationSnapshot(token)?.cacheOwner === userCacheOwner(user);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const crossTabSyncGeneration = useRef(0);
  const userRef = useRef<AuthUser | null>(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const logout = useCallback(() => {
    crossTabSyncGeneration.current += 1;
    clearStoredAuth();
    void clearPrivatePhotoCaches();
    setUser(null);
    setLoading(false);
  }, []);

  // Restore session on mount
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    getMeApi()
      .then(async (restoredUser) => {
        const currentToken = getToken();
        if (!responseMatchesAuthorization(restoredUser, currentToken)) {
          throw new Error("Authorization identity drift");
        }
        await preparePrivatePhotoCachesForOwner(userCacheOwner(restoredUser));
        setUser(restoredUser);
      })
      .catch(logout)
      .finally(() => setLoading(false));
  }, [logout]);

  const saveAuth = useCallback(async (resp: AuthResponse) => {
    if (!responseMatchesAuthorization(resp.user, resp.token)) {
      throw new Error("Authentication response identity mismatch");
    }
    crossTabSyncGeneration.current += 1;
    await preparePrivatePhotoCachesForOwner(userCacheOwner(resp.user));
    saveStoredAuth(resp.token, resp.refreshToken);
    setUser(resp.user);
    setLoading(false);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const resp = await loginApi(username, password);
    await saveAuth(resp);
  }, [saveAuth]);

  const register = useCallback(async (data: { username: string; email: string; displayName: string; password: string }) => {
    const resp = await registerApi(data);
    await saveAuth(resp);
  }, [saveAuth]);

  const updateUser = useCallback((u: AuthUser) => {
    setUser(u);
  }, []);

  // Auto-logout when any API call receives 401 (token expired)
  useEffect(() => {
    setUnauthorizedHandler((failedToken) => {
      if (!failedToken || getToken() === failedToken) logout();
    });
  }, [logout]);

  const synchronizeReplacementToken = useCallback((replacementToken: string | null) => {
    const generation = ++crossTabSyncGeneration.current;
    setUser(null);
    void clearPrivatePhotoCaches();
    if (!replacementToken) {
      setLoading(false);
      return;
    }
    const expectedIdentity = decodeAuthorizationSnapshot(replacementToken);
    if (!expectedIdentity) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void getMeApi()
      .then(async (nextUser) => {
        const currentIdentity = decodeAuthorizationSnapshot(getToken());
        if (
          generation !== crossTabSyncGeneration.current
          || currentIdentity?.cacheOwner !== expectedIdentity.cacheOwner
          || !responseMatchesAuthorization(nextUser, getToken())
        ) {
          return;
        }
        await preparePrivatePhotoCachesForOwner(currentIdentity.cacheOwner);
        if (generation === crossTabSyncGeneration.current) setUser(nextUser);
      })
      .catch(() => {
        // Never clear replacement credentials: they may belong to a newer tab.
      })
      .finally(() => {
        if (generation === crossTabSyncGeneration.current) setLoading(false);
      });
  }, []);

  // localStorage events notify other tabs; refresh notifications cover same-tab
  // role changes because storage events do not fire in their source document.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "cloudphoto_token") return;
      const currentUser = userRef.current;
      const replacementIdentity = decodeAuthorizationSnapshot(event.newValue);
      if (
        currentUser
        && replacementIdentity?.cacheOwner === userCacheOwner(currentUser)
      ) {
        return;
      }
      synchronizeReplacementToken(event.newValue);
    };
    window.addEventListener("storage", handleStorage);
    const unsubscribe = subscribeAuthIdentityChanges(synchronizeReplacementToken);
    return () => {
      window.removeEventListener("storage", handleStorage);
      unsubscribe();
    };
  }, [synchronizeReplacementToken]);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
