import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./uploadApi.ts", import.meta.url), "utf8");

test("XHR failures preserve status and Retry-After metadata", () => {
  assert.match(source, /new UploadRequestError\(message,\s*\{\s*kind: "http",\s*status: xhr\.status,/s);
  assert.match(source, /parseRetryAfterMs\(xhr\.getResponseHeader\("retry-after"\)\)/);
  assert.match(source, /new UploadRequestError\("网络错误", \{ kind: "network" \}\)/);
  assert.match(source, /new UploadRequestError\(`上传超时:/);
});

test("XHR cancellation and idempotent direct fallback remain wired", () => {
  assert.match(source, /signal\?\.addEventListener\("abort", abort, \{ once: true \}\)/);
  assert.match(source, /onAttemptStart\?\.\(\);\s*const xhr = new XMLHttpRequest\(\)/);
  assert.match(source, /if \(!recoverMisroutedProxy \|\| !uploadId \|\| targetUrl === directUploadUrl\) return false/);
  assert.match(source, /void uploadOnce\(directUploadUrl, false\)\.then\(resolve, reject\)/);
});
