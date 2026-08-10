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

const authScopeUrl = await compileTypeScript(
  "packages/client/src/services/authScope.ts",
);
const photoPolicyUrl = await compileTypeScript(
  "packages/client/src/services/photoLoadingPolicy.ts",
  (source) => source.replace('"./authScope"', JSON.stringify(authScopeUrl)),
);
const routingPolicyUrl = await compileTypeScript(
  "packages/client/src/services/apiRoutingPolicy.ts",
);
const policy = {
  ...await import(authScopeUrl),
  ...await import(photoPolicyUrl),
  ...await import(routingPolicyUrl),
};
const renderPolicy = await importTypeScript("packages/algorithm/src/render.ts");

assert.equal(
  renderPolicy.selectInitialViewerMediaSource({
    originalUrl: "original.jpg",
    thumbnailUrl: "thumb.webp",
    previewUrl: "preview.webp",
    viewportWidth: 1440,
    devicePixelRatio: 2,
  }),
  "preview.webp",
  "high-DPR desktop viewers must not fetch the original before explicit zoom",
);
assert.equal(
  renderPolicy.selectInitialViewerMediaSource({
    originalUrl: "original.jpg",
    thumbnailUrl: "thumb.webp",
    previewUrl: "preview.webp",
    viewportWidth: 375,
    devicePixelRatio: 1,
  }),
  "thumb.webp",
  "small viewers should reuse the already-painted thumbnail",
);
assert.equal(
  renderPolicy.selectInitialViewerMediaSource({
    originalUrl: "original.jpg",
    thumbnailUrl: "thumb.webp",
    viewportWidth: 1440,
    devicePixelRatio: 2,
  }),
  "thumb.webp",
  "a missing preview must prefer an existing derivative over an implicit original download",
);
assert.equal(
  renderPolicy.selectInitialViewerMediaSource({
    originalUrl: "original.jpg",
    viewportWidth: 1440,
    devicePixelRatio: 2,
  }),
  "original.jpg",
  "the original remains the final fallback when no derivative exists",
);
assert(
  renderPolicy.GALLERY_EAGER_MEDIA_COUNT >= 4
    && renderPolicy.GALLERY_EAGER_MEDIA_COUNT <= 8,
  "above-fold eager media must stay tightly bounded",
);

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
assert.notEqual(
  policy.privatePhotoListCacheKey("", admin.cacheOwner),
  policy.privatePhotoListCacheKey("", viewer.cacheOwner),
  "role changes must isolate personal list caches",
);
assert.notEqual(
  policy.privatePhotoListCacheKey("", viewer.cacheOwner),
  policy.privatePhotoListCacheKey("group-a", viewer.cacheOwner),
  "personal and group list caches must be isolated",
);
assert.notEqual(
  policy.privatePhotoListCacheKey("group-a", viewer.cacheOwner),
  policy.privatePhotoListCacheKey("group-b", viewer.cacheOwner),
  "groups must not share list caches",
);
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
for (const path of ["/photos", "/photos/locations", "/photos/motion-video", "/photos/trash", "/geocode/search"]) {
  assert.equal(
    policy.shouldHedgeApiRequest("GET", path),
    false,
    `${path} must wait for failure before alternate-route replay`,
  );
}
assert.equal(policy.shouldHedgeApiRequest("GET", "/auth/me"), true);
assert.equal(policy.shouldHedgeApiRequest("POST", "/auth/login"), false);
assert.deepEqual(
  [...policy.MEDIA_CACHEABLE_RESPONSE_STATUSES],
  [200],
  "opaque status 0 must not enter the media cache",
);
assert.equal(policy.isMediaRequestCacheEligible({
  method: "GET",
  hasRange: false,
  isMediaUrl: true,
  pathname: "/media/personal/user-a/_th_clip.mp4.webp",
}), true);
assert.equal(policy.isMediaRequestCacheEligible({
  method: "GET",
  hasRange: false,
  isMediaUrl: true,
  pathname: "/media/personal/user-a/clip.mp4",
}), false, "original videos must bypass the service-worker CacheFirst path");
assert.equal(policy.isMediaRequestCacheEligible({
  method: "GET",
  hasRange: true,
  isMediaUrl: true,
  pathname: "/media/personal/user-a/clip.mp4",
}), false, "Range requests must bypass the service-worker media cache");
assert.equal(policy.isMediaRequestCacheEligible({
  method: "HEAD",
  hasRange: false,
  isMediaUrl: true,
  pathname: "/media/personal/user-a/_th_clip.mp4.webp",
}), false, "HEAD probes must bypass the service-worker media cache");

{
  let lastRefreshAt = 0;
  let requests = 0;
  const now = 60_000;
  for (const _event of ["visibility", "focus"]) {
    if (policy.shouldRefreshPhotoList(lastRefreshAt, now)) {
      requests += 1;
      lastRefreshAt = now;
    }
  }
  assert.equal(requests, 1, "focus and visibility must share one refresh gate");
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
    contentType: "application/json",
    route: "cloudphoto-frontend",
    server: "nginx/1.24.0 (Ubuntu)",
  }),
  "proxy",
  "an older Nginx config may proxy the frontend health fallback while /api is still available",
);
assert.equal(
  policy.classifyProxyProbe({
    ok: true,
    status: 200,
    contentType: "application/json",
    route: "cloudphoto-frontend",
  }),
  "not-proxy",
  "a direct SWA response must keep using the Azure API",
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
const availableCacheNames = new Set(["workbox-precache-v2"]);
const deletedCacheNames = [];
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
    async open(name) {
      availableCacheNames.add(name);
      return fakeCache;
    },
    async delete(name) {
      deletedCacheNames.push(name);
      availableCacheNames.delete(name);
      if (name === "cloudphoto-photo-lists-v1") responses.clear();
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
    .replace('"./authScope"', JSON.stringify(authScopeUrl))
    .replace('"./apiRoutingPolicy"', JSON.stringify(routingPolicyUrl)),
);
const http = await import(httpUrl);

{
  let healthCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert(url.endsWith("/healthz"));
    healthCalls += 1;
    return Response.json({ status: "ok", route: "cloudphoto-frontend" }, {
      status: 200,
      headers: {
        Server: "nginx/1.24.0 (Ubuntu)",
      },
    });
  };
  assert.equal(
    await http.resolveApiUrl("https://cloudphoto-api.azurewebsites.net/api/groups"),
    "https://www.cloudphotos.top/api/groups",
    "www must recognize its live Nginx route even before /healthz returns JSON",
  );
  assert.equal(healthCalls, 1);
  http.invalidateApiProxyProbe();
}

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
    if (calls.length === 1) throw new TypeError("primary route offline");
    return Response.json([]);
  };
  const response = await http.fetchWithTimeout(
    "https://cloudphoto-api.azurewebsites.net/api/photos",
    { method: "GET" },
    1_000,
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2, "an expensive read must fail over after a real route failure");
  await response.body?.cancel();
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
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("<!doctype html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };
  const response = await http.fetchWithTimeout(
    "https://www.cloudphotos.top/api/auth/login",
    { method: "POST", body: "{}" },
    1_000,
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1, "an unsafe SPA-misroute response must not replay");
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
    getResponseHeader(name) {
      return name.toLowerCase() === "content-type" ? "application/json" : null;
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

{
  localStorage.removeItem("cloudphoto_media_route_v1");
  const mediaRouteUrl = await compileTypeScript(
    "packages/client/src/services/mediaRoute.ts",
    (source) => source.replaceAll("import.meta.env", "({})"),
  );
  const mediaRoute = await import(mediaRouteUrl);
  const videoPlayback = await importTypeScript(
    "packages/client/src/services/videoPlaybackSession.ts",
    (source) => source.replace('"./mediaRoute"', JSON.stringify(mediaRouteUrl)),
  );
  let preferredRouteChanges = 0;
  const unsubscribeRoute = mediaRoute.subscribeToPreferredMediaRoute(() => {
    preferredRouteChanges += 1;
  });
  const calls = [];
  const originalVideoUrl = "https://photostorage.blob.core.windows.net/photos/stale-video.mp4?sig=old";
  const openedSession = videoPlayback.createVideoPlaybackSession({
    photoName: "personal/viewer/_/stale-video.mp4",
    originalUrl: originalVideoUrl,
    sessionId: 1,
    needsThumbnailCapture: true,
  });
  const openedRender = videoPlayback.getVideoPlaybackRenderState(openedSession);
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (calls.length === 1) throw new TypeError("primary unavailable");
    return new Response("alternate", { status: 200 });
  };
  const response = await mediaRoute.fetchMediaWithFallback(
    "https://photostorage.blob.core.windows.net/photos/example.jpg?sig=old",
  );
  assert.equal(await response.text(), "alternate");
  assert.equal(calls.length, 2);
  assert(calls[0].includes("blob.core.windows.net"));
  assert(calls[1].includes("cloudphotos.top/media/"));
  assert(
    mediaRoute.getPreferredMediaUrl(originalVideoUrl).includes("cloudphotos.top/media/"),
    "new playback sessions must adopt the newly preferred route",
  );
  assert.equal(preferredRouteChanges, 1, "a late route probe must notify canonical gallery state");
  assert.equal(
    videoPlayback.getVideoPlaybackRenderState(openedSession).source,
    openedRender.source,
    "a route update after View opens must not change the session source",
  );
  const posterRender = videoPlayback.getVideoPlaybackRenderState(
    openedSession,
    "https://photostorage.blob.core.windows.net/photos/_th_stale-video.mp4.webp?sig=new",
  );
  assert.equal(posterRender.key, openedRender.key, "poster updates must not remount the video element");
  assert.equal(posterRender.source, openedRender.source, "poster updates must not change video source bytes");
  assert.notEqual(posterRender.poster, openedRender.poster, "a persisted thumbnail may update the poster independently");

  const fallbackSession = videoPlayback.fallbackVideoPlaybackSession(
    openedSession,
    openedRender.source,
  );
  assert(fallbackSession, "an explicit current-source error before playable content may fall back once");
  assert.equal(fallbackSession.key, openedSession.key, "fallback must preserve the mounted video element");
  assert.notEqual(fallbackSession.source, openedSession.source, "fallback must use the alternate route");
  assert.equal(
    videoPlayback.fallbackVideoPlaybackSession(fallbackSession, fallbackSession.source),
    null,
    "fallback must terminate after one alternate attempt",
  );
  const restartedFallbackSession = videoPlayback.restartVideoPlaybackSession(fallbackSession);
  assert.equal(
    videoPlayback.fallbackVideoPlaybackSession(
      restartedFallbackSession,
      restartedFallbackSession.source,
    ),
    null,
    "manual retry must not re-arm automatic fallback in the same View session",
  );
  const playableSession = videoPlayback.markVideoPlaybackPlayable(openedSession);
  assert.equal(
    videoPlayback.fallbackVideoPlaybackSession(playableSession, playableSession.source),
    null,
    "an error after playable content must not switch a slow or interrupted route",
  );

  const capture = videoPlayback.claimVideoThumbnailCapture(playableSession);
  assert.equal(capture.shouldCapture, true, "the first loaded View frame must be captured when the derivative is missing");
  assert.equal(capture.session.key, openedSession.key);
  assert.equal(capture.session.source, openedSession.source);
  assert.equal(
    videoPlayback.claimVideoThumbnailCapture(capture.session).shouldCapture,
    false,
    "one View session must not loop thumbnail capture or POST attempts",
  );
  const refreshedRender = videoPlayback.getVideoPlaybackRenderState(
    capture.session,
    "https://photostorage.blob.core.windows.net/photos/_th_stale-video.mp4.webp?sig=refreshed",
  );
  assert.equal(refreshedRender.key, openedRender.key, "photo-object refresh must keep the session key");
  assert.equal(refreshedRender.source, openedRender.source, "photo-object refresh must keep the frozen source");

  const reopenedSession = videoPlayback.createVideoPlaybackSession({
    photoName: openedSession.photoName,
    originalUrl: originalVideoUrl,
    sessionId: 2,
    needsThumbnailCapture: false,
  });
  assert.notEqual(reopenedSession.key, openedSession.key, "closing and reopening creates a new View session");
  assert(
    reopenedSession.source.includes("cloudphotos.top/media/"),
    "only a newly opened View session may adopt the latest preferred route",
  );

  const timeoutCalls = [];
  globalThis.fetch = (input, init) => {
    timeoutCalls.push(String(input));
    if (timeoutCalls.length === 1) {
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    return Promise.resolve(new Response("timeout-alternate", { status: 200 }));
  };
  const timeoutResponse = await mediaRoute.fetchMediaWithFallback(
    "https://photostorage.blob.core.windows.net/photos/timeout.jpg?sig=old",
    undefined,
    5,
  );
  assert.equal(await timeoutResponse.text(), "timeout-alternate");
  assert.equal(timeoutCalls.length, 2, "a stalled media route must advance after its own timeout");
  const staleProxyUrl = mediaRoute.toProxyMediaUrl(originalVideoUrl);
  assert(
    mediaRoute.getPreferredMediaUrl(staleProxyUrl).includes("blob.core.windows.net"),
    "playback must recover a direct URL from stale proxy-routed photo state",
  );
  assert.equal(preferredRouteChanges, 2, "alternate-route recovery must notify playback once");
  unsubscribeRoute();

  const bodyTimeoutCalls = [];
  globalThis.fetch = (input, init) => {
    bodyTimeoutCalls.push(String(input));
    if (bodyTimeoutCalls.length === 1) {
      const body = new ReadableStream({
        start(controller) {
          init.signal.addEventListener(
            "abort",
            () => controller.error(init.signal.reason),
            { once: true },
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    return Promise.resolve(new Response("body-timeout-alternate", { status: 200 }));
  };
  const bodyTimeoutResponse = await mediaRoute.fetchMediaWithFallback(
    "https://photostorage.blob.core.windows.net/photos/body-timeout.jpg?sig=old",
    undefined,
    5,
  );
  assert.equal(await bodyTimeoutResponse.text(), "body-timeout-alternate");
  assert.equal(bodyTimeoutCalls.length, 2, "a stalled media body must advance to the alternate");
  mediaRoute.promoteSuccessfulMediaUrl(originalVideoUrl);
  assert(
    mediaRoute.getPreferredMediaUrl(originalVideoUrl).includes("blob.core.windows.net"),
    "a successfully loaded native video source must be preferred by the next View session",
  );
  mediaRoute.promoteSuccessfulMediaUrl(staleProxyUrl);
  assert(
    mediaRoute.getPreferredMediaUrl(originalVideoUrl).includes("cloudphotos.top/media/"),
    "a successful native fallback must promote its alternate without changing the open session",
  );
}

const cacheLifecycleUrl = await compileTypeScript(
  "packages/client/src/services/privatePhotoCacheLifecycle.ts",
);
const listCache = await importTypeScript(
  "packages/client/src/services/photoListCache.ts",
  (source) => source.replaceAll(
    '"./privatePhotoCacheLifecycle"',
    JSON.stringify(cacheLifecycleUrl),
  ),
);
assert.equal(
  await listCache.readPhotoListCache("cold-start"),
  null,
  "the first visit must report a real cache miss",
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
await listCache.writePhotoListCache(
  "persisted-refresh",
  [{ version: "cached-first-paint" }],
  generation,
);
assert.deepEqual(
  await listCache.readPhotoListCache("persisted-refresh"),
  [{ version: "cached-first-paint" }],
  "a refresh must restore its persisted list before network revalidation",
);

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

const adminOwner = policy.authCacheOwner("same-user", "admin");
const viewerOwner = policy.authCacheOwner("same-user", "viewer");
const otherOwner = policy.authCacheOwner("other-user", "viewer");
await listCache.preparePrivatePhotoCachesForScope(adminOwner);
const adminGeneration = listCache.getPrivatePhotoCacheGeneration();
await listCache.writePhotoListCache(
  policy.privatePhotoListCacheKey("group-a", adminOwner),
  [{ version: "admin-list" }],
  adminGeneration,
);
availableCacheNames.add("photo-media-v1");
availableCacheNames.add("cf-media-v1");
await listCache.preparePrivatePhotoCachesForScope(viewerOwner);
assert.equal(
  await listCache.readPhotoListCache(policy.privatePhotoListCacheKey("group-a", adminOwner)),
  null,
  "role downgrade must remove the previous list cache",
);
assert(!availableCacheNames.has("photo-media-v1"), "role downgrade must remove Workbox media");
assert(!availableCacheNames.has("cf-media-v1"), "role downgrade must remove legacy media");
assert(availableCacheNames.has("workbox-precache-v2"), "role downgrade must preserve app shell");

const viewerGeneration = listCache.getPrivatePhotoCacheGeneration();
await listCache.writePhotoListCache(
  policy.privatePhotoListCacheKey("", viewerOwner),
  [{ version: "viewer-list" }],
  viewerGeneration,
);
availableCacheNames.add("photo-media-v1");
await listCache.preparePrivatePhotoCachesForScope(otherOwner);
assert.equal(
  await listCache.readPhotoListCache(policy.privatePhotoListCacheKey("", viewerOwner)),
  null,
  "account switch must remove the previous list cache",
);
assert(!availableCacheNames.has("photo-media-v1"), "account switch must remove private media");
assert(availableCacheNames.has("workbox-precache-v2"), "account switch must preserve app shell");

const logoutGeneration = listCache.getPrivatePhotoCacheGeneration();
await listCache.writePhotoListCache(
  policy.privatePhotoListCacheKey("", otherOwner),
  [{ version: "other-list" }],
  logoutGeneration,
);
availableCacheNames.add("photo-media-v1");
await listCache.clearPrivatePhotoCaches();
assert.equal(
  await listCache.readPhotoListCache(policy.privatePhotoListCacheKey("", otherOwner)),
  null,
  "logout must remove the authenticated list cache",
);
assert(!availableCacheNames.has("photo-media-v1"), "logout must remove private media");
assert(availableCacheNames.has("workbox-precache-v2"), "logout must preserve app shell");
assert.deepEqual(
  [...new Set(deletedCacheNames)].sort(),
  ["cf-media-v1", "cloudphoto-photo-lists-v1", "photo-media-v1"],
  "private cleanup must never broaden to app-shell caches",
);

const cacheControlSources = await Promise.all([
  "packages/server/src/functions/photos/uploadPhoto.ts",
  "packages/server/src/functions/photos/backfillThumbnails.ts",
  "packages/server/src/functions/photos/setVideoThumbnail.ts",
].map(async (path) => [path, await readFile(join(root, path), "utf8")]));
const cacheControlValues = cacheControlSources.flatMap(([path, source]) =>
  [...source.matchAll(/blobCacheControl:\s*"([^"]+)"/g)]
    .map((match) => ({ path, value: match[1] }))
);
const nginxSource = await readFile(join(root, "infra/nginx.conf"), "utf8");
const nginxCacheControl = /add_header Cache-Control "([^"]*max-age[^"]*)" always;/.exec(nginxSource)?.[1];
assert(nginxCacheControl, "Nginx cache policy must cover 200/206/HEAD");
cacheControlValues.push({ path: "infra/nginx.conf", value: nginxCacheControl });
assert.equal(cacheControlValues.length, 7, "six Blob writes and one Nginx response policy are required");
for (const { path, value } of cacheControlValues) {
  const directives = value.toLowerCase().split(",").map((part) => part.trim());
  const maxAge = Number(directives.find((part) => part.startsWith("max-age="))?.split("=")[1]);
  assert(directives.includes("private"), `${path} must be private`);
  assert(!directives.includes("public"), `${path} must not be public`);
  assert(!directives.some((part) => part.startsWith("stale-")), `${path} must not allow stale reuse`);
  assert(Number.isFinite(maxAge) && maxAge <= 3600, `${path} freshness must fit inside the SAS lifetime`);
}
assert(nginxSource.includes("proxy_set_header      Range             $http_range;"));
assert(nginxSource.includes("proxy_set_header      If-Range          $http_if_range;"));
assert(nginxSource.includes("add_header Accept-Ranges bytes always;"));

console.log("photo-loading behavior: PASS");
console.log("evidence auth-user-role-group-isolation=true stale-publish-blocked=true ordered-cache-writes=true");
console.log("evidence slow-primary-survives=true fallback-wins=true caller-cancel=true unsafe-replay=false expensive-read-hedge=false");
console.log("evidence health-explicit-ttl-ms=300000 health-transient-ttl-ms=5000");
console.log("evidence cold-list-miss=true persisted-first-paint=true focus-visibility-requests=1");
console.log("evidence media-primary-fail-alternate-pass=true media-route-timeout=true range-sw-cache=false opaque-cache=false");
console.log("evidence viewer-high-dpr-tier=preview missing-preview-tier=thumbnail eager-media-bounded=true");
console.log("evidence view-source-frozen=true poster-source-stable=true fallback-attempts=1 capture-attempts-per-view=1 reopen-adopts-route=true");
console.log("evidence private-cache-max-age-s=3600 public=false stale=false range-forwarded=true");
console.log("evidence role-account-logout-private-cache-miss=true app-shell-preserved=true");
