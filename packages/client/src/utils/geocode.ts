/** Module-level Promise cache so duplicate calls share the same in-flight request. */
const cache = new Map<string, Promise<string | null>>();

import { API_BASE } from "./apiBase";

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
 * Search for places by name.
 *
 * Strategy (same as the original MemoryMap doGeocode that was confirmed working):
 *   1. Direct Nominatim — fast (1-2 s), identical URL to what MemoryMap used.
 *   2. Server proxy fallback — used when Nominatim fails or is blocked;
 *      provides richer shortNames via structured address fields.
 *
 * The previous parallel-race approach had a correctness bug: if Nominatim
 * hung without a timeout and the proxy also failed, Promise.allSettled
 * would wait forever and the outer Promise would never resolve.
 */
export async function searchLocation(query: string): Promise<LocationSearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  if (searchCache.has(q)) return searchCache.get(q)!;

  // ── 1. Direct Nominatim (exact URL format that MemoryMap used) ────────────
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6`,
      { headers: { "Accept-Language": "zh-CN,zh;q=0.9" } },
    );
    if (resp.ok) {
      const data = await resp.json() as Array<{ display_name?: string; lat?: string; lon?: string }>;
      const results: LocationSearchResult[] = data
        .filter((r) => r.display_name && r.lat && r.lon)
        .map((r) => ({
          displayName: r.display_name!,
          shortName: r.display_name!.split(", ").slice(0, 2).join(", "),
          lat: parseFloat(r.lat!),
          lon: parseFloat(r.lon!),
        }));
      if (results.length > 0) {
        searchCache.set(q, results);
        return results;
      }
    }
  } catch { /* network error — fall through to proxy */ }

  // ── 2. Server proxy (richer shortNames, required when Nominatim is blocked) ─
  const token = getToken();
  if (token) {
    try {
      const resp = await fetch(
        `${API_BASE}/geocode/search?q=${encodeURIComponent(q)}`,
        { headers: { "Authorization": `Bearer ${token}` } },
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
        if (results.length > 0) {
          searchCache.set(q, results);
          return results;
        }
      }
    } catch { /* ignore */ }
  }

  return [];
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
