import assert from "node:assert/strict";
import test from "node:test";
import {
  UploadRequestError,
  computeUploadRetryDelayMs,
  isRetryableUploadError,
  parseRetryAfterMs,
  waitForUploadRetry,
} from "./uploadRetry.ts";

test("retries only network, timeout, 408/425/429, and 5xx failures", () => {
  assert.equal(isRetryableUploadError(new UploadRequestError("offline", { kind: "network" })), true);
  assert.equal(isRetryableUploadError(new UploadRequestError("timeout", { kind: "timeout" })), true);
  for (const status of [408, 425, 429, 500, 502, 599]) {
    assert.equal(isRetryableUploadError(new UploadRequestError("retry", { kind: "http", status })), true);
  }
  for (const status of [400, 401, 403, 404, 409, 413, 422]) {
    assert.equal(isRetryableUploadError(new UploadRequestError("stop", { kind: "http", status })), false);
  }
});

test("parses Retry-After seconds and HTTP dates", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");
  assert.equal(parseRetryAfterMs("7", now), 7000);
  assert.equal(parseRetryAfterMs("Mon, 10 Aug 2026 12:00:09 GMT", now), 9000);
  assert.equal(parseRetryAfterMs("invalid", now), undefined);
});

test("bounded exponential full jitter honors bounded Retry-After", () => {
  assert.equal(computeUploadRetryDelayMs(0, undefined, () => 0.5), 500);
  assert.equal(computeUploadRetryDelayMs(2, undefined, () => 0.5), 2000);
  assert.equal(computeUploadRetryDelayMs(9, undefined, () => 1), 30000);
  assert.equal(computeUploadRetryDelayMs(0, 12000, () => 0), 12000);
  assert.equal(computeUploadRetryDelayMs(0, 120000, () => 0), 60000);
});

test("AbortSignal interrupts retry waiting", async () => {
  const controller = new AbortController();
  const waiting = waitForUploadRetry(60_000, controller.signal);
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(waiting, { name: "AbortError" });
});
