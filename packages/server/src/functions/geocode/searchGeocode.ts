import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import {
  nominatimGateway,
  NominatimQueueFullError,
  NominatimUpstreamError,
} from "../../utils/geocode/nominatimGateway";

interface NominatimItem {
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: {
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
}

function buildShortName(item: NominatimItem): string {
  const address = item.address;
  if (!address) return item.display_name?.split(",")[0] ?? "";
  const poi = address.tourism ?? address.amenity ?? address.shop ?? address.building;
  const city = address.city ?? address.town ?? address.village ?? address.county;
  const district = address.district ?? address.suburb ?? address.neighbourhood;
  const parts: string[] = [];
  if (poi) parts.push(poi);
  else if (address.road) parts.push(address.road);
  const state = address.state ?? address.province;
  if (city && city !== state) parts.push(city);
  if (district && district !== city) parts.push(district);
  if (!parts.length && state) parts.push(state);
  return parts.join(" · ") || item.display_name?.split(",")[0] || "";
}

function upstreamFailure(error: unknown, context: InvocationContext): HttpResponseInit {
  if (error instanceof NominatimQueueFullError) {
    return {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(error.retryAfterSeconds) },
      body: JSON.stringify({ error: "Geocoding service busy" }),
    };
  }
  if (error instanceof NominatimUpstreamError && error.upstreamStatus === 429) {
    return {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(error.retryAfterSeconds ?? 1),
      },
      body: JSON.stringify({ error: "Geocoding service rate limited" }),
    };
  }
  context.error("[geocode] upstream request failed", error);
  return {
    status: 502,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Geocoding service unavailable" }),
  };
}

export async function searchGeocodeHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  if (!extractTokenFromHeader(request.headers.get("authorization") ?? "")) {
    return {
      status: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }
  const query = request.query.get("q")?.trim() ?? "";
  if (query.length < 2 || query.length > 160) {
    return {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid query" }),
    };
  }

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=8&addressdetails=1`;
  try {
    const raw = await nominatimGateway.run(
      `search:${query.toLocaleLowerCase()}`,
      url,
      10 * 60 * 1_000,
    ) as NominatimItem[];
    const results = raw
      .filter((item) => item.lat && item.lon)
      .flatMap((item) => {
        const lat = Number(item.lat);
        const lon = Number(item.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
        return [{
          displayName: item.display_name ?? "",
          shortName: buildShortName(item),
          lat,
          lon,
        }];
      });
    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=600",
      },
      body: JSON.stringify(results),
    };
  } catch (error) {
    return upstreamFailure(error, context);
  }
}

app.http("searchGeocode", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "geocode/search",
  handler: searchGeocodeHandler,
});
