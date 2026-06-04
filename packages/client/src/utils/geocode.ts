/** Module-level Promise cache so duplicate calls share the same in-flight request. */
const cache = new Map<string, Promise<string | null>>();

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

/** Retrieve the stored auth token (mirrors authHeaders() in photoApi.ts) */
function getToken(): string | null {
  return localStorage.getItem("cloudphoto_token");
}

type NominatimResponse = {
  display_name?: string;
  address?: {
    country?: string;
    state?: string;
    city?: string;
    town?: string;
    village?: string;
    county?: string;
    district?: string;
    suburb?: string;
    road?: string;
  };
};

async function fetchAddress(lat: number, lon: number): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=zh-CN,zh`,
    );
    if (!resp.ok) return null;
    const data = await resp.json() as NominatimResponse;
    const a = data.address;
    if (!a) return data.display_name ?? null;

    const parts: string[] = [];
    // Only show country for non-China locations
    if (a.country && a.country !== "中国") parts.push(a.country);
    if (a.state) parts.push(a.state);
    const city = a.city ?? a.town ?? a.village ?? a.county;
    if (city) parts.push(city);
    const district = a.district ?? a.suburb;
    if (district && district !== city) parts.push(district);

    return parts.length ? parts.join("") : (data.display_name ?? null);
  } catch {
    return null;
  }
}

/** A single place result from the geocoding backend. */
export interface LocationSearchResult {
  displayName: string;
  /** Short human-friendly label, e.g. "北京天安门 · 东城区" */
  shortName: string;
  lat: number;
  lon: number;
}

/** Session-level cache so repeated queries don't re-hit the backend */
const searchCache = new Map<string, LocationSearchResult[]>();

/**
 * Search for places by name via the CloudPhoto backend proxy
 * (which calls Nominatim server-side with proper User-Agent and caching).
 * Falls back to direct Nominatim if the proxy returns an error.
 */
export async function searchLocation(query: string): Promise<LocationSearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  if (searchCache.has(q)) return searchCache.get(q)!;

  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const resp = await fetch(
      `${API_BASE}/geocode/search?q=${encodeURIComponent(q)}`,
      { headers, signal: AbortSignal.timeout(10000) },
    );
    if (resp.ok) {
      const data = await resp.json() as Array<{ displayName?: string; shortName?: string; lat?: number; lon?: number }>;
      const results: LocationSearchResult[] = data
        .filter((r) => r.lat != null && r.lon != null)
        .map((r) => ({
          displayName: r.displayName ?? "",
          shortName: r.shortName ?? r.displayName?.split(",")[0] ?? "",
          lat: r.lat!,
          lon: r.lon!,
        }));
      searchCache.set(q, results);
      return results;
    }
  } catch { /* fall through to direct Nominatim */ }

  // Direct fallback (may fail in some regions, but better than nothing)
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&accept-language=zh-CN,zh`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!resp.ok) return [];
    const data = await resp.json() as Array<{ display_name?: string; lat?: string; lon?: string }>;
    const results: LocationSearchResult[] = data
      .filter((r) => r.display_name && r.lat && r.lon)
      .map((r) => ({
        displayName: r.display_name!,
        shortName: r.display_name!.split(", ")[0],
        lat: parseFloat(r.lat!),
        lon: parseFloat(r.lon!),
      }));
    searchCache.set(q, results);
    return results;
  } catch {
    return [];
  }
}

/**
 * Reverse geocode coordinates to a human-readable address.
 * Results are cached per session (de-duplicated to 3 decimal places ≈ 111m).
 */
export function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = fetchAddress(lat, lon);
  cache.set(key, promise);
  return promise;
}
