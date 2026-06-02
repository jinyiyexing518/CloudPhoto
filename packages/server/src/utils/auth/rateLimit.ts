/**
 * Simple in-process sliding-window rate limiter.
 * One counter map per Azure Functions worker instance.
 * Sufficient to block brute-force on login / register / refresh.
 */
const _windows = new Map<string, { count: number; resetAt: number }>();

/**
 * Returns true if the request is allowed; false if the limit is exceeded.
 * @param key      Unique bucket key, e.g. "login:1.2.3.4"
 * @param max      Maximum requests allowed within the window
 * @param windowMs Window duration in milliseconds
 */
export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = _windows.get(key);
  if (!entry || now > entry.resetAt) {
    _windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

/** Extracts the client IP from common Azure / reverse-proxy headers. */
export function getClientIp(request: { headers: { get: (h: string) => string | null } }): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    request.headers.get("x-client-ip") ??
    "unknown"
  );
}
