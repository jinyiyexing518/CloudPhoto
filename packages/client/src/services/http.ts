/**
 * Core HTTP utilities shared across all API service modules.
 *
 * Responsibilities:
 *  - JWT token storage (localStorage)
 *  - Automatic token refresh on 401 with request retry
 *  - fetchWithTimeout wrapper
 *  - Typed auth headers builder
 *  - Structured API error parser
 *
 * Nothing in this file is UI-aware — no imports from React or components.
 */

import { API_BASE } from "../utils/apiBase";

// ── Token storage keys ────────────────────────────────────────────────────
const TOKEN_KEY = "cloudphoto_token";
const REFRESH_TOKEN_KEY = "cloudphoto_refresh_token";

export function saveStoredAuth(token: string, refreshToken?: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearStoredAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

// ── 401 auto-logout callback ──────────────────────────────────────────────
let _onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  _onUnauthorized = fn;
}

// ── Token refresh (concurrency-safe mutex) ────────────────────────────────
let _refreshPromise: Promise<string | null> | null = null;

async function _doRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) return null;
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${refreshToken}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json() as { token?: string; refreshToken?: string };
  if (!data.token) return null;
  saveStoredAuth(data.token, data.refreshToken);
  return data.token;
}

/** Returns a single shared in-flight refresh promise to avoid duplicate requests. */
export function getRefreshedToken(): Promise<string | null> {
  if (!_refreshPromise) {
    _refreshPromise = _doRefresh().finally(() => { _refreshPromise = null; });
  }
  return _refreshPromise;
}

// ── Core fetch helpers ────────────────────────────────────────────────────

/**
 * Builds Authorization + optional extra headers from the stored JWT.
 * Returns an empty object when the user is not logged in.
 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

/**
 * fetch() with:
 *  - Hard timeout (default 15 s) via AbortController
 *  - Automatic token-refresh + single retry on 401
 *  - Auto-logout trigger when refresh also fails
 */
export function fetchWithTimeout(
  input: RequestInfo,
  init?: RequestInit,
  ms = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(input, { ...init, signal: controller.signal })
    .then(async (res) => {
      if (res.status === 401) {
        const newToken = await getRefreshedToken();
        if (newToken) {
          const retryHeaders = {
            ...(init?.headers as Record<string, string> ?? {}),
            Authorization: `Bearer ${newToken}`,
          };
          return fetch(input, { ...init, headers: retryHeaders });
        }
        _onUnauthorized?.();
      }
      return res;
    })
    .finally(() => clearTimeout(id));
}

// ── Structured API error parser ───────────────────────────────────────────
const DEFAULT_CONFLICT_MESSAGE = "资源已被他人修改，请刷新后重试";

export async function parseApiError(
  response: Response,
  fallback: string,
  options?: { conflictMessage?: string },
): Promise<string> {
  if (response.status === 409) {
    return options?.conflictMessage ?? DEFAULT_CONFLICT_MESSAGE;
  }
  const err = await response.json().catch(() => ({})) as { error?: string };
  return err.error ?? fallback;
}
