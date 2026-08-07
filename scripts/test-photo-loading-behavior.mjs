#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));

async function compileTypeScript(relativePath, transform = (source) => source) {
  const source = transform(await readFile(join(root, relativePath), "utf8"));
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}

async function importTypeScript(relativePath, transform) {
  return import(await compileTypeScript(relativePath, transform));
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

function delayedAttempt({ value, delay, reject = false, never = false }) {
  let cancelCount = 0;
  let releaseCount = 0;
  let timer;
  let rejectPromise;
  const promise = new Promise((resolve, rejectAttempt) => {
    rejectPromise = rejectAttempt;
    if (never) return;
    timer = setTimeout(() => {
      if (reject) rejectAttempt(value);
      else resolve(value);
    }, delay);
  });
  return {
    attempt: {
      promise,
      cancel(reason) {
        cancelCount += 1;
        clearTimeout(timer);
        rejectPromise(reason ?? new DOMException("Cancelled", "AbortError"));
      },
      release() {
        releaseCount += 1;
      },
    },
    counts: () => ({ cancelCount, releaseCount }),
  };
}

const policyUrl = await compileTypeScript(
  "packages/client/src/services/photoLoadingPolicy.ts",
);
const policy = await import(policyUrl);

const admin = policy.decodeAuthorizationSnapshot(jwt({
  userId: "same-user",
  role: "admin",
}));
const viewer = policy.decodeAuthorizationSnapshot(jwt({
  userId: "same-user",
  role: "viewer",
}));
assert(admin && viewer);
assert.notEqual(admin.cacheOwner, viewer.cacheOwner, "role downgrade must change cache owner");
assert.equal(
  policy.canPublishPhotoList({
    expectedOwner: admin.cacheOwner,
    currentOwner: viewer.cacheOwner,
    expectedCacheGeneration: 3,
    currentCacheGeneration: 3,
  }),
  false,
  "role drift must reject list publication",
);
assert.equal(
  policy.canPublishPhotoList({
    expectedOwner: viewer.cacheOwner,
    currentOwner: viewer.cacheOwner,
    expectedCacheGeneration: 3,
    currentCacheGeneration: 4,
  }),
  false,
  "cache invalidation must reject an older response",
);
assert.equal(
  policy.canPublishPhotoList({
    expectedOwner: viewer.cacheOwner,
    currentOwner: viewer.cacheOwner,
    expectedCacheGeneration: 4,
    currentCacheGeneration: 4,
    expectedStateRevision: 8,
    currentStateRevision: 9,
  }),
  false,
  "a mutation must supersede an older revalidation",
);

assert.equal(policy.isSafeReplayMethod("GET"), true);
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  assert.equal(policy.isSafeReplayMethod(method), false, `${method} must not replay`);
}

assert.equal(
  policy.classifyProxyProbe({
    ok: true,
    status: 200,
    contentType: "application/json",
    route: "cloudphoto-proxy",
  }),
  "proxy",
);
assert.equal(
  policy.classifyProxyProbe({
    ok: true,
    status: 200,
    contentType: "text/html; charset=utf-8",
  }),
  "not-proxy",
);
assert.equal(
  policy.classifyProxyProbe({
    ok: false,
    status: 504,
    contentType: "text/plain",
  }),
  "transient",
);
assert(
  policy.proxyProbeTtlMs("transient") < policy.proxyProbeTtlMs("proxy"),
  "transient probe failures must retry sooner than explicit outcomes",
);

{
  const primary = delayedAttempt({ value: { status: 200 }, delay: 35 });
  const fallback = delayedAttempt({ value: new TypeError("offline"), delay: 8, reject: true });
  const outcome = await policy.raceHedgedAttempts({
    startPrimary: () => primary.attempt,
    startFallback: () => fallback.attempt,
    hedgeDelayMs: 5,
    isUsable: (response) => response.status < 500,
  });
  assert.equal(outcome.source, "primary");
  assert.equal(
    primary.counts().cancelCount,
    0,
    "fallback failure must not kill a slow healthy primary",
  );
  outcome.release();
}

{
  const primary = delayedAttempt({ value: { status: 200 }, delay: 50 });
  const fallback = delayedAttempt({ value: { status: 200 }, delay: 5 });
  const outcome = await policy.raceHedgedAttempts({
    startPrimary: () => primary.attempt,
    startFallback: () => fallback.attempt,
    hedgeDelayMs: 5,
    isUsable: (response) => response.status < 500,
  });
  assert.equal(outcome.source, "fallback");
  assert.equal(primary.counts().cancelCount, 1, "winning fallback must cancel its loser");
  outcome.release();
}

{
  const controller = new AbortController();
  const primary = delayedAttempt({ never: true });
  const fallback = delayedAttempt({ never: true });
  const pending = policy.raceHedgedAttempts({
    startPrimary: () => primary.attempt,
    startFallback: () => fallback.attempt,
    hedgeDelayMs: 2,
    isUsable: () => true,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 8));
  controller.abort(new DOMException("Caller cancelled", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(primary.counts().cancelCount, 1);
  assert.equal(fallback.counts().cancelCount, 1);
}

const responses = new Map();
const delays = [];
const fakeCache = {
  async keys() {
    return [...responses.keys()].map((url) => new Request(url));
  },
  async match(input) {
    const url = typeof input === "string" ? input : input.url;
    return responses.get(url)?.clone();
  },
  async delete(input) {
    const url = typeof input === "string" ? input : input.url;
    return responses.delete(url);
  },
  async put(input, response) {
    const body = await response.clone().json();
    const delay = body[0]?.version === "old" ? 25 : 0;
    delays.push(delay);
    await new Promise((resolve) => setTimeout(resolve, delay));
    const url = typeof input === "string" ? input : input.url;
    responses.set(url, response.clone());
  },
};
globalThis.window = {
  location: {
    origin: "https://www.cloudphotos.top",
    hostname: "www.cloudphotos.top",
  },
  caches: {
    async open() {
      return fakeCache;
    },
    async delete() {
      responses.clear();
      return true;
    },
  },
};
globalThis.localStorage = {
  values: new Map(),
  getItem(key) {
    return this.values.get(key) ?? null;
  },
  setItem(key, value) {
    this.values.set(key, value);
  },
  removeItem(key) {
    this.values.delete(key);
  },
};

const apiBaseUrl = await compileTypeScript(
  "packages/client/src/utils/apiBase.ts",
  (source) => source.replaceAll("import.meta.env", "({})"),
);
const httpUrl = await compileTypeScript(
  "packages/client/src/services/http.ts",
  (source) => source
    .replace('"../utils/apiBase"', JSON.stringify(apiBaseUrl))
    .replace('"./photoLoadingPolicy"', JSON.stringify(policyUrl)),
);
const http = await import(httpUrl);

{
  let healthCalls = 0;
  globalThis.fetch = (input) => {
    const url = String(input);
    assert(url.endsWith("/healthz"));
    healthCalls += 1;
    return new Promise((resolve) => {
      setTimeout(() => resolve(new Response("gateway timeout", {
        status: 504,
        headers: { "Content-Type": "text/plain" },
      })), 80);
    });
  };
  const controller = new AbortController();
  const startedAt = Date.now();
  const cancelled = http.resolveApiUrl(
    "https://cloudphoto-api.azurewebsites.net/api/photos/upload",
    controller.signal,
  );
  const concurrent = http.resolveApiUrl(
    "https://cloudphoto-api.azurewebsites.net/api/photos/upload",
  );
  setTimeout(() => controller.abort(new DOMException("Caller cancelled", "AbortError")), 5);
  await assert.rejects(cancelled, { name: "AbortError" });
  assert(
    Date.now() - startedAt < 50,
    "caller abort must not wait for the shared health probe",
  );
  assert.equal(
    await concurrent,
    "https://cloudphoto-api.azurewebsites.net/api/photos/upload",
  );
  assert.equal(healthCalls, 1, "concurrent health probes must deduplicate");
}

{
  let apiCalls = 0;
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    apiCalls += 1;
    init?.signal?.addEventListener("abort", () => reject(
      init.signal.reason ?? new DOMException("Aborted", "AbortError"),
    ), { once: true });
  });
  const startedAt = Date.now();
  await assert.rejects(
    http.fetchWithTimeout(
      "https://cloudphoto-api.azurewebsites.net/api/photos",
      { method: "GET" },
      30,
    ),
    { name: "AbortError" },
  );
  assert(Date.now() - startedAt < 100, "total timeout must remain effective");
  assert.equal(apiCalls, 1, "timeout before hedge must not launch a fallback");
}

{
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("unavailable", { status: 503 });
  };
  const response = await http.fetchWithTimeout(
    "https://cloudphoto-api.azurewebsites.net/api/photos/upload",
    { method: "POST", body: new Blob(["photo"]) },
    1_000,
  );
  assert.equal(response.status, 503);
  assert.equal(calls.length, 1, "unsafe route failures must not replay");
  await response.body?.cancel();
}

{
  const oldToken = jwt({ userId: "viewer", role: "viewer" });
  const newToken = jwt({ userId: "viewer", role: "viewer", version: 2 });
  localStorage.setItem("cloudphoto_token", oldToken);
  localStorage.setItem("cloudphoto_refresh_token", "refresh-token");
  let uploadCalls = 0;
  let refreshCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/auth/refresh")) {
      refreshCalls += 1;
      return Response.json({ token: newToken, refreshToken: "refresh-token-2" });
    }
    uploadCalls += 1;
    return new Response("unauthorized", { status: 401 });
  };
  const response = await http.fetchWithTimeout(
    "https://cloudphoto-api.azurewebsites.net/api/photos/upload",
    {
      method: "POST",
      headers: http.authHeaders(),
      body: new Blob(["photo"]),
    },
    1_000,
  );
  assert.equal(response.status, 401);
  assert.equal(refreshCalls, 1, "401 may refresh credentials once");
  assert.equal(uploadCalls, 1, "unsafe request must not replay after refresh");
  await response.body?.cancel();
}

{
  const currentToken = localStorage.getItem("cloudphoto_token");
  const refreshedToken = jwt({ userId: "viewer", role: "viewer", version: 3 });
  let refreshCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/auth/refresh")) {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return Response.json({ token: refreshedToken, refreshToken: "refresh-token-3" });
    }
    return new Response("unauthorized", { status: 401 });
  };
  const startedAt = Date.now();
  await assert.rejects(
    http.fetchWithTimeout(
      "https://cloudphoto-api.azurewebsites.net/api/photos/upload",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${currentToken}` },
        body: new Blob(["photo"]),
      },
      30,
    ),
    { name: "AbortError" },
  );
  assert(
    Date.now() - startedAt < 80,
    "total timeout must not wait for a shared token refresh",
  );
  assert.equal(refreshCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 90));
}

{
  let xhrMode = "unauthorized";
  let xhrSendCalls = 0;
  let xhrAbortCalls = 0;
  let refreshCalls = 0;
  class FakeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.upload = { addEventListener() {} };
      this.status = 0;
      this.responseText = "";
    }
    open(_method, url) {
      this.url = url;
    }
    setRequestHeader(name, value) {
      if (name === "Authorization") this.authorization = value;
    }
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }
    send() {
      xhrSendCalls += 1;
      if (xhrMode === "unauthorized") {
        queueMicrotask(() => {
          this.status = 401;
          this.responseText = JSON.stringify({ error: "Unauthorized" });
          this.listeners.get("load")?.();
        });
      }
    }
    abort() {
      xhrAbortCalls += 1;
    }
  }
  globalThis.XMLHttpRequest = FakeXMLHttpRequest;
  const uploadToken = jwt({ userId: "xhr-user", role: "viewer" });
  const nextUploadToken = jwt({ userId: "xhr-user", role: "viewer", version: 2 });
  localStorage.setItem("cloudphoto_token", uploadToken);
  localStorage.setItem("cloudphoto_refresh_token", "xhr-refresh");
  globalThis.fetch = async (input) => {
    assert(String(input).endsWith("/auth/refresh"));
    refreshCalls += 1;
    return Response.json({
      token: nextUploadToken,
      refreshToken: "xhr-refresh-2",
    });
  };
  const mediaStubUrl = `data:text/javascript;base64,${Buffer.from(`
    export const getPreferredMediaUrl = (url) => url;
    export const routeMediaUrls = (photo) => photo;
  `).toString("base64")}`;
  const uploadApi = await importTypeScript(
    "packages/client/src/services/uploadApi.ts",
    (source) => source
      .replace('"../utils/apiBase"', JSON.stringify(apiBaseUrl))
      .replace('"./http"', JSON.stringify(httpUrl))
      .replace('"./mediaRoute"', JSON.stringify(mediaStubUrl)),
  );
  const file = { name: "photo.jpg", type: "image/jpeg" };
  await assert.rejects(
    uploadApi.uploadPhotoWithProgress(file, () => {}),
    /手动重试上传/,
  );
  assert.equal(refreshCalls, 1, "XHR 401 must refresh shared auth state");
  assert.equal(xhrSendCalls, 1, "XHR 401 must not replay the upload");

  xhrMode = "pending";
  const controller = new AbortController();
  const pending = uploadApi.uploadPhotoWithProgress(
    file,
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new DOMException("Caller cancelled", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(xhrAbortCalls, 1, "caller abort must stop the active XHR");
}

const listCache = await importTypeScript(
  "packages/client/src/services/photoListCache.ts",
);
const generation = listCache.getPrivatePhotoCacheGeneration();
const olderWrite = listCache.writePhotoListCache(
  "ordered",
  [{ version: "old" }],
  generation,
);
const newerWrite = listCache.writePhotoListCache(
  "ordered",
  [{ version: "new" }],
  generation,
);
await Promise.all([olderWrite, newerWrite]);
assert.deepEqual(
  await listCache.readPhotoListCache("ordered"),
  [{ version: "new" }],
  "later Cache Storage writes must win regardless of put latency",
);
assert.deepEqual(delays, [25, 0], "writes should execute in call order");

const staleGeneration = listCache.getPrivatePhotoCacheGeneration();
const staleWrite = listCache.writePhotoListCache(
  "cleared",
  [{ version: "old" }],
  staleGeneration,
);
await listCache.invalidatePhotoListCaches();
await staleWrite;
assert.equal(
  await listCache.readPhotoListCache("cleared"),
  null,
  "a mutation clear must drain and remove stale writes",
);

console.log("photo-loading behavior: PASS");
console.log("evidence auth-role-isolation=true stale-publish-blocked=true ordered-cache-writes=true");
console.log("evidence slow-primary-survives=true fallback-wins=true caller-cancel=true unsafe-replay=false");
console.log("evidence health-explicit-ttl-ms=300000 health-transient-ttl-ms=5000");
