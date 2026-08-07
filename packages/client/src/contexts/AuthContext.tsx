import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { AuthUser, AuthResponse, loginApi, registerApi, getMeApi, setUnauthorizedHandler, saveStoredAuth, clearStoredAuth } from "../services/photoApi";
import {
  clearPrivatePhotoCaches,
  preparePrivatePhotoCachesForUser,
} from "../services/photoListCache";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: { username: string; email: string; displayName: string; password: string }) => Promise<void>;
  logout: () => void;
  updateUser: (u: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function tokenUserId(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const normalized = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(normalized)) as { userId?: unknown };
    return typeof decoded.userId === "string" ? decoded.userId : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const crossTabSyncGeneration = useRef(0);

  const logout = useCallback(() => {
    clearStoredAuth();
    void clearPrivatePhotoCaches();
    setUser(null);
  }, []);

  // Restore session on mount
  useEffect(() => {
    const token = localStorage.getItem("cloudphoto_token");
    if (!token) {
      setLoading(false);
      return;
    }
    getMeApi()
      .then(async (restoredUser) => {
        await preparePrivatePhotoCachesForUser(restoredUser.id);
        setUser(restoredUser);
      })
      .catch(logout)
      .finally(() => setLoading(false));
  }, [logout]);

  const saveAuth = useCallback(async (resp: AuthResponse) => {
    await preparePrivatePhotoCachesForUser(resp.user.id);
    saveStoredAuth(resp.token, resp.refreshToken);
    setUser(resp.user);
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
    setUnauthorizedHandler(logout);
  }, [logout]);

  // localStorage events notify other tabs. Clear their private data immediately
  // on logout or token replacement, then adopt the replacement account locally.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "cloudphoto_token") return;
      if (event.newValue && tokenUserId(event.newValue) === user?.id) return;
      const generation = ++crossTabSyncGeneration.current;
      setUser(null);
      void clearPrivatePhotoCaches();
      if (event.newValue === null) {
        setLoading(false);
        return;
      }
      setLoading(true);
      void getMeApi()
        .then(async (nextUser) => {
          await preparePrivatePhotoCachesForUser(nextUser.id);
          if (generation === crossTabSyncGeneration.current) setUser(nextUser);
        })
        .catch(() => {
          // Keep this tab signed out if the replacement token is invalid.
        })
        .finally(() => {
          if (generation === crossTabSyncGeneration.current) setLoading(false);
        });
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [user?.id]);

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
