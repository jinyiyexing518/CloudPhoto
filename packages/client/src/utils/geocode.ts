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

// ── Internal fetch helpers ────────────────────────────────────────────────

/**
 * Direct Nominatim fetch — same approach used by MemoryMap.
 * Fast (1-2 s), no server dependency, but shortName is a simple split.
 */
async function fetchFromNominatim(q: string): Promise<LocationSearchResult[] | null> {
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&accept-language=zh-CN,zh`,
      { headers: { "Accept-Language": "zh-CN,zh;q=0.9" } },
    );
    if (!resp.ok) return null;
    const data = await resp.json() as Array<{ display_name?: string; lat?: string; lon?: string }>;
    const results: LocationSearchResult[] = data
      .filter((r) => r.display_name && r.lat && r.lon)
      .map((r) => ({
        displayName: r.display_name!,
        shortName: r.display_name!.split(", ").slice(0, 2).join(", "),
        lat: parseFloat(r.lat!),
        lon: parseFloat(r.lon!),
      }));
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

/**
 * Server proxy fetch — Nominatim-ToS-compliant User-Agent, 10-min cache,
 * and a richer shortName built from structured address fields.
 * Slower on Azure Functions cold start (~10-20 s) but faster when warm.
 */
async function fetchFromProxy(q: string, token: string): Promise<LocationSearchResult[] | null> {
  try {
    const resp = await fetch(
      `${API_BASE}/geocode/search?q=${encodeURIComponent(q)}`,
      { headers: { "Authorization": `Bearer ${token}` } },
    );
    if (!resp.ok) return null;
    const data = await resp.json() as Array<{ displayName?: string; shortName?: string; lat?: number; lon?: number }>;
    const results: LocationSearchResult[] = data
      .filter((r) => r.lat != null && r.lon != null)
      .map((r) => ({
        displayName: r.displayName ?? "",
        shortName: r.shortName ?? r.displayName?.split(",")[0] ?? "",
        lat: r.lat!,
        lon: r.lon!,
      }));
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

/**
 * Search for places by name.
 *
 * Fires direct Nominatim AND the CloudPhoto server proxy in **parallel** —
 * whichever returns a non-empty result first wins.  This gives MemoryMap-class
 * speed (direct Nominatim ≈ 1-2 s) while using the server proxy's richer
 * shortNames when Azure Functions is already warm.
 *
 * The previous serial approach (proxy → 10 s timeout → Nominatim) caused an
 * 18 s worst-case wait on Azure Functions cold start, making the search appear
 * broken.
 */
export function searchLocation(query: string): Promise<LocationSearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return Promise.resolve([]);
  if (searchCache.has(q)) return Promise.resolve(searchCache.get(q)!);

  const token = getToken();
  const nominatimP = fetchFromNominatim(q);
  const proxyP = token ? fetchFromProxy(q, token) : Promise.resolve(null);

  return new Promise<LocationSearchResult[]>((resolve) => {
    let settled = false;

    const finish = (r: LocationSearchResult[] | null) => {
      if (!settled && r && r.length > 0) {
        settled = true;
        searchCache.set(q, r);
        resolve(r);
      }
    };

    void nominatimP.then(finish);
    void proxyP.then((r) => {
      // Always update cache with the richer proxy results (even if Nominatim won)
      if (r && r.length > 0) searchCache.set(q, r);
      finish(r);
    });

    // Guarantee resolution when both return empty/null
    void Promise.allSettled([nominatimP, proxyP]).then(([n, p]) => {
      if (!settled) {
        settled = true;
        const nr = n.status === "fulfilled" ? n.value ?? [] : [];
        const pr = p.status === "fulfilled" ? p.value ?? [] : [];
        const result = pr.length > 0 ? pr : nr;
        searchCache.set(q, result);
        resolve(result);
      }
    });
  });
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
