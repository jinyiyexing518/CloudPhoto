/**
 * Authentication API — login, register, profile, admin management.
 *
 * All HTTP calls use the shared `fetchWithTimeout` + `authHeaders` from http.ts
 * so token refresh and auto-logout are handled transparently.
 */

import { API_BASE } from "../utils/apiBase";
import { fetchWithTimeout, authHeaders, isRetryableGatewayStatus } from "./http";

// ── Domain types ──────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatar?: string;
  role: "admin" | "viewer";
}

export interface AuthResponse {
  token: string;
  refreshToken?: string;
  user: AuthUser;
}

// ── API calls ─────────────────────────────────────────────────────────────

export async function loginApi(
  username: string,
  password: string,
): Promise<AuthResponse> {
  const res = await fetchWithTimeout(
    `${API_BASE}/auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
    30_000,
  ).catch((e: unknown) => {
    throw new Error(
      e instanceof Error && e.name === "AbortError"
        ? "登录响应超时，服务器可能正在启动，请稍后重试"
        : "登录服务暂时不可用，请稍后重试",
    );
  });
  if (!res.ok) {
    if (isRetryableGatewayStatus(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error("登录服务暂时不可用，请稍后重试");
    }
    const err = await res.json().catch(() => ({ error: "Login failed" }));
    throw new Error((err as { error?: string }).error ?? "Login failed");
  }
  return res.json() as Promise<AuthResponse>;
}

export async function registerApi(data: {
  username: string;
  email: string;
  displayName: string;
  password: string;
}): Promise<AuthResponse> {
  const res = await fetchWithTimeout(
    `${API_BASE}/auth/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  ).catch((e: unknown) => {
    throw new Error(
      e instanceof Error && e.name === "AbortError" ? "注册超时，请稍后重试" : "网络错误",
    );
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Registration failed" }));
    throw new Error((err as { error?: string }).error ?? "Registration failed");
  }
  return res.json() as Promise<AuthResponse>;
}

export async function getMeApi(signal?: AbortSignal): Promise<AuthUser> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/me`, {
    headers: authHeaders(),
    signal,
  }).catch(() => { throw new Error("Unauthorized"); });
  if (!res.ok) throw new Error("Unauthorized");
  return res.json() as Promise<AuthUser>;
}

export async function addAdminApi(data: {
  email?: string;
  username?: string;
}): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/admins`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error((err as { error?: string }).error ?? "Failed to add admin");
  }
}

export async function updateProfileApi(data: {
  displayName: string;
}): Promise<AuthResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/me`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error((err as { error?: string }).error ?? "Failed to update profile");
  }
  return res.json() as Promise<AuthResponse>;
}

export async function changePasswordApi(data: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/change-password`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error((err as { error?: string }).error ?? "Failed to change password");
  }
}
