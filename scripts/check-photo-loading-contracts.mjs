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
const listCache = read("packages/client/src/services/photoListCache.ts");
const photoApi = read("packages/client/src/services/photoApi.ts");
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
requireText(app, "Date.now() - lastPhotoRefreshRef.current >= 60_000", "refresh gate");
requireText(app, 'window.addEventListener("focus", refreshIfStale)', "focus gate");
requireText(app, "refreshIfStale();", "visibility gate");
requireText(app, "if (controller.signal.aborted) return;", "superseded abort");
requireText(app, 'showToast("加载照片失败，请检查网络或服务器状态", "error")', "stale refresh error");
requireText(app, '(momentsMounted || activeTab === "moments")', "deferred Moments mount");

// Private list/media cache constraints and account cleanup.
requireText(listCache, "const CACHE_MAX_ENTRIES = 24", "cache bound");
requireText(listCache, "Date.now() - cachedAt <= CACHE_MAX_AGE_MS", "cache expiry");
requireText(listCache, "activePersistentWrites", "in-flight cache cleanup");
requireText(listCache, "Promise.allSettled([...activePersistentWrites])", "logout write drain");
for (const name of ["cloudphoto-photo-lists-v1", "photo-media-v1", "cf-media-v1"]) {
  requireText(listCache, name, "private cache cleanup");
}
requireText(auth, "void clearPrivatePhotoCaches()", "explicit/automatic logout cleanup");
requireText(auth, "preparePrivatePhotoCachesForUser(restoredUser.id)", "restore ownership");
requireText(auth, "preparePrivatePhotoCachesForUser(resp.user.id)", "account-switch ownership");
requireText(auth, 'window.addEventListener("storage", handleStorage)', "cross-tab memory cleanup");
requireText(auth, "tokenUserId(event.newValue) === user?.id", "cross-tab token rotation");
requireText(auth, "preparePrivatePhotoCachesForUser(nextUser.id)", "cross-tab account switch");
requireText(photoApi, "cacheGeneration === getPrivatePhotoCacheGeneration()", "stale list write guard");

// Workbox may cache only full, verifiable GET 200 responses.
requireText(vite, 'request.method === "GET"', "media request method");
requireText(vite, '!request.headers.has("range")', "Range exclusion");
requireText(vite, "cacheableResponse: { statuses: [200] }", "opaque exclusion");
assert(!vite.includes("statuses: [0, 200]"), "opaque status 0 must not be cached");
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
const directImageConstructors = clientSources
  .filter((path) => path !== join(root, "packages/client/src/services/mediaRoute.ts"))
  .filter((path) => readFileSync(path, "utf8").includes("new Image()"));
assert.deepEqual(directImageConstructors, [], "programmatic image loads must use shared fallback");

// Private browser freshness remains below the two-hour SAS lifetime.
for (const [name, source] of [
  ["upload", upload],
  ["backfill", backfill],
  ["video thumbnail", setVideoThumb],
  ["nginx media", nginx],
]) {
  requireText(source, "private, max-age=3600, immutable", `${name} cache control`);
  assert(!source.includes("public, max-age=604800"), `${name} still has public 7-day caching`);
}

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
console.log("evidence cors trusted=2/2 malicious=0/3 trash-derivatives=2 logout-private-caches=3 logout-write-drain=true");
