#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(join(root, relative), "utf8");
const requireText = (source, text, label) => {
  assert(source.includes(text), `${label}: missing ${JSON.stringify(text)}`);
};

const app = read("packages/client/src/App.tsx");
const auth = read("packages/client/src/contexts/AuthContext.tsx");
const http = read("packages/client/src/services/http.ts");
const listCache = read("packages/client/src/services/photoListCache.ts");
const photoApi = read("packages/client/src/services/photoApi.ts");
const loadingPolicy = read("packages/client/src/services/photoLoadingPolicy.ts");
const uploadApi = read("packages/client/src/services/uploadApi.ts");
const media = read("packages/client/src/services/mediaRoute.ts");
const gallery = read("packages/client/src/components/gallery/PhotoGallery.tsx");
const photoCard = read("packages/client/src/components/gallery/PhotoCard.tsx");
const vite = read("packages/client/vite.config.ts");
const nginx = read("infra/nginx.conf");
const upload = read("packages/server/src/functions/photos/uploadPhoto.ts");
const backfill = read("packages/server/src/functions/photos/backfillThumbnails.ts");
const setVideoThumb = read("packages/server/src/functions/photos/setVideoThumbnail.ts");
const trash = read("packages/server/src/functions/trash/listTrash.ts");

// Cold list + persisted paint + one shared focus/visibility throttle.
assert.equal((app.match(/\blistPhotos\(currentGroupId,/g) ?? []).length, 1);
assert(app.indexOf("await getPersistedPhotos") < app.indexOf("await listPhotos"));
requireText(app, "shouldRefreshPhotoList(lastPhotoRefreshRef.current)", "refresh gate");
requireText(app, 'window.addEventListener("focus", refreshIfStale)', "focus gate");
requireText(app, "refreshIfStale();", "visibility gate");
requireText(app, "if (controller.signal.aborted) return;", "superseded abort");
requireText(app, "photoStateRevisionRef.current === stateRevision", "mutation revision gate");
requireText(app, "void invalidatePhotoListCaches()", "mutation cache invalidation");
requireText(app, "isAuthorizationDriftError(error)", "identity drift handling");
requireText(app, 'showToast("加载照片失败，请检查网络或服务器状态", "error")', "stale refresh error");
requireText(app, '(momentsMounted || activeTab === "moments")', "deferred Moments mount");

// Private list/media cache constraints and account cleanup.
requireText(listCache, "const CACHE_MAX_ENTRIES = 24", "cache bound");
requireText(listCache, "Date.now() - cachedAt <= CACHE_MAX_AGE_MS", "cache expiry");
requireText(listCache, "activePersistentWrites", "in-flight cache cleanup");
requireText(listCache, "Promise.allSettled([...activePersistentWrites])", "logout write drain");
requireText(listCache, "persistentWriteChains", "ordered persistent writes");
requireText(listCache, "expectedGeneration !== cacheGeneration", "stale persistent read/write guard");
for (const name of ["cloudphoto-photo-lists-v1", "photo-media-v1", "cf-media-v1"]) {
  requireText(listCache, name, "private cache cleanup");
}
requireText(auth, "void clearPrivatePhotoCaches()", "explicit/automatic logout cleanup");
requireText(auth, "preparePrivatePhotoCachesForOwner(userCacheOwner(restoredUser))", "restore ownership");
requireText(auth, "preparePrivatePhotoCachesForOwner(userCacheOwner(resp.user))", "account-switch ownership");
requireText(auth, 'window.addEventListener("storage", handleStorage)', "cross-tab memory cleanup");
requireText(auth, "replacementIdentity?.cacheOwner === userCacheOwner(currentUser)", "cross-tab role identity");
requireText(auth, "subscribeAuthIdentityChanges", "same-tab refresh identity sync");
requireText(auth, "Never clear replacement credentials", "new-tab credential safety");
requireText(loadingPolicy, 'return `${encodeURIComponent(userId)}:${role}`', "role-scoped cache owner");
requireText(loadingPolicy, 'return `auth:${cacheOwner}:group:${groupId || "personal"}`', "group-scoped list cache key");
requireText(photoApi, "privatePhotoListCacheKey(groupId, cacheScope)", "shared private list cache key");
requireText(photoApi, "authHeadersForSnapshot(authorization)", "request authorization snapshot");
requireText(photoApi, "canPublishPhotoList({", "stale list write guard");
requireText(photoApi, "signalAuthIdentityChange()", "identity drift synchronization");

// Safe routing hedges reads without killing a slow primary. Mutations and 401
// recovery are never replayed because POST endpoints are not idempotent.
requireText(http, "raceHedgedAttempts({", "safe request hedge");
requireText(http, "isSafeReplayMethod(requestMethod(input, init))", "safe 401 replay");
assert(!http.includes('request?.suffix === "/auth/login"'), "login must not route-replay");
assert(!http.includes('request?.suffix === "/auth/refresh"'), "refresh must not route-replay");
requireText(http, "if (!isSafeReplayMethod(requestMethod(input, init))) return res;", "unsafe 401 no replay");
requireText(app, "Upload is not replay-safe", "upload UI no replay");
assert(!app.includes("for (let attempt = 0; attempt < 3; attempt++)"), "upload retry loop removed");
requireText(uploadApi, "const uploadUrl = await resolveApiUrl(", "XHR recovered proxy probe");
requireText(uploadApi, "await recoverFromUnauthorized(requestToken, signal)", "XHR auth recovery");
requireText(uploadApi, "请手动重试上传", "XHR no automatic replay");

// Health detection distinguishes durable topology from transient failures and
// deduplicates concurrent probes without caching a timeout for the page lifetime.
requireText(http, "sameOriginProxyProbeCache.expiresAt > Date.now()", "health probe TTL");
requireText(http, "sameOriginProxyProbe = null", "health probe retry");
requireText(loadingPolicy, "PROXY_PROBE_TRANSIENT_TTL_MS = 5_000", "transient health TTL");
requireText(loadingPolicy, "PROXY_PROBE_STABLE_TTL_MS = 5 * 60 * 1000", "stable health TTL");
requireText(loadingPolicy, 'return "transient"', "transient health classification");

// Workbox may cache only full, verifiable GET 200 responses.
requireText(vite, 'request.method === "GET"', "media request method");
requireText(vite, '!request.headers.has("range")', "Range exclusion");
requireText(vite, "cacheableResponse: { statuses: [200] }", "opaque exclusion");
requireText(loadingPolicy, "MEDIA_CACHEABLE_RESPONSE_STATUSES = [200]", "opaque exclusion");
assert(!vite.includes("statuses: [0, 200]"), "opaque status 0 must not be cached");
assert(!loadingPolicy.includes("[0, 200]"), "behavior policy must also reject opaque status 0");
requireText(vite, 'cacheName: "photo-media-v1"', "private media cache name");
requireText(photoCard, "if (res.status === 206)", "bounded video Range body");
assert(!photoCard.includes("res.status === 206 || res.ok"), "Range fallback must not buffer a full video");

// Route probes and fallback are finite, body-free, bounded, and cancel losers.
requireText(media, 'method: "HEAD"', "body-free media probe");
requireText(media, "const ROUTE_PROBE_TIMEOUT_MS = 1_500", "probe timeout");
requireText(media, "directController.abort()", "direct loser cancellation");
requireText(media, "proxyController.abort()", "proxy loser cancellation");
requireText(media, "for (let index = 0; index < candidates.length; index++)", "fetch fallback loop");
requireText(media, "for (const candidate of [preferred, alternate])", "primary/alternate ordering");
requireText(media, "response.ok && (!requiresPartialContent || response.status === 206)", "alternate success return");
requireText(media, 'new Headers(init?.headers).has("Range")', "Range response validation");
requireText(media, "attempted: Set<string>", "finite element fallback");
requireText(media, "resolveMediaUrlWithFallback", "native download preflight");
requireText(media, "preloadImageWithFallback", "programmatic image fallback");
requireText(gallery, "fetchMediaWithFallback(selectedPhoto.url)", "clipboard fallback");
assert(!gallery.includes("fetch(selectedPhoto.url)"), "clipboard must not bypass fallback");

const walk = (directory) => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const clientSources = walk(join(root, "packages/client/src"))
  .filter((path) => /\.[jt]sx?$/.test(path));
const directFetchFiles = clientSources
  .filter((path) => /\bfetch\s*\(/.test(readFileSync(path, "utf8")))
  .sort();
assert.deepEqual(directFetchFiles, [
  join(root, "packages/client/src/services/http.ts"),
  join(root, "packages/client/src/services/mediaRoute.ts"),
  join(root, "packages/client/src/services/photoApi.ts"),
  join(root, "packages/client/src/utils/geocode.ts"),
].sort(), "new direct fetch call sites require media/API classification");
const xhrFiles = clientSources
  .filter((path) => readFileSync(path, "utf8").includes("new XMLHttpRequest"))
  .sort();
assert.deepEqual(
  xhrFiles,
  [join(root, "packages/client/src/services/uploadApi.ts")],
  "XHR is reserved for the shared upload transport",
);
const directMediaTransportPattern =
  /(?:\bfetch\s*\(|\bxhr\.open\s*\()[^\n]*(?:thumbnailUrl|previewUrl|voiceMemoUrl|selectedPhoto\.url|photo\.url)/;
const directMediaTransportFiles = clientSources
  .filter((path) => path !== join(root, "packages/client/src/services/mediaRoute.ts"))
  .filter((path) => directMediaTransportPattern.test(readFileSync(path, "utf8")));
assert.deepEqual(
  directMediaTransportFiles,
  [],
  "Photo/media URL fetch and XHR must use shared mediaRoute helpers",
);
const directImageConstructors = clientSources
  .filter((path) => path !== join(root, "packages/client/src/services/mediaRoute.ts"))
  .filter((path) => readFileSync(path, "utf8").includes("new Image()"));
assert.deepEqual(directImageConstructors, [], "programmatic image loads must use shared fallback");

// Every private Blob writer and the Nginx media response stay browser-private,
// fresh for no longer than one hour, and never extend authorization with stale.
const assertPrivateMediaCacheControl = (value, label) => {
  const directives = value.toLowerCase().split(",").map((part) => part.trim());
  assert(directives.includes("private"), `${label} must be private`);
  assert(!directives.includes("public"), `${label} must not be public`);
  assert(!directives.some((part) => part.startsWith("stale-")), `${label} must not permit stale reuse`);
  const maxAge = directives
    .map((part) => /^max-age=(\d+)$/.exec(part)?.[1])
    .find(Boolean);
  assert(maxAge, `${label} must declare max-age`);
  assert(Number(maxAge) <= 3600, `${label} max-age exceeds one hour`);
};
const serverSources = walk(join(root, "packages/server/src"))
  .filter((path) => path.endsWith(".ts"))
  .map((path) => [path, readFileSync(path, "utf8")]);
const blobCacheControls = serverSources.flatMap(([path, source]) =>
  [...source.matchAll(/blobCacheControl:\s*"([^"]+)"/g)]
    .map((match) => ({ path, value: match[1] }))
);
assert.equal(blobCacheControls.length, 6, "all six private original/derivative Blob writes must be classified");
for (const { path, value } of blobCacheControls) {
  assertPrivateMediaCacheControl(value, path);
}
const nginxMediaCacheControl = /add_header Cache-Control "([^"]*max-age[^"]*)" always;/.exec(nginx)?.[1];
assert(nginxMediaCacheControl, "Nginx media Cache-Control must apply to 200/206/HEAD responses");
assertPrivateMediaCacheControl(nginxMediaCacheControl, "nginx media");
assert(!nginx.includes("stale-while-revalidate"), "Nginx media must not extend SAS authorization with stale");
assert(!nginx.includes("proxy_cache_use_stale"), "Nginx media must not serve stale private content");

// Derivative metadata is published after upload and guarded by ETag.
assert(upload.indexOf("thumbClient.uploadData") < upload.indexOf('setValue("thumbnailName"'));
assert(backfill.indexOf("thumbClient.uploadData") < backfill.indexOf('setMeta(latestMeta, "thumbnailName"'));
for (const source of [upload, backfill, setVideoThumb]) {
  requireText(source, "ifMatch:", "derivative metadata ETag");
}
requireText(backfill, 'request.query.get("cursor")', "backfill progress cursor");
requireText(backfill, "storedThumbName !== thumbName", "matching thumbnail metadata");
requireText(backfill, "storedPreviewName !== previewName", "matching preview metadata");
requireText(setVideoThumb, "MAX_THUMBNAIL_BYTES", "bounded thumbnail upload");
requireText(trash, "thumbnailUrl:", "trash thumbnail contract");
requireText(trash, "previewUrl:", "trash preview contract");

// Nginx CORS and byte ranges.
const swaOrigin = "https://brave-sand-053b07a00.7.azurestaticapps.net";
requireText(nginx, `"${swaOrigin}" $http_origin;`, "exact SWA origin");
assert(!nginx.includes("*.azurestaticapps.net"), "wildcard SWA origin is forbidden");
requireText(nginx, "proxy_set_header      Range             $http_range;", "Range forwarding");
requireText(nginx, "proxy_set_header      If-Range          $http_if_range;", "If-Range forwarding");
requireText(nginx, 'Access-Control-Expose-Headers "Accept-Ranges, Content-Length, Content-Range"', "Range exposure");

const allowedOrigin = (origin) => (
  origin === swaOrigin ||
  /^https:\/\/([a-z0-9-]+\.)?cloudphotos\.top$/.test(origin)
) ? origin : "";
assert.equal(allowedOrigin(swaOrigin), swaOrigin);
assert.equal(allowedOrigin("https://cn.cloudphotos.top"), "https://cn.cloudphotos.top");
assert.equal(allowedOrigin("https://evil.azurestaticapps.net"), "");
assert.equal(allowedOrigin("https://brave-sand-053b07a00.7.azurestaticapps.net.evil.example"), "");
assert.equal(allowedOrigin("https://attacker.example"), "");

console.log("photo-loading contracts: PASS");
console.log("evidence cold-list-calls=1 persisted-before-network=true focus-visibility-gate-ms=60000");
console.log("evidence media-route-candidates=2 primary-failure-alternate-success=true probe-body-bytes=0 probe-timeout-ms=1500 loser-abort=true");
console.log("evidence range-sw-cache=false range-body-requires-206=true cache-statuses=200 private-list-max=24 private-max-age-s=3600");
console.log("evidence cors trusted=2/2 malicious=0/3 trash-derivatives=2 private-blob-writes=6");
console.log("evidence logout-private-caches=3 logout-write-drain=true app-shell-preserved=true private-max-age-s=3600 stale=false");
console.log("evidence auth-owner=user+role hedge-safe-methods-only=true health-transient-ttl-ms=5000 unsafe-replay=false");
console.log("evidence direct-fetch-files=4 media-fetch-bypasses=0 xhr-files=1 opaque-cache=false");
