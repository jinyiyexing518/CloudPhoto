import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";

/** In-process cache: query → result JSON string (lives as long as the Function instance) */
const geocodeCache = new Map<string, { body: string; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * GET /api/geocode/search?q=<query>
 *
 * Server-side proxy for Nominatim forward geocoding.
 * Advantages over calling Nominatim directly from the browser:
 *  - Proper User-Agent (required by Nominatim ToS; missing → 429)
 *  - Works in regions where nominatim.openstreetmap.org is blocked
 *  - In-process cache reduces duplicate round-trips
 */
app.http("searchGeocode", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "geocode/search",
  handler: async (
    request: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(
      request.headers.get("authorization") ?? "",
    );
    if (!payload) {
      return {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const q = request.query.get("q")?.trim() ?? "";
    if (q.length < 2) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Query too short" }),
      };
    }

    // Serve from cache if still fresh
    const cacheKey = q.toLowerCase();
    const cached = geocodeCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      context.log(`[geocode] cache hit for "${q}"`);
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=600",
          "X-Cache": "HIT",
        },
        body: cached.body,
      };
    }

    try {
      const url =
        `https://nominatim.openstreetmap.org/search` +
        `?format=json` +
        `&q=${encodeURIComponent(q)}` +
        `&limit=8` +
        `&addressdetails=1` +
        `&accept-language=zh-CN,zh;q=0.9,en;q=0.5`;

      const resp = await fetch(url, {
        headers: {
          // Nominatim ToS: must identify app + contact
          "User-Agent": "CloudPhoto-App/1.0 (photo management; contact=cloudphoto)",
          "Accept": "application/json",
          "Referer": "https://cloudphoto.app",
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!resp.ok) {
        context.warn(`[geocode] Nominatim returned ${resp.status} for "${q}"`);
        return {
          status: 502,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: `Geocoding service error: ${resp.status}` }),
        };
      }

      type NominatimItem = {
        display_name?: string;
        lat?: string;
        lon?: string;
        address?: {
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
          tourism?: string;
          amenity?: string;
          shop?: string;
          building?: string;
        };
      };

      const raw = (await resp.json()) as NominatimItem[];

      /** Build a short, human-friendly name from structured address fields */
      function buildShortName(item: NominatimItem): string {
        const a = item.address;
        if (!a) return item.display_name?.split(",")[0] ?? "";

        // POI / venue name (tourism, amenity, shop, building) → use as primary
        const poi = a.tourism ?? a.amenity ?? a.shop ?? a.building;

        // City: prefer city > town > village > county
        const city = a.city ?? a.town ?? a.village ?? a.county;

        // Sub-city: prefer district > suburb > neighbourhood
        const sub = a.district ?? a.suburb ?? a.neighbourhood;

        const parts: string[] = [];
        if (poi) parts.push(poi);
        else if (a.road) parts.push(a.road);

        // For China: state === province (e.g. 广东省)
        const stateOrProv = a.state ?? a.province;
        if (city && city !== stateOrProv) parts.push(city);
        if (sub && sub !== city) parts.push(sub);
        if (!parts.length && stateOrProv) parts.push(stateOrProv);

        return (parts.join(" · ") || item.display_name?.split(",")[0]) ?? "";
      }

      const results = raw
        .filter((r) => r.lat && r.lon)
        .map((r) => ({
          displayName: r.display_name ?? "",
          shortName: buildShortName(r),
          lat: parseFloat(r.lat!),
          lon: parseFloat(r.lon!),
        }));

      const body = JSON.stringify(results);
      geocodeCache.set(cacheKey, { body, ts: Date.now() });
      context.log(`[geocode] "${q}" → ${results.length} results (cached)`);

      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=600",
          "X-Cache": "MISS",
        },
        body,
      };
    } catch (err) {
      context.error(`[geocode] error for "${q}":`, err);
      return {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Geocoding service unreachable" }),
      };
    }
  },
});
