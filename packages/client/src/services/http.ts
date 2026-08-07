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

import {
  API_BASE,
  DIRECT_API_BASE,
  PROXY_API_BASE,
  isProxySiteHost,
} from "../utils/apiBase";

type ApiRouteKind = "direct" | "proxy" | "same-origin";

interface ParsedApiRequest {
  kind: ApiRouteKind;
  suffix: string;
  search: string;
}

function isCloudPhotoHost(hostname: string): boolean {
  return hostname === "cloudphotos.top" || hostname.endsWith(".cloudphotos.top");
}

function requestUrl(input: RequestInfo): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return null;
}

function matchesApiBase(parsed: URL, base: URL): boolean {
  return (
    parsed.origin === base.origin &&
    (parsed.pathname === base.pathname || parsed.pathname.startsWith(`${base.pathname}/`))
  );
}

function parseApiRequest(input: RequestInfo): ParsedApiRequest | null {
  if (typeof window === "undefined") return null;
  const raw = requestUrl(input);
  if (!raw) return null;
  try {
    const parsed = new URL(raw, window.location.origin);
    const directBase = new URL(DIRECT_API_BASE);
    const proxyBase = new URL(PROXY_API_BASE);
    if (
      parsed.origin === window.location.origin &&
      isCloudPhotoHost(window.location.hostname) &&
      (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/"))
    ) {
      return {
        kind: "same-origin",
        suffix: parsed.pathname.slice("/api".length),
        search: parsed.search,
      };
    }
    if (matchesApiBase(parsed, directBase)) {
      return {
        kind: "direct",
        suffix: parsed.pathname.slice(directBase.pathname.length),
        search: parsed.search,
      };
    }
    if (matchesApiBase(parsed, proxyBase)) {
      return {
        kind: "proxy",
        suffix: parsed.pathname.slice(proxyBase.pathname.length),
        search: parsed.search,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function buildApiUrl(base: string, request: ParsedApiRequest): string {
  const target = new URL(base, typeof window === "undefined" ? undefined : window.location.origin);
  target.pathname = `${target.pathname.replace(/\/+$/, "")}${request.suffix}`;
  target.search = request.search;
  return target.toString();
}

function getFallbackApiUrl(input: RequestInfo): string | null {
  const request = parseApiRequest(input);
  if (!request) return null;
  return request.kind === "direct"
    ? buildApiUrl(PROXY_API_BASE, request)
    : buildApiUrl(DIRECT_API_BASE, request);
}

function canRetryOnAlternateRoute(input: RequestInfo, init?: RequestInit): boolean {
  const method = (
    init?.method ??
    (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const request = parseApiRequest(input);
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return request?.suffix.split("?")[0] !== "/photos/share";
  }
  if (method !== "POST") return false;
  return request?.suffix === "/auth/login" || request?.suffix === "/auth/refresh";
}

function keepCancellationUntilBodyCompletes(
  response: Response,
  cleanup: () => void,
): Response {
  if (!response.body) {
    cleanup();
    return response;
  }

  let cleaned = false;
  const finish = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return wrapped;
}

let sameOriginProxyProbe: Promise<boolean> | null = null;

function detectSameOriginProxy(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (isProxySiteHost(window.location.hostname)) return Promise.resolve(true);
  if (window.location.hostname !== "www.cloudphotos.top") return Promise.resolve(false);
  if (sameOriginProxyProbe) return sameOriginProxyProbe;

  sameOriginProxyProbe = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1_200);
    try {
      const response = await fetch(`${window.location.origin}/healthz`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        return false;
      }
      const body = await response.json() as { route?: string };
      return body.route === "cloudphoto-proxy";
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  })();
  return sameOriginProxyProbe;
}

async function resolvePrimaryApiInput(input: RequestInfo, init?: RequestInit): Promise<RequestInfo> {
  if (init?.signal?.aborted || !await detectSameOriginProxy()) return input;
  const request = parseApiRequest(input);
  if (!request || request.kind === "same-origin" || typeof window === "undefined") return input;
  // Service calls use string/URL inputs. Keep a Request object intact because
  // rebuilding it after its body was consumed is not safe.
  if (typeof Request !== "undefined" && input instanceof Request) return input;
  return buildApiUrl(`${window.location.origin}/api`, request);
}

/** Resolve the regional primary URL for transports such as XMLHttpRequest. */
export async function resolveApiUrl(url: string, signal?: AbortSignal): Promise<string> {
  const resolved = await resolvePrimaryApiInput(url, { signal });
  return requestUrl(resolved) ?? url;
}

async function fetchWithProxyFallback(
  input: RequestInfo,
  init?: RequestInit,
  routeTimeoutMs?: number,
): Promise<Response> {
  const primaryInput = await resolvePrimaryApiInput(input, init);
  const canFallback = canRetryOnAlternateRoute(primaryInput, init);
  const fallbackUrl = canFallback ? getFallbackApiUrl(primaryInput) : null;
  const routeController = fallbackUrl && routeTimeoutMs ? new AbortController() : null;
  const abortRoute = () => routeController?.abort(init?.signal?.reason);
  if (routeController) {
    if (init?.signal?.aborted) abortRoute();
    else init?.signal?.addEventListener("abort", abortRoute, { once: true });
  }
  const routeTimer = routeController
    ? setTimeout(
        () => routeController.abort(new DOMException("Route timed out", "TimeoutError")),
        routeTimeoutMs,
      )
    : null;
  const primaryInit = routeController ? { ...init, signal: routeController.signal } : init;
  const cleanupPrimary = () => {
    if (routeTimer) clearTimeout(routeTimer);
    init?.signal?.removeEventListener("abort", abortRoute);
  };

  let res: Response;
  try {
    res = await fetch(primaryInput, primaryInit);
  } catch (networkError) {
    cleanupPrimary();
    // A caller cancellation or timeout is intentional. Retrying the same
    // request against the fallback would keep expensive work alive after the
    // UI has moved on.
    if (init?.signal?.aborted) throw networkError;
    // Whichever route was primary failed at the network layer.
    if (!fallbackUrl) throw networkError;
    return fetch(fallbackUrl, init);
  }
  // Retry gateway/edge failures through the other route.
  if ([502, 503, 504, 521, 522, 523, 524].includes(res.status)) {
    if (fallbackUrl && !init?.signal?.aborted) {
      if (routeTimer) clearTimeout(routeTimer);
      try {
        const fallbackResponse = await fetch(fallbackUrl, init);
        cleanupPrimary();
        if (res.body) await res.body.cancel().catch(() => undefined);
        return fallbackResponse;
      } catch (error) {
        if (init?.signal?.aborted) {
          cleanupPrimary();
          throw error;
        }
        // Fallback also failed — return the original gateway response
        return keepCancellationUntilBodyCompletes(res, cleanupPrimary);
      }
    }
  }
  if (routeTimer) clearTimeout(routeTimer);
  return routeController
    ? keepCancellationUntilBodyCompletes(res, cleanupPrimary)
    : res;
}

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  const res = await fetchWithProxyFallback(`${API_BASE}/auth/refresh`, {
    signal: controller.signal,
    method: "POST",
    headers: { Authorization: `Bearer ${refreshToken}` },
  }, 5_000).catch(() => null);
  if (!res?.ok) {
    clearTimeout(timeoutId);
    return null;
  }
  const data = await res.json()
    .finally(() => clearTimeout(timeoutId)) as { token?: string; refreshToken?: string };
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
  const callerSignal = init?.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const id = setTimeout(() => controller.abort(), ms);
  const requestInit = { ...init, signal: controller.signal };
  const routeTimeoutMs = Math.min(5_000, Math.max(750, Math.floor(ms / 3)));
  const cleanup = () => {
    clearTimeout(id);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  };
  return fetchWithProxyFallback(input, requestInit, routeTimeoutMs)
    .then(async (res) => {
      if (res.status === 401) {
        const newToken = await getRefreshedToken();
        if (newToken) {
          if (res.body) await res.body.cancel().catch(() => undefined);
          const retryHeaders = {
            ...(init?.headers as Record<string, string> ?? {}),
            Authorization: `Bearer ${newToken}`,
          };
          return fetchWithProxyFallback(
            input,
            { ...requestInit, headers: retryHeaders },
            routeTimeoutMs,
          );
        }
        _onUnauthorized?.();
      }
      return res;
    })
    .then((res) => keepCancellationUntilBodyCompletes(res, cleanup))
    .catch((error) => {
      cleanup();
      throw error;
    });
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
