let claimed = false;
const PRIVATE_CACHE_ERROR_CODE = "PRIVATE_CACHE_FAILED";

export function claimPrivateCacheDegradationNotice(): boolean {
  if (claimed) return false;
  claimed = true;
  return true;
}

type PrivateCacheErrorShape = {
  code?: unknown;
  name?: unknown;
  step?: unknown;
  errors?: unknown;
};

function sanitizedStep(step: unknown): string | undefined {
  if (typeof step !== "string") return undefined;
  if (step.startsWith("Cache Storage deletion")) return "cache-storage-delete";
  const steps: Record<string, string> = {
    "Cache Storage access": "cache-storage-access",
    "service worker fence": "service-worker-fence",
    "database open": "database-open",
    "readwrite transaction": "database-transaction",
    "cacheName cursor": "database-cursor",
    deadline: "deadline",
  };
  return steps[step];
}

export function privateCacheDegradationLog(error: unknown) {
  const candidate: PrivateCacheErrorShape = (
    error && typeof error === "object" ? error : {}
  );
  const nested = Array.isArray(candidate.errors) ? candidate.errors : [];
  const steps = [candidate, ...nested]
    .map((item) => sanitizedStep(
      item && typeof item === "object"
        ? (item as PrivateCacheErrorShape).step
        : undefined,
    ))
    .filter((step): step is string => typeof step === "string");
  return {
    code: PRIVATE_CACHE_ERROR_CODE,
    kind: candidate.name === "AggregateError"
      ? "aggregate"
      : candidate.name === "PrivateCacheCleanupError"
        ? "step"
        : "unknown",
    steps: [...new Set(steps)],
  };
}

export function logPrivateCacheDegradation(context: string, error: unknown): void {
  console.error(context, privateCacheDegradationLog(error));
}
