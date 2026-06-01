import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { AuthUser, AuthResponse, loginApi, registerApi, getMeApi, setUnauthorizedHandler, saveStoredAuth, clearStoredAuth } from "../services/photoApi";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: { username: string; email: string; displayName: string; password: string }) => Promise<void>;
  logout: () => void;
  updateUser: (u: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session on mount
  useEffect(() => {
    const token = localStorage.getItem("cloudphoto_token");
    if (!token) {
      setLoading(false);
      return;
    }
    getMeApi()
      .then(setUser)
      .catch(() => localStorage.removeItem("cloudphoto_token"))
      .finally(() => setLoading(false));
  }, []);

  const saveAuth = useCallback((resp: AuthResponse) => {
    saveStoredAuth(resp.token, resp.refreshToken);
    setUser(resp.user);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const resp = await loginApi(username, password);
    saveAuth(resp);
  }, [saveAuth]);

  const register = useCallback(async (data: { username: string; email: string; displayName: string; password: string }) => {
    const resp = await registerApi(data);
    saveAuth(resp);
  }, [saveAuth]);

  const logout = useCallback(() => {
    clearStoredAuth();
    setUser(null);
  }, []);

  const updateUser = useCallback((u: AuthUser) => {
    setUser(u);
  }, []);

  // Auto-logout when any API call receives 401 (token expired)
  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

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
