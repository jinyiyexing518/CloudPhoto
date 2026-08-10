import assert from "node:assert/strict";
import test from "node:test";
import geocodeCore from "./geocodeCore.ts";

const {
  createReverseGeocoder,
  formatReverseAddress,
} = geocodeCore;

function response(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("uses the authenticated proxy first and falls back directly at most once", async () => {
  const calls = [];
  const reverse = createReverseGeocoder({
    fetch: async (url, init) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") });
      if (calls.length === 1) return response(502, { error: "upstream" });
      return response(200, {
        address: { country: "中国", state: "北京市", city: "北京市", district: "东城区", road: "东长安街" },
      });
    },
    getAuthorization: () => ({ token: "secret", cacheOwner: "user:viewer", generation: 7 }),
  });

  assert.equal(await reverse(39.9, 116.4, { workspace: "personal/user" }), "北京市东城区东长安街");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, "Bearer secret");
  assert.equal(calls[1].authorization, null);
});

test("does not fall back on authentication failures", async () => {
  let calls = 0;
  const reverse = createReverseGeocoder({
    fetch: async () => {
      calls += 1;
      return response(401, { error: "Unauthorized" });
    },
    getAuthorization: () => ({ token: "secret", cacheOwner: "user:viewer", generation: 1 }),
  });
  assert.equal(await reverse(1, 2), null);
  assert.equal(calls, 1);
});

test("uses a distinct refresh-aware proxy transport before the direct fallback", async () => {
  let proxyCalls = 0;
  let directCalls = 0;
  const reverse = createReverseGeocoder({
    proxyFetch: async () => {
      proxyCalls += 1;
      return response(200, { address: "refreshed proxy" });
    },
    fetch: async () => {
      directCalls += 1;
      return response(200, { display_name: "direct" });
    },
    getAuthorization: () => ({ token: "expired", cacheOwner: "u:viewer", generation: 1 }),
  });
  assert.equal(await reverse(1, 2), "refreshed proxy");
  assert.equal(proxyCalls, 1);
  assert.equal(directCalls, 0);
});

test("deadline composition does not require AbortSignal static helpers", async () => {
  const originalAny = AbortSignal.any;
  const originalTimeout = AbortSignal.timeout;
  Object.defineProperties(AbortSignal, {
    any: { configurable: true, value: undefined },
    timeout: { configurable: true, value: undefined },
  });
  try {
    let calls = 0;
    const reverse = createReverseGeocoder({
      fetch: async () => {
        calls += 1;
        return response(200, { display_name: "compatible" });
      },
      getAuthorization: () => null,
    });
    assert.equal(await reverse(1, 2), "compatible");
    assert.equal(calls, 1);
  } finally {
    Object.defineProperties(AbortSignal, {
      any: { configurable: true, value: originalAny },
      timeout: { configurable: true, value: originalTimeout },
    });
  }
});

test("negative cache expires, successful calls dedupe, and auth/workspace keys isolate values", async () => {
  let now = 0;
  let calls = 0;
  let identity = { token: "a", cacheOwner: "u1:viewer", generation: 1 };
  const reverse = createReverseGeocoder({
    now: () => now,
    negativeTtlMs: 10,
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("offline");
      return response(200, { address: `address-${identity.cacheOwner}-${calls}` });
    },
    getAuthorization: () => identity,
  });
  assert.equal(await reverse(1, 2, { workspace: "personal/u1" }), null);
  now = 11;
  const [a, b] = await Promise.all([
    reverse(1, 2, { workspace: "personal/u1" }),
    reverse(1, 2, { workspace: "personal/u1" }),
  ]);
  assert.equal(a, b);
  assert.equal(calls, 3);
  identity = { token: "b", cacheOwner: "u2:viewer", generation: 2 };
  assert.match(await reverse(1, 2, { workspace: "personal/u2" }), /u2/);
});

test("consumer abort rejects stale work and never turns it into an address", async () => {
  let release;
  const reverse = createReverseGeocoder({
    fetch: async (_url, init) => new Promise((resolve, reject) => {
      release = resolve;
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
    getAuthorization: () => ({ token: "a", cacheOwner: "u:viewer", generation: 1 }),
  });
  const controller = new AbortController();
  const pending = reverse(1, 2, { signal: controller.signal });
  controller.abort(new DOMException("stale", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  release?.(response(200, { address: "stale" }));
});

test("authorization drift rejects a late address instead of publishing it to the new session", async () => {
  let identity = { token: "a", cacheOwner: "u1:viewer", generation: 1 };
  let release;
  const reverse = createReverseGeocoder({
    fetch: async () => new Promise((resolve) => { release = resolve; }),
    getAuthorization: () => identity,
  });
  const pending = reverse(1, 2, { workspace: "personal/u1" });
  identity = { token: "b", cacheOwner: "u2:viewer", generation: 2 };
  release(response(200, { address: "old-session-address" }));
  await assert.rejects(pending, { name: "AbortError" });
});

test("an A to B to A switch does not reuse A's already-aborted in-flight entry", async () => {
  let calls = 0;
  const reverse = createReverseGeocoder({
    fetch: async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      }
      return response(200, { address: "fresh-a" });
    },
    getAuthorization: () => ({ token: "a", cacheOwner: "u:viewer", generation: 1 }),
  });
  const firstController = new AbortController();
  const stale = reverse(1, 2, { signal: firstController.signal, workspace: "personal/u" });
  firstController.abort(new DOMException("showing B", "AbortError"));
  const fresh = reverse(1, 2, { workspace: "personal/u" });
  await assert.rejects(stale, { name: "AbortError" });
  assert.equal(await fresh, "fresh-a");
  assert.equal(calls, 2);
});

test("a pre-aborted caller starts no reusable request", async () => {
  let calls = 0;
  const reverse = createReverseGeocoder({
    fetch: async () => {
      calls += 1;
      return response(200, { address: "fresh" });
    },
    getAuthorization: () => ({ token: "a", cacheOwner: "u:viewer", generation: 1 }),
  });
  const controller = new AbortController();
  controller.abort(new DOMException("already stale", "AbortError"));
  await assert.rejects(
    reverse(1, 2, { signal: controller.signal, workspace: "personal/u" }),
    { name: "AbortError" },
  );
  assert.equal(await reverse(1, 2, { workspace: "personal/u" }), "fresh");
  assert.equal(calls, 1);
});

test("formats a compact Chinese address with city, district, and road", () => {
  assert.equal(formatReverseAddress({
    country: "中国",
    state: "北京市",
    city: "北京市",
    district: "朝阳区",
    road: "建国路",
  }), "北京市朝阳区建国路");
});
