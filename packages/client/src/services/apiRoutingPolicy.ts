export function isSafeReplayMethod(method: string): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

const EXPENSIVE_API_READ_PATHS = new Set([
  "/photos",
  "/photos/locations",
  "/photos/motion-video",
  "/photos/trash",
  "/geocode/search",
]);

export function shouldHedgeApiRequest(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return isSafeReplayMethod(normalizedMethod)
    && (normalizedMethod !== "GET" || !EXPENSIVE_API_READ_PATHS.has(path));
}

export type ProxyProbeResult = "proxy" | "not-proxy" | "transient";

export const PROXY_PROBE_STABLE_TTL_MS = 5 * 60 * 1000;
export const PROXY_PROBE_TRANSIENT_TTL_MS = 5_000;

export function classifyProxyProbe(input: {
  ok: boolean;
  status: number;
  contentType: string;
  route?: string;
  server?: string;
}): ProxyProbeResult {
  if (input.ok && /\bnginx(?:\/|\b)/i.test(input.server ?? "")) {
    return "proxy";
  }
  if (input.ok && input.contentType.includes("application/json")) {
    return input.route === "cloudphoto-proxy" ? "proxy" : "not-proxy";
  }
  if (input.ok && input.contentType.includes("text/html")) {
    return "not-proxy";
  }
  if (input.status === 404) {
    return "not-proxy";
  }
  return "transient";
}

export function proxyProbeTtlMs(result: ProxyProbeResult): number {
  return result === "transient"
    ? PROXY_PROBE_TRANSIENT_TTL_MS
    : PROXY_PROBE_STABLE_TTL_MS;
}
