const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_JITTER_CAP_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;

export type UploadRequestErrorKind = "http" | "network" | "timeout" | "response";

interface UploadRequestErrorOptions {
  kind: UploadRequestErrorKind;
  status?: number;
  retryAfterMs?: number;
}

export class UploadRequestError extends Error {
  readonly kind: UploadRequestErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options: UploadRequestErrorOptions) {
    super(message);
    this.name = "UploadRequestError";
    this.kind = options.kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function parseRetryAfterMs(
  value: string | null,
  now = Date.now(),
): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/^\d+$/.test(normalized)) {
    return Number(normalized) * 1_000;
  }
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - now);
}

export function isRetryableUploadError(error: unknown): boolean {
  if (!(error instanceof UploadRequestError)) return false;
  if (error.kind === "network" || error.kind === "timeout") return true;
  const status = error.status;
  return status === 408
    || status === 425
    || status === 429
    || (status !== undefined && status >= 500 && status <= 599);
}

export function computeUploadRetryDelayMs(
  retryIndex: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.floor(retryIndex));
  const jitterCap = Math.min(
    RETRY_JITTER_CAP_MS,
    RETRY_BASE_DELAY_MS * (2 ** exponent),
  );
  const jitter = Math.floor(jitterCap * Math.min(1, Math.max(0, random())));
  const boundedRetryAfter = retryAfterMs === undefined
    ? 0
    : Math.min(RETRY_AFTER_CAP_MS, Math.max(0, retryAfterMs));
  return Math.max(jitter, boundedRetryAfter);
}

export function waitForUploadRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timerId !== undefined) clearTimeout(timerId);
      signal?.removeEventListener("abort", abort);
    };
    const complete = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("上传已取消", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    timerId = setTimeout(complete, Math.max(0, delayMs));
  });
}
