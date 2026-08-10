export class BoundedTtlLruCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    this.pruneExpired();
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export class NominatimQueueFullError extends Error {
  readonly retryAfterSeconds = 1;

  constructor() {
    super("Nominatim request queue is full");
    this.name = "NominatimQueueFullError";
  }
}

export class NominatimUpstreamError extends Error {
  constructor(
    readonly upstreamStatus: number | null,
    readonly retryAfterSeconds?: number,
    message = "Nominatim request failed",
  ) {
    super(message);
    this.name = "NominatimUpstreamError";
  }
}

interface GatewayOptions<T> {
  request: (url: string) => Promise<T>;
  maxCacheEntries?: number;
  maxQueue?: number;
  minSpacingMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface QueuedRequest<T> {
  key: string;
  url: string;
  ttlMs: number;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class NominatimGateway<T = unknown> {
  private readonly cache: BoundedTtlLruCache<T>;
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly queue: QueuedRequest<T>[] = [];
  private readonly maxQueue: number;
  private readonly minSpacingMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly request: (url: string) => Promise<T>;
  private running = false;
  private lastStart = Number.NEGATIVE_INFINITY;
  private blockedUntil = Number.NEGATIVE_INFINITY;

  constructor(options: GatewayOptions<T>) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.request = options.request;
    this.maxQueue = options.maxQueue ?? 12;
    this.minSpacingMs = options.minSpacingMs ?? 1_000;
    this.cache = new BoundedTtlLruCache(options.maxCacheEntries ?? 256, this.now);
  }

  run(key: string, url: string, ttlMs: number): Promise<T> {
    const cached = this.cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const duplicate = this.inflight.get(key);
    if (duplicate) return duplicate;
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new NominatimQueueFullError());
    }

    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({ key, url, ttlMs, resolve, reject });
    });
    this.inflight.set(key, promise);
    void this.pump();
    return promise;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        const waitMs = Math.max(
          0,
          this.minSpacingMs - (this.now() - this.lastStart),
          this.blockedUntil - this.now(),
        );
        if (waitMs > 0) await this.sleep(waitMs);
        this.lastStart = this.now();
        try {
          const value = await this.request(item.url);
          this.cache.set(item.key, value, item.ttlMs);
          item.resolve(value);
        } catch (error) {
          if (error instanceof NominatimUpstreamError && error.upstreamStatus === 429) {
            this.blockedUntil = Math.max(
              this.blockedUntil,
              this.now() + (error.retryAfterSeconds ?? 1) * 1_000,
            );
          }
          item.reject(error);
        } finally {
          this.inflight.delete(item.key);
        }
      }
    } finally {
      this.running = false;
      if (this.queue.length > 0) void this.pump();
    }
  }
}

function normalizeRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(1, Math.ceil((date - Date.now()) / 1_000));
}

async function requestNominatim(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "CloudPhoto/1.0 (https://github.com/jinyiyexing518/CloudPhoto)",
        "Accept": "application/json",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new NominatimUpstreamError(null, undefined, error instanceof Error ? error.message : undefined);
  }
  if (!response.ok) {
    throw new NominatimUpstreamError(
      response.status,
      normalizeRetryAfter(response.headers.get("Retry-After")),
    );
  }
  return response.json();
}

export const nominatimGateway = new NominatimGateway({
  request: requestNominatim,
  maxCacheEntries: 256,
  maxQueue: 12,
  minSpacingMs: 1_000,
});
