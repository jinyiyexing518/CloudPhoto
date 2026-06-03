/** Module-level Promise cache so duplicate calls share the same in-flight request. */
const cache = new Map<string, Promise<string | null>>();

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

/** A single place result from Nominatim forward search. */
export interface LocationSearchResult {
  displayName: string;
  lat: number;
  lon: number;
}

/** Session-level cache so repeated queries don't re-hit Nominatim */
const searchCache = new Map<string, LocationSearchResult[]>();

/**
 * Search for places by name using Nominatim (OpenStreetMap).
 * Results are cached per session. Requires at least 2 characters.
 */
export async function searchLocation(query: string): Promise<LocationSearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  if (searchCache.has(q)) return searchCache.get(q)!;
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&accept-language=zh-CN,zh`,
    );
    if (!resp.ok) return [];
    const data = await resp.json() as Array<{ display_name?: string; lat?: string; lon?: string }>;
    const results = data
      .filter((r) => r.display_name && r.lat && r.lon)
      .map((r) => ({
        displayName: r.display_name!,
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
