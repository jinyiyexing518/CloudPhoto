import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import {
  nominatimGateway,
  NominatimGateway,
  NominatimQueueFullError,
  NominatimUpstreamError,
} from "../../utils/geocode/nominatimGateway";

interface ReverseResult {
  display_name?: string;
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
  };
}

function parseFiniteCoordinate(
  raw: string | null,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function appendUnique(parts: string[], value: string | undefined): void {
  if (value && !parts.includes(value)) parts.push(value);
}

export function buildReverseAddress(result: ReverseResult): string | null {
  const address = result.address;
  if (!address) return result.display_name?.trim() || null;
  const parts: string[] = [];
  if (address.country && address.country !== "中国") appendUnique(parts, address.country);
  appendUnique(parts, address.state ?? address.province);
  appendUnique(parts, address.city ?? address.town ?? address.village ?? address.county);
  appendUnique(parts, address.district ?? address.suburb ?? address.neighbourhood);
  appendUnique(parts, address.road);
  return parts.join("") || result.display_name?.trim() || null;
}

type Authenticator = (header: string | null) => unknown;

interface ReverseHandlerDependencies {
  gateway?: Pick<NominatimGateway<unknown>, "run">;
  authenticate?: Authenticator;
}

export function createReverseGeocodeHandler({
  gateway = nominatimGateway,
  authenticate = extractTokenFromHeader,
}: ReverseHandlerDependencies = {}) {
  return async (
    request: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    if (!authenticate(request.headers.get("authorization"))) {
      return {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }
    const lat = parseFiniteCoordinate(request.query.get("lat"), -90, 90);
    const lon = parseFiniteCoordinate(request.query.get("lon"), -180, 180);
    if (lat === null || lon === null) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid coordinates" }),
      };
    }

    const url = `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
    try {
      const result = await gateway.run(
        `reverse:${lat.toFixed(5)},${lon.toFixed(5)}`,
        url,
        24 * 60 * 60 * 1_000,
      ) as ReverseResult;
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=3600",
        },
        body: JSON.stringify({ address: buildReverseAddress(result) }),
      };
    } catch (error) {
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
      context.error("[geocode] reverse request failed", error);
      return {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Geocoding service unavailable" }),
      };
    }
  };
}

export const reverseGeocodeHandler = createReverseGeocodeHandler();

app.http("reverseGeocode", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "geocode/reverse",
  handler: reverseGeocodeHandler,
});
