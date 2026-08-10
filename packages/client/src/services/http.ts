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
import {
  AuthorizationSnapshot,
  ProxyProbeResult,
  classifyProxyProbe,
  decodeAuthorizationSnapshot,
  isSafeReplayMethod,
  proxyProbeTtlMs,
  raceHedgedAttempts,
} from "./photoLoadingPolicy";

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

function requestMethod(input: RequestInfo, init?: RequestInit): string {
  return (
    init?.method ??
    (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")
  ).toUpperCase();
}

function canHedgeOnAlternateRoute(input: RequestInfo, init?: RequestInit): boolean {
  const method = requestMethod(input, init);
  const request = parseApiRequest(input);
  if (isSafeReplayMethod(method)) {
    return request?.suffix.split("?")[0] !== "/photos/share";
  }
  return false;
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

interface ProxyProbeCache {
  result: ProxyProbeResult;
  expiresAt: number;
}

let sameOriginProxyProbe: Promise<ProxyProbeResult> | null = null;
let sameOriginProxyProbeCache: ProxyProbeCache | null = null;

export function invalidateApiProxyProbe(): void {
  sameOriginProxyProbe = null;
  sameOriginProxyProbeCache = null;
}

export function toDirectApiUrl(input: string): string {
  const request = parseApiRequest(input);
  return request ? buildApiUrl(DIRECT_API_BASE, request) : input;
}

function waitForResult<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function getSameOriginProxyProbe(): Promise<ProxyProbeResult> {
  if (sameOriginProxyProbe) return sameOriginProxyProbe;
  const probe = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1_200);
    try {
      const response = await fetch(`${window.location.origin}/healthz`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      let route: string | undefined;
      if (response.ok && contentType.includes("application/json")) {
        route = (await response.json() as { route?: string }).route;
      }
      return classifyProxyProbe({
        ok: response.ok,
        status: response.status,
        contentType,
        route,
      });
    } catch {
      return "transient";
    } finally {
      clearTimeout(timeoutId);
    }
  })().then((result) => {
    sameOriginProxyProbeCache = {
      result,
      expiresAt: Date.now() + proxyProbeTtlMs(result),
    };
    return result;
  }).finally(() => {
    if (sameOriginProxyProbe === probe) sameOriginProxyProbe = null;
  });
  sameOriginProxyProbe = probe;
  return probe;
}

async function detectSameOriginProxy(signal?: AbortSignal): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (isProxySiteHost(window.location.hostname)) return true;
  if (window.location.hostname !== "www.cloudphotos.top") return false;
  if (sameOriginProxyProbeCache && sameOriginProxyProbeCache.expiresAt > Date.now()) {
    return sameOriginProxyProbeCache.result === "proxy";
  }
  return (await waitForResult(getSameOriginProxyProbe(), signal)) === "proxy";
}

async function resolvePrimaryApiInput(input: RequestInfo, init?: RequestInit): Promise<RequestInfo> {
  if (init?.signal?.aborted) throw init.signal.reason;
  if (!await detectSameOriginProxy(init?.signal ?? undefined)) return input;
  if (init?.signal?.aborted) throw init.signal.reason;
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
  hedgeDelayMs?: number,
): Promise<Response> {
  const primaryInput = await resolvePrimaryApiInput(input, init);
  const fallbackUrl = canHedgeOnAlternateRoute(primaryInput, init)
    ? getFallbackApiUrl(primaryInput)
    : null;

  const handleMissingSameOriginRoute = async (response: Response): Promise<Response> => {
    const primaryRequest = parseApiRequest(primaryInput);
    const contentType = response.headers.get("content-type") ?? "";
    const routeMissing = (
      primaryRequest?.kind === "same-origin"
      && (
        response.status === 404
        || response.status === 405
        || (response.ok && contentType.includes("text/html"))
      )
    );
    if (!routeMissing || !primaryRequest || init?.signal?.aborted) return response;
    invalidateApiProxyProbe();
    if (response.body) await response.body.cancel().catch(() => undefined);
    return fetch(buildApiUrl(DIRECT_API_BASE, primaryRequest), init);
  };

  if (!fallbackUrl || !hedgeDelayMs) {
    return handleMissingSameOriginRoute(await fetch(primaryInput, init));
  }

  const startAttempt = (attemptInput: RequestInfo) => {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(init?.signal?.reason);
    if (init?.signal?.aborted) abortFromCaller();
    else init?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    return {
      promise: fetch(attemptInput, { ...init, signal: controller.signal }),
      cancel: (reason?: unknown) => controller.abort(reason),
      release: () => init?.signal?.removeEventListener("abort", abortFromCaller),
    };
  };
  const retryableStatuses = new Set([502, 503, 504, 521, 522, 523, 524]);
  const outcome = await raceHedgedAttempts({
    startPrimary: () => startAttempt(primaryInput),
    startFallback: () => startAttempt(fallbackUrl),
    hedgeDelayMs,
    isUsable: (response) => !retryableStatuses.has(response.status),
    signal: init?.signal ?? undefined,
  });
  const response = keepCancellationUntilBodyCompletes(outcome.value, outcome.release);
  return outcome.source === "primary"
    ? handleMissingSameOriginRoute(response)
    : response;
}

// ── Token storage keys ────────────────────────────────────────────────────
const TOKEN_KEY = "cloudphoto_token";
const REFRESH_TOKEN_KEY = "cloudphoto_refresh_token";

function storeAuth(token: string, refreshToken?: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function saveStoredAuth(token: string, refreshToken?: string): void {
  const previousScope = getTokenAuthScope();
  const nextScope = getTokenAuthScope(token);
  if (!previousScope || !nextScope || previousScope !== nextScope) {
    invalidateAuthRefresh();
  } else {
    cancelTokenRefresh();
  }
  storeAuth(token, refreshToken);
}

export function clearStoredAuth(): void {
  invalidateAuthRefresh();
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getAuthorizationSnapshot(): AuthorizationSnapshot | null {
  return decodeAuthorizationSnapshot(getToken());
}

export function authHeadersForSnapshot(
  snapshot: AuthorizationSnapshot,
  extra?: Record<string, string>,
): Record<string, string> {
  return { Authorization: "Bearer " + snapshot.token, ...extra };
}

export function signalAuthIdentityChange(): void {
  invalidateAuthRefresh();
}

export function getTokenAuthScope(token = getToken()): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const normalized = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(normalized)) as { userId?: unknown; role?: unknown };
    return typeof decoded.userId === "string" && typeof decoded.role === "string"
      ? `${decoded.userId}:${decoded.role}`
      : null;
  } catch {
    return null;
  }
}

export function getAuthGeneration(): number {
  return _authGeneration;
}

// ── 401 auto-logout callback ──────────────────────────────────────────────
let _onUnauthorized: ((failedToken: string | null) => void) | null = null;
export function setUnauthorizedHandler(fn: (failedToken: string | null) => void): void {
  _onUnauthorized = fn;
}

// ── Token refresh (concurrency-safe mutex) ────────────────────────────────
interface RefreshState {
  controller: AbortController;
  promise: Promise<string | null>;
}

let _authGeneration = 0;
let _refreshState: RefreshState | null = null;
const _authChangeListeners = new Set<() => void>();

export function subscribeToAuthChanges(listener: () => void): () => void {
  _authChangeListeners.add(listener);
  return () => _authChangeListeners.delete(listener);
}

function cancelTokenRefresh(): void {
  const state = _refreshState;
  _refreshState = null;
  state?.controller.abort(new DOMException("Authentication token rotated", "AbortError"));
}

/** Invalidates an older session without changing the currently stored tokens. */
export function invalidateAuthRefresh(): void {
  _authGeneration += 1;
  cancelTokenRefresh();
  for (const listener of _authChangeListeners) listener();
}

async function _doRefresh(
  refreshToken: string,
  generation: number,
  controller: AbortController,
): Promise<string | null> {
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  const res = await fetchWithProxyFallback(`${API_BASE}/auth/refresh`, {
    signal: controller.signal,
    method: "POST",
    headers: { Authorization: `Bearer ${refreshToken}` },
  }, 5_000).catch(() => null);
  if (!res?.ok) {
    clearTimeout(timeoutId);
    await res?.body?.cancel().catch(() => undefined);
    return null;
  }
  const data = await res.json()
    .catch(() => null)
    .finally(() => clearTimeout(timeoutId)) as { token?: string; refreshToken?: string } | null;
  if (!data?.token) return null;
  if (
    controller.signal.aborted
    || generation !== _authGeneration
    || localStorage.getItem(REFRESH_TOKEN_KEY) !== refreshToken
  ) {
    return null;
  }
  const previousScope = getTokenAuthScope();
  const nextScope = getTokenAuthScope(data.token);
  if (previousScope && nextScope && previousScope !== nextScope) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    invalidateAuthRefresh();
    _onUnauthorized?.(null);
    return null;
  }
  // This is the same authenticated session, so keep the shared refresh state
  // alive until all current callers receive the rotated token.
  storeAuth(data.token, data.refreshToken);
  return data.token;
}

/** Returns a single shared in-flight refresh promise to avoid duplicate requests. */
export function getRefreshedToken(expectedToken = getToken()): Promise<string | null> {
  if (!expectedToken || getToken() !== expectedToken) return Promise.resolve(null);
  if (_refreshState) return _refreshState.promise;
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) return Promise.resolve(null);

  const state: RefreshState = {
    controller: new AbortController(),
    promise: Promise.resolve(null),
  };
  const generation = _authGeneration;
  state.promise = _doRefresh(refreshToken, generation, state.controller)
    .finally(() => {
      if (_refreshState === state) _refreshState = null;
    });
  _refreshState = state;
  return state.promise;
}

// ── Core fetch helpers ────────────────────────────────────────────────────

/**
 * Builds Authorization + optional extra headers from the stored JWT.
 * Returns an empty object when the user is not logged in.
 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const snapshot = getAuthorizationSnapshot();
  return snapshot ? authHeadersForSnapshot(snapshot, extra) : { ...extra };
}

export async function recoverFromUnauthorized(
  requestToken: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  // A stale request must not refresh or clear credentials installed by a
  // newer login in this or another tab.
  if (!requestToken || getToken() !== requestToken) return null;
  const newToken = await waitForResult(
    getRefreshedToken(requestToken),
    signal,
  );
  return newToken;
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
  const requestAuthGeneration = _authGeneration;
  const requestToken = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer\s+/i, "")
    ?? getToken();
  const requestRefreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
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
  const hedgeDelayMs = Math.min(5_000, Math.max(750, Math.floor(ms / 3)));
  const cleanup = () => {
    clearTimeout(id);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  };
  return fetchWithProxyFallback(input, requestInit, hedgeDelayMs)
    .then(async (res) => {
      if (res.status === 401) {
        // Never refresh or replay a request that belongs to a replaced account.
        if (requestAuthGeneration !== _authGeneration) return res;
        const newToken = await recoverFromUnauthorized(requestToken, controller.signal);
        if (newToken && requestAuthGeneration === _authGeneration) {
          if (!isSafeReplayMethod(requestMethod(input, init))) return res;
          if (res.body) void res.body.cancel().catch(() => undefined);
          const retryHeaders = {
            ...(init?.headers as Record<string, string> ?? {}),
            Authorization: `Bearer ${newToken}`,
          };
          return fetchWithProxyFallback(
            input,
            { ...requestInit, headers: retryHeaders },
            hedgeDelayMs,
          );
        }
        const replacementToken = getToken();
        const credentialsChanged = (
          replacementToken !== requestToken
          || localStorage.getItem(REFRESH_TOKEN_KEY) !== requestRefreshToken
        );
        const sameScopeReplacement = (
          credentialsChanged
          && replacementToken
          && getTokenAuthScope(replacementToken) === getTokenAuthScope(requestToken)
        );
        if (sameScopeReplacement && requestAuthGeneration === _authGeneration) {
          if (replacementToken !== requestToken) {
            if (!isSafeReplayMethod(requestMethod(input, init))) return res;
            if (res.body) void res.body.cancel().catch(() => undefined);
            const retryHeaders = new Headers(init?.headers);
            retryHeaders.set("Authorization", `Bearer ${replacementToken}`);
            return fetchWithProxyFallback(
              input,
              { ...requestInit, headers: retryHeaders },
              hedgeDelayMs,
            );
          }
          // A replacement refresh token can recover the next request. Do not let
          // this superseded refresh sign out an otherwise valid same-scope session.
          return res;
        }
        // A 401 from an older request must not sign out a newer login.
        if (requestAuthGeneration === _authGeneration && getToken() === requestToken) {
          _onUnauthorized?.(requestToken);
        }
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
