import assert from "node:assert/strict";
import test from "node:test";
import nominatim from "../dist/src/utils/geocode/nominatimGateway.js";

const {
  BoundedTtlLruCache,
  NominatimGateway,
  NominatimQueueFullError,
  NominatimUpstreamError,
} = nominatim;

test("bounded TTL cache expires entries and evicts the least recently used key", () => {
  let now = 0;
  const cache = new BoundedTtlLruCache(2, () => now);
  cache.set("a", "A", 100);
  cache.set("b", "B", 100);
  assert.equal(cache.get("a"), "A");
  cache.set("c", "C", 100);
  assert.equal(cache.get("b"), undefined);
  now = 101;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 0);
});

test("deduplicates identical work and shares one limiter across search and reverse keys", async () => {
  const starts = [];
  let now = 0;
  const deferred = [];
  const gateway = new NominatimGateway({
    minSpacingMs: 1_000,
    maxQueue: 4,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    request: async (url) => {
      starts.push({ url, at: now });
      return deferred.length ? deferred.shift() : { value: url };
    },
  });

  const first = gateway.run("reverse:1,2", "reverse", 60_000);
  const duplicate = gateway.run("reverse:1,2", "reverse", 60_000);
  const search = gateway.run("search:beijing", "search", 60_000);
  assert.strictEqual(first, duplicate);
  await Promise.all([first, search]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1].at - starts[0].at >= 1_000);
});

test("rejects overflow instead of creating an unbounded retry queue", async () => {
  let release;
  const gateway = new NominatimGateway({
    minSpacingMs: 0,
    maxQueue: 1,
    request: async () => new Promise((resolve) => { release = resolve; }),
  });
  const active = gateway.run("reverse:1,1", "one", 60_000);
  const queued = gateway.run("reverse:2,2", "two", 60_000);
  await assert.rejects(
    gateway.run("search:three", "three", 60_000),
    NominatimQueueFullError,
  );
  release({ value: 1 });
  await active;
  release({ value: 2 });
  await queued;
});

test("does not cache failed upstream requests", async () => {
  let calls = 0;
  const gateway = new NominatimGateway({
    minSpacingMs: 0,
    request: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary");
      return { ok: true };
    },
  });
  await assert.rejects(gateway.run("reverse:3,4", "reverse", 60_000), /temporary/);
  assert.deepEqual(await gateway.run("reverse:3,4", "reverse", 60_000), { ok: true });
  assert.equal(calls, 2);
});

test("honors upstream Retry-After before admitting the next queued request", async () => {
  let now = 0;
  const starts = [];
  let calls = 0;
  const gateway = new NominatimGateway({
    minSpacingMs: 1_000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    request: async () => {
      starts.push(now);
      calls += 1;
      if (calls === 1) throw new NominatimUpstreamError(429, 5);
      return { ok: true };
    },
  });
  const limited = gateway.run("reverse:limited", "limited", 60_000);
  const next = gateway.run("search:next", "next", 60_000);
  await assert.rejects(limited, { name: "NominatimUpstreamError" });
  await next;
  assert.deepEqual(starts, [0, 5_000]);
});
