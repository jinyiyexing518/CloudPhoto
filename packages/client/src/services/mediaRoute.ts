export type MediaRoute = "direct" | "proxy";

export interface MediaUrlFields {
  url: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  voiceMemoUrl?: string;
}

const DEFAULT_BLOB_MEDIA_BASE = "https://photostorage.blob.core.windows.net/photos";
const DEFAULT_PROXY_MEDIA_BASE = "https://cloudphotos.top/media";
const ROUTE_CACHE_KEY = "cloudphoto_media_route_v1";
const ROUTE_CACHE_MS = 30 * 60 * 1000;
const ROUTE_PROBE_TIMEOUT_MS = 1_500;
const MEDIA_ATTEMPT_TIMEOUT_MS = 10_000;

const blobMediaBase = (
  (import.meta.env.VITE_BLOB_MEDIA_BASE as string | undefined) ??
  DEFAULT_BLOB_MEDIA_BASE
).replace(/\/+$/, "");
const proxyMediaBase = (
  (import.meta.env.VITE_MEDIA_PROXY_BASE as string | undefined) ??
  DEFAULT_PROXY_MEDIA_BASE
).replace(/\/+$/, "");

function isCloudPhotoHost(hostname: string): boolean {
  return hostname === "cloudphotos.top" || hostname.endsWith(".cloudphotos.top");
}

function isProxySiteHost(hostname: string): boolean {
  return hostname === "cloudphotos.top" || hostname === "cn.cloudphotos.top";
}

function runtimeBaseUrl(): string {
  return typeof window === "undefined" ? "https://cloudphotos.top" : window.location.origin;
}

function proxyBaseForRuntime(): string {
  if (typeof window !== "undefined" && isProxySiteHost(window.location.hostname)) {
    return "/media";
  }
  return proxyMediaBase;
}

function absoluteUrl(url: string): string {
  try {
    return new URL(url, runtimeBaseUrl()).toString();
  } catch {
    return url;
  }
}

function parsedBase(base: string): URL | null {
  try {
    return new URL(base, runtimeBaseUrl());
  } catch {
    return null;
  }
}

function relativePathForBase(url: URL, base: URL | null): string | null {
  if (!base || url.origin !== base.origin) return null;
  const basePath = base.pathname.replace(/\/+$/, "");
  if (!url.pathname.startsWith(`${basePath}/`)) return null;
  return url.pathname.slice(basePath.length + 1);
}

function appendToBase(base: string, relativePath: string, search: string): string {
  return `${base.replace(/\/+$/, "")}/${relativePath}${search}`;
}

function directMediaPath(url: URL): string | null {
  return relativePathForBase(url, parsedBase(blobMediaBase));
}

function proxyMediaPath(raw: string, url: URL): string | null {
  if (raw.startsWith("/media/")) return url.pathname.slice("/media/".length);
  const configuredPath = relativePathForBase(url, parsedBase(proxyMediaBase));
  if (configuredPath !== null) return configuredPath;
  if (isCloudPhotoHost(url.hostname) && url.pathname.startsWith("/media/")) {
    return url.pathname.slice("/media/".length);
  }
  return null;
}

function readCachedRoute(): MediaRoute | null {
  if (typeof window === "undefined") return null;
  try {
    const cached = JSON.parse(localStorage.getItem(ROUTE_CACHE_KEY) ?? "null") as {
      route?: MediaRoute;
      expiresAt?: number;
    } | null;
    if (
      (cached?.route === "direct" || cached?.route === "proxy") &&
      typeof cached.expiresAt === "number" &&
      cached.expiresAt > Date.now()
    ) {
      return cached.route;
    }
    localStorage.removeItem(ROUTE_CACHE_KEY);
  } catch {
    // A malformed or unavailable localStorage entry only costs one fresh probe.
  }
  return null;
}

function defaultRoute(): MediaRoute {
  return typeof window !== "undefined" && isProxySiteHost(window.location.hostname)
    ? "proxy"
    : "direct";
}

let preferredRoute: MediaRoute = readCachedRoute() ?? defaultRoute();
let routeProbe: Promise<MediaRoute> | null = null;
const preferredRouteListeners = new Set<() => void>();

export function subscribeToPreferredMediaRoute(listener: () => void): () => void {
  preferredRouteListeners.add(listener);
  return () => preferredRouteListeners.delete(listener);
}

function rememberRoute(route: MediaRoute): void {
  const changed = route !== preferredRoute;
  preferredRoute = route;
  if (changed) {
    for (const listener of preferredRouteListeners) listener();
  }
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      ROUTE_CACHE_KEY,
      JSON.stringify({ route, expiresAt: Date.now() + ROUTE_CACHE_MS }),
    );
  } catch {
    // Routing still works for this page even when storage is unavailable.
  }
}

export function toDirectMediaUrl(url: string): string {
  try {
    const parsed = new URL(url, runtimeBaseUrl());
    if (directMediaPath(parsed) !== null) return parsed.toString();
    const blobPath = proxyMediaPath(url, parsed);
    return blobPath === null
      ? url
      : appendToBase(blobMediaBase, blobPath, parsed.search);
  } catch {
    return url;
  }
}

export function toProxyMediaUrl(url: string): string {
  const directUrl = toDirectMediaUrl(url);
  try {
    const parsed = new URL(directUrl, runtimeBaseUrl());
    const blobPath = directMediaPath(parsed);
    return blobPath === null
      ? url
      : appendToBase(proxyBaseForRuntime(), blobPath, parsed.search);
  } catch {
    return url;
  }
}

function mediaRouteForUrl(url: string): MediaRoute | null {
  try {
    const parsed = new URL(url, runtimeBaseUrl());
    if (directMediaPath(parsed) !== null) return "direct";
    if (proxyMediaPath(url, parsed) !== null) return "proxy";
  } catch {
    // Non-HTTP URLs such as blob: are not routed.
  }
  return null;
}

export function promoteSuccessfulMediaUrl(url: string): void {
  const route = mediaRouteForUrl(url);
  if (route) rememberRoute(route);
}

function mediaUrlForRoute(url: string, route: MediaRoute): string {
  const directUrl = toDirectMediaUrl(url);
  try {
    if (directMediaPath(new URL(directUrl, runtimeBaseUrl())) === null) return url;
  } catch {
    return url;
  }
  return route === "proxy" ? toProxyMediaUrl(directUrl) : directUrl;
}

export function getPreferredMediaUrl(url: string): string {
  return mediaUrlForRoute(url, preferredRoute);
}

export function routeMediaUrls(media: MediaUrlFields): MediaUrlFields {
  return {
    url: getPreferredMediaUrl(media.url),
    thumbnailUrl: media.thumbnailUrl ? getPreferredMediaUrl(media.thumbnailUrl) : undefined,
    previewUrl: media.previewUrl ? getPreferredMediaUrl(media.previewUrl) : undefined,
    voiceMemoUrl: media.voiceMemoUrl ? getPreferredMediaUrl(media.voiceMemoUrl) : undefined,
  };
}

async function probeMediaUrl(url: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, {
    method: "HEAD",
    cache: "no-store",
    signal,
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.ok || contentType.includes("text/html")) {
    throw new Error(`Media probe failed with ${response.status}`);
  }
}

function firstSuccessfulProbe(probes: Array<Promise<MediaRoute>>): Promise<MediaRoute> {
  return new Promise((resolve, reject) => {
    let failures = 0;
    let lastError: unknown;
    for (const probe of probes) {
      void probe.then(resolve, (error: unknown) => {
        lastError = error;
        failures += 1;
        if (failures === probes.length) reject(lastError);
      });
    }
  });
}

/**
 * Picks the first healthy route using HEAD requests only, so route selection
 * never downloads the photo body. The loser is aborted and the result is
 * shared and cached for 30 minutes.
 */
export function selectFastestMediaRoute(sampleUrl: string | undefined): Promise<MediaRoute> {
  if (!sampleUrl) return Promise.resolve(preferredRoute);
  const directUrl = toDirectMediaUrl(sampleUrl);
  const proxyUrl = toProxyMediaUrl(directUrl);
  if (absoluteUrl(directUrl) === absoluteUrl(proxyUrl)) {
    return Promise.resolve(preferredRoute);
  }
  const cached = readCachedRoute();
  if (cached) {
    preferredRoute = cached;
    return Promise.resolve(cached);
  }
  if (routeProbe) return routeProbe;

  routeProbe = (async () => {
    const directController = new AbortController();
    const proxyController = new AbortController();
    const timeoutId = setTimeout(() => {
      directController.abort();
      proxyController.abort();
    }, ROUTE_PROBE_TIMEOUT_MS);
    try {
      const route = await firstSuccessfulProbe([
        probeMediaUrl(directUrl, directController.signal).then(() => "direct" as const),
        probeMediaUrl(proxyUrl, proxyController.signal).then(() => "proxy" as const),
      ]);
      rememberRoute(route);
      return route;
    } catch {
      return preferredRoute;
    } finally {
      clearTimeout(timeoutId);
      directController.abort();
      proxyController.abort();
      routeProbe = null;
    }
  })();
  return routeProbe;
}

function mediaCandidates(urls: Array<string | undefined>): string[] {
  const candidates: string[] = [];
  for (const url of urls) {
    if (!url) continue;
    const preferred = getPreferredMediaUrl(url);
    const direct = toDirectMediaUrl(url);
    const alternate = preferredRoute === "proxy" ? direct : toProxyMediaUrl(direct);
    for (const candidate of [preferred, alternate]) {
      if (!candidates.some((existing) => absoluteUrl(existing) === absoluteUrl(candidate))) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

interface ElementFallbackState {
  sourceKey: string;
  candidates: string[];
  attempted: Set<string>;
}

const elementFallbackStates = new WeakMap<
  HTMLImageElement | HTMLMediaElement,
  ElementFallbackState
>();

/**
 * Advances an image/video to the next size or route. Attempted URLs are tracked
 * per element, guaranteeing that repeated error events terminate without loops.
 */
export function fallbackMediaSource(
  element: HTMLImageElement | HTMLMediaElement,
  urls: Array<string | undefined>,
): boolean {
  const sourceKey = urls.filter(Boolean).map((url) => absoluteUrl(url!)).join("\n");
  let state = elementFallbackStates.get(element);
  if (!state || state.sourceKey !== sourceKey) {
    state = { sourceKey, candidates: mediaCandidates(urls), attempted: new Set<string>() };
    elementFallbackStates.set(element, state);
  }

  const current = absoluteUrl(element.currentSrc || element.src);
  if (current) state.attempted.add(current);
  const next = state.candidates.find((candidate) => {
    const absolute = absoluteUrl(candidate);
    return absolute !== current && !state!.attempted.has(absolute);
  });
  if (!next) {
    elementFallbackStates.delete(element);
    return false;
  }

  state.attempted.add(absoluteUrl(next));
  const expectedSource = absoluteUrl(next);
  const successEvent = element.tagName === "IMG" ? "load" : "loadeddata";
  element.addEventListener(successEvent, () => {
    if (absoluteUrl(element.currentSrc || element.src) !== expectedSource) return;
    promoteSuccessfulMediaUrl(next);
  }, { once: true });
  element.src = next;
  return true;
}

export async function fetchMediaWithFallback(
  url: string,
  init?: RequestInit,
  routeTimeoutMs = MEDIA_ATTEMPT_TIMEOUT_MS,
): Promise<Response> {
  const candidates = mediaCandidates([url]);
  const requiresPartialContent = new Headers(init?.headers).has("Range");
  let lastResponse: Response | null = null;
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(init?.signal?.reason);
    if (init?.signal?.aborted) abortFromCaller();
    else init?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeoutId = setTimeout(
      () => controller.abort(new DOMException("Media route timed out", "TimeoutError")),
      routeTimeoutMs,
    );
    try {
      const response = await fetch(candidate, { ...init, signal: controller.signal });
      if (response.ok && (!requiresPartialContent || response.status === 206)) {
        const body = await response.arrayBuffer();
        const bufferedResponse = new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        Object.defineProperties(bufferedResponse, {
          url: { value: response.url },
          redirected: { value: response.redirected },
          type: { value: response.type },
        });
        if (index > 0) {
          const route = mediaRouteForUrl(candidate);
          if (route) rememberRoute(route);
        }
        return bufferedResponse;
      }
      lastResponse = new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      // A server that ignores Range can otherwise keep streaming the entire
      // video after the caller rejects its 200 response.
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
      init?.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("Media request failed");
}

/** Preloads an image while applying the same finite route/size fallback order. */
export function preloadImageWithFallback(
  urls: Array<string | undefined>,
  signal?: AbortSignal,
  routeTimeoutMs = MEDIA_ATTEMPT_TIMEOUT_MS,
): Promise<string> {
  const candidates = mediaCandidates(urls);
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined" || candidates.length === 0) {
      reject(new Error("No media candidate available"));
      return;
    }
    const image = new Image();
    let index = 0;
    let attemptId = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      image.src = "";
      reject(new DOMException("Media preload aborted", "AbortError"));
    };
    const attempt = () => {
      if (signal?.aborted) {
        abort();
        return;
      }
      const candidate = candidates[index];
      if (!candidate) {
        cleanup();
        reject(new Error("Media preload failed"));
        return;
      }
      const currentAttempt = ++attemptId;
      const advance = () => {
        if (currentAttempt !== attemptId) return;
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = null;
        index += 1;
        attempt();
      };
      image.onload = () => {
        if (currentAttempt !== attemptId) return;
        cleanup();
        if (index > 0) {
          const route = mediaRouteForUrl(candidate);
          if (route) rememberRoute(route);
        }
        resolve(candidate);
      };
      image.onerror = advance;
      timeoutId = setTimeout(() => {
        image.onload = null;
        image.onerror = null;
        image.src = "";
        advance();
      }, routeTimeoutMs);
      image.src = candidate;
    };
    signal?.addEventListener("abort", abort, { once: true });
    attempt();
  });
}

/**
 * Verifies a native-download route with bounded HEAD requests. The returned URL
 * can be assigned to an anchor without buffering a potentially large body in JS.
 */
export async function resolveMediaUrlWithFallback(
  url: string,
  timeoutMs = 5_000,
): Promise<string> {
  const candidates = mediaCandidates([url]);
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(candidate, {
        method: "HEAD",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      await response.body?.cancel();
      if (index > 0) {
        const route = mediaRouteForUrl(candidate);
        if (route) rememberRoute(route);
      }
      return response.url || candidate;
    } catch {
      // A failed or timed-out preferred route must not consume the alternate's budget.
    } finally {
      clearTimeout(timeoutId);
    }
  }
  // Native navigation may still succeed when cross-origin HEAD is blocked by CORS.
  return getPreferredMediaUrl(url);
}
