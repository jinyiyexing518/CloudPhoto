import {
  authHeadersForSnapshot,
  fetchWithTimeout,
  getAuthGeneration,
  getAuthorizationSnapshot,
} from "../services/http";
import { API_BASE } from "./apiBase";
import { createReverseGeocoder, fetchWithDeadline } from "./geocodeCore";

export interface LocationSearchResult {
  displayName: string;
  shortName: string;
  lat: number;
  lon: number;
}

const searchCache = new Map<string, LocationSearchResult[]>();

export async function searchLocation(
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<LocationSearchResult[]> {
  const normalized = query.trim();
  if (normalized.length < 2) return [];
  const snapshot = getAuthorizationSnapshot();
  const generation = getAuthGeneration();
  const authorizationIsCurrent = () => (
    getAuthGeneration() === generation
    && getAuthorizationSnapshot()?.cacheOwner === snapshot?.cacheOwner
  );
  const cacheKey = `${snapshot?.cacheOwner ?? "anonymous"}:${normalized.toLocaleLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  if (snapshot) {
    try {
      const response = await fetchWithTimeout(
        `${API_BASE}/geocode/search?q=${encodeURIComponent(normalized)}`,
        { headers: authHeadersForSnapshot(snapshot), signal: options.signal },
      );
      if (!authorizationIsCurrent() || options.signal?.aborted) return [];
      if (response.ok) {
        const data = await response.json() as Array<{
          displayName?: string;
          shortName?: string;
          lat?: number;
          lon?: number;
        }>;
        const results = data.flatMap<LocationSearchResult>((item) => (
          Number.isFinite(item.lat) && Number.isFinite(item.lon)
            ? [{
                displayName: item.displayName ?? "",
                shortName: item.shortName ?? item.displayName?.split(",")[0] ?? "",
                lat: item.lat!,
                lon: item.lon!,
              }]
            : []
        ));
        if (results.length > 0 && authorizationIsCurrent() && !options.signal?.aborted) {
          searchCache.set(cacheKey, results);
          return results;
        }
      }
    } catch {
      if (options.signal?.aborted) return [];
      // The direct request below is the single fallback for an unavailable proxy.
    }
  }

  if (options.signal?.aborted || !authorizationIsCurrent()) return [];
  try {
    const results = await fetchWithDeadline(
      fetch,
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(normalized)}&format=json&limit=6`,
      {
        headers: { "Accept-Language": "zh-CN,zh;q=0.9" },
      },
      async (response) => {
        if (!response.ok) return [];
        const data = await response.json() as Array<{
          display_name?: string;
          lat?: string;
          lon?: string;
        }>;
        const results = data.flatMap<LocationSearchResult>((item) => {
          const lat = Number(item.lat);
          const lon = Number(item.lon);
          if (!item.display_name || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
          return [{
            displayName: item.display_name,
            shortName: item.display_name.split(", ").slice(0, 2).join(", "),
            lat,
            lon,
          }];
        });
        return results;
      },
      options.signal,
    );
    if (options.signal?.aborted || !authorizationIsCurrent()) return [];
    if (results.length > 0) searchCache.set(cacheKey, results);
    return results;
  } catch {
    return [];
  }
}

const reverseGeocoder = createReverseGeocoder({
  proxyBase: API_BASE,
  proxyFetch: (input, init) => fetchWithTimeout(
    input instanceof URL ? input.toString() : input,
    init,
    8_000,
  ),
  getAuthorization: () => {
    const snapshot = getAuthorizationSnapshot();
    return snapshot
      ? {
          token: snapshot.token,
          cacheOwner: snapshot.cacheOwner,
          generation: getAuthGeneration(),
        }
      : null;
  },
});

export function reverseGeocode(
  lat: number,
  lon: number,
  options: { signal?: AbortSignal; workspace?: string } = {},
): Promise<string | null> {
  return reverseGeocoder(lat, lon, options);
}
