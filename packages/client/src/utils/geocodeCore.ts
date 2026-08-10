export interface ReverseAddress {
  country?: string;
  state?: string;
  province?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  district?: string;
  suburb?: string;
  neighbourhood?: string;
  road?: string;
}

interface AuthorizationState {
  token: string;
  cacheOwner: string;
  generation: number;
}

interface ReverseOptions {
  signal?: AbortSignal;
  workspace?: string;
}

interface ReverseGeocoderDependencies {
  fetch?: typeof fetch;
  proxyFetch?: typeof fetch;
  getAuthorization: () => AuthorizationState | null;
  proxyBase?: string;
  now?: () => number;
  successTtlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
}

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

interface InflightEntry {
  controller: AbortController;
  promise: Promise<string | null>;
  consumers: number;
}

function addUnique(parts: string[], value: string | undefined): void {
  if (value && !parts.includes(value)) parts.push(value);
}

export function formatReverseAddress(address: ReverseAddress): string | null {
  const parts: string[] = [];
  if (address.country && address.country !== "中国") addUnique(parts, address.country);
  const state = address.state ?? address.province;
  addUnique(parts, state);
  addUnique(parts, address.city ?? address.town ?? address.village ?? address.county);
  addUnique(parts, address.district ?? address.suburb ?? address.neighbourhood);
  addUnique(parts, address.road);
  return parts.join("") || null;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function shouldFallback(status: number): boolean {
  return status === 404
    || status === 405
    || status === 429
    || status === 502
    || status === 503
    || status === 504;
}

export async function fetchWithDeadline<T>(
  request: typeof fetch,
  input: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Geocode request timed out", "TimeoutError")),
    8_000,
  );
  try {
    const response = await request(input, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

export function createReverseGeocoder(dependencies: ReverseGeocoderDependencies) {
  const request = dependencies.fetch ?? fetch;
  const proxyRequest = dependencies.proxyFetch ?? request;
  const now = dependencies.now ?? Date.now;
  const successTtlMs = dependencies.successTtlMs ?? 6 * 60 * 60 * 1_000;
  const negativeTtlMs = dependencies.negativeTtlMs ?? 3_000;
  const maxEntries = dependencies.maxEntries ?? 200;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, InflightEntry>();

  const setCache = (key: string, value: string | null) => {
    cache.delete(key);
    cache.set(key, {
      value,
      expiresAt: now() + (value ? successTtlMs : negativeTtlMs),
    });
    for (const [candidate, entry] of cache) {
      if (entry.expiresAt <= now()) cache.delete(candidate);
    }
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const fetchDirect = async (lat: number, lon: number, signal: AbortSignal): Promise<string | null> => {
    return fetchWithDeadline(
      request,
      `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&accept-language=zh-CN,zh`,
      { headers: { "Accept-Language": "zh-CN,zh;q=0.9" } },
      async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as { address?: ReverseAddress; display_name?: string };
        return body.address ? formatReverseAddress(body.address) : (body.display_name ?? null);
      },
      signal,
    );
  };

  const execute = async (
    lat: number,
    lon: number,
    authorization: AuthorizationState | null,
    signal: AbortSignal,
  ): Promise<string | null> => {
    if (authorization) {
      try {
        const result = await fetchWithDeadline(
          proxyRequest,
          `${dependencies.proxyBase ?? "/api"}/geocode/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
          {
            headers: { Authorization: `Bearer ${authorization.token}` },
          },
          async (response) => {
            if (!response.ok) return { status: response.status, address: null };
            const body = await response.json() as { address?: unknown };
            const address = typeof body.address === "string" && body.address.trim()
              ? body.address.trim()
              : null;
            return { status: response.status, address };
          },
          signal,
        );
        if (result.status >= 200 && result.status < 300) return result.address;
        if (!shouldFallback(result.status)) return null;
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    try {
      return await fetchDirect(lat, lon, signal);
    } catch (error) {
      if (isAbort(error)) throw error;
      return null;
    }
  };

  const waitFor = (
    entry: InflightEntry,
    signal?: AbortSignal,
  ): Promise<string | null> => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    entry.consumers += 1;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      entry.consumers -= 1;
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      if (entry.consumers === 0) entry.controller.abort(signal?.reason);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (value) => { if (!settled) { finish(); resolve(value); } },
      (error) => { if (!settled) { finish(); reject(error); } },
    );
  });

  return function reverseGeocode(
    lat: number,
    lon: number,
    options: ReverseOptions = {},
  ): Promise<string | null> {
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90
      || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return Promise.resolve(null);
    }
    const authorization = dependencies.getAuthorization();
    const identity = authorization
      ? `${authorization.cacheOwner}:${authorization.generation}`
      : "anonymous";
    const key = `${identity}:${options.workspace ?? "default"}:${lat.toFixed(5)},${lon.toFixed(5)}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      cache.delete(key);
      cache.set(key, cached);
      return Promise.resolve(cached.value);
    }
    if (cached) cache.delete(key);

    let entry = inflight.get(key);
    if (entry?.controller.signal.aborted) {
      inflight.delete(key);
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      const promise = execute(lat, lon, authorization, controller.signal).then((value) => {
        const current = dependencies.getAuthorization();
        const identityStillCurrent = authorization
          ? current?.cacheOwner === authorization.cacheOwner
            && current.generation === authorization.generation
          : current === null;
        if (!identityStillCurrent) {
          throw new DOMException("Authorization changed", "AbortError");
        }
        setCache(key, value);
        return value;
      });
      entry = { controller, promise, consumers: 0 };
      inflight.set(key, entry);
      void promise.finally(() => {
        if (inflight.get(key) === entry) inflight.delete(key);
      }).catch(() => undefined);
    }
    return waitFor(entry, options.signal);
  };
}

export default {
  createReverseGeocoder,
  fetchWithDeadline,
  formatReverseAddress,
};
