import assert from "node:assert/strict";
import test from "node:test";
import reverseModule from "../dist/src/functions/geocode/reverseGeocode.js";
import gatewayModule from "../dist/src/utils/geocode/nominatimGateway.js";

const { createReverseGeocodeHandler } = reverseModule;
const {
  NominatimQueueFullError,
  NominatimUpstreamError,
} = gatewayModule;

function request(query = {}, authorization = "Bearer test") {
  return {
    headers: new Headers({ authorization }),
    query: new URLSearchParams(query),
  };
}

function context() {
  return { error() {}, warn() {}, log() {} };
}

test("requires authentication before accepting reverse coordinates", async () => {
  const handler = createReverseGeocodeHandler({
    authenticate: () => null,
    gateway: { run: async () => ({}) },
  });
  assert.equal((await handler(request({ lat: "0", lon: "0" }, ""), context())).status, 401);
});

test("strictly validates finite coordinate ranges while preserving zero", async () => {
  let calls = 0;
  const handler = createReverseGeocodeHandler({
    authenticate: () => ({ userId: "u" }),
    gateway: {
      run: async () => {
        calls += 1;
        return { address: { country: "中国", city: "北京市", district: "东城区" } };
      },
    },
  });
  for (const query of [
    { lat: "", lon: "0" },
    { lat: "NaN", lon: "0" },
    { lat: "91", lon: "0" },
    { lat: "0", lon: "-181" },
  ]) {
    assert.equal((await handler(request(query), context())).status, 400);
  }
  const valid = await handler(request({ lat: "0", lon: "0" }), context());
  assert.equal(valid.status, 200);
  assert.deepEqual(JSON.parse(valid.body), { address: "北京市东城区" });
  assert.equal(calls, 1);
});

test("returns normalized 429 responses for upstream and local admission limits", async () => {
  for (const error of [
    new NominatimQueueFullError(),
    new NominatimUpstreamError(429, 7),
  ]) {
    const handler = createReverseGeocodeHandler({
      authenticate: () => ({ userId: "u" }),
      gateway: { run: async () => { throw error; } },
    });
    const result = await handler(request({ lat: "1", lon: "2" }), context());
    assert.equal(result.status, 429);
    assert.equal(result.headers["Retry-After"], error.retryAfterSeconds === 1 ? "1" : "7");
  }
});

test("maps timeout and transport failures to 502 without exposing request credentials", async () => {
  const handler = createReverseGeocodeHandler({
    authenticate: () => ({ userId: "u" }),
    gateway: {
      run: async () => {
        throw new NominatimUpstreamError(null, undefined, "timeout");
      },
    },
  });
  const result = await handler(request({ lat: "1", lon: "2" }), context());
  assert.equal(result.status, 502);
  assert.doesNotMatch(result.body, /Bearer|test/);
});
