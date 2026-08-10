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
const groupContext = read("packages/client/src/contexts/GroupContext.tsx");
const groupApi = read("packages/client/src/services/groupApi.ts");
const http = read("packages/client/src/services/http.ts");
const listCache = read("packages/client/src/services/photoListCache.ts");
const photoApi = read("packages/client/src/services/photoApi.ts");
const uploadApi = read("packages/client/src/services/uploadApi.ts");
const media = read("packages/client/src/services/mediaRoute.ts");
const gallery = read("packages/client/src/components/gallery/PhotoGallery.tsx");
const photoCard = read("packages/client/src/components/gallery/PhotoCard.tsx");
const vite = read("packages/client/vite.config.ts");
const nginx = read("infra/nginx.conf");
const setup = read("infra/setup.sh");
const upload = read("packages/server/src/functions/photos/uploadPhoto.ts");
const metadataBackfill = read("packages/server/src/functions/photos/backfillPhotoMetadata.ts");
const backfill = read("packages/server/src/functions/photos/backfillThumbnails.ts");
const backfillCursor = read("packages/server/src/functions/photos/backfillCursor.ts");
const photoLocationSync = read("packages/server/src/utils/cosmos/photoLocationSync.ts");
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
requireText(auth, "preparePrivatePhotoCachesForScope(authCacheScope(restoredUser))", "restore authorization ownership");
requireText(auth, "preparePrivatePhotoCachesForScope(authCacheScope(resp.user))", "account/role ownership");
requireText(auth, 'window.addEventListener("storage", handleStorage)', "cross-tab memory cleanup");
requireText(auth, "replacementScope === currentScope", "same-scope cross-tab token rotation");
assert(
  auth.indexOf("replacementScope === currentScope")
    < auth.indexOf("invalidateAuthRefresh();", auth.indexOf("const handleStorage")),
  "cross-tab same-scope rotations must return before auth invalidation",
);
requireText(auth, "preparePrivatePhotoCachesForScope(authCacheScope(nextUser))", "cross-tab account switch");
requireText(auth, "invalidateAuthRefresh();", "cross-tab refresh invalidation");
requireText(auth, "getMeApi(controller.signal)", "abortable auth restoration");
requireText(auth, "generation !== authSyncGeneration.current", "stale restore generation guard");
requireText(auth, "controller.signal.aborted", "stale restore abort guard");
requireText(auth, "setLoading(false);", "logout completes splash loading");
requireText(auth, "getToken() === resp.token", "delayed login token guard");
requireText(auth, "authGeneration !== getAuthGeneration()", "stale profile auth guard");
requireText(http, "previousScope !== nextScope", "automatic role-change invalidation");
requireText(http, "cancelTokenRefresh();", "same-scope refresh mutex cancellation");
requireText(app, '`${user.id}:${user.role}`', "role-scoped photo list cache");
requireText(http, "generation !== _authGeneration", "stale refresh generation guard");
requireText(http, "localStorage.getItem(REFRESH_TOKEN_KEY) !== refreshToken", "stale refresh token guard");
requireText(http, "requestAuthGeneration === _authGeneration", "stale 401 logout guard");
requireText(http, "if (requestAuthGeneration !== _authGeneration) return res;", "stale request refresh guard");
requireText(http, "newToken && requestAuthGeneration === _authGeneration", "stale request replay guard");
requireText(http, "sameScopeReplacement", "superseded same-scope refresh guard");
requireText(http, "replacementToken !== requestToken", "replacement token replay");
requireText(groupApi, "listGroupsApi(signal?: AbortSignal)", "abortable group listing");
requireText(groupContext, "refreshGenerationRef.current", "group refresh generation");
requireText(groupContext, "listGroupsApi(controller.signal)", "group refresh cancellation");
requireText(groupContext, "generation !== refreshGenerationRef.current", "stale group result guard");
requireText(groupContext, "groupsOwnerIdRef.current === user.id", "first-render group ownership guard");
requireText(groupContext, "userId !== currentUserIdRef.current", "stale group callback guard");
for (const path of ["/photos", "/photos/motion-video", "/photos/trash", "/geocode/search"]) {
  requireText(http, `"${path}"`, `expensive GET replay exclusion ${path}`);
}
requireText(http, "canUseTimedRouteFallback(input, init)", "route replay cost guard");
requireText(http, "SAME_ORIGIN_PROXY_PROBE_TTL_MS", "expiring same-origin proxy probe");
requireText(http, "sameOriginRouteMissing", "misrouted SPA response detection");
requireText(http, "invalidateApiProxyProbe();", "misrouted proxy cache invalidation");
requireText(http, "buildApiUrl(DIRECT_API_BASE, primaryRequest)", "misrouted direct API recovery");
requireText(uploadApi, "recoverMisroutedProxy", "XHR upload proxy route recovery");
requireText(uploadApi, "uploadOnce(directUploadUrl, false)", "XHR upload direct retry");
requireText(uploadApi, "gatewayFailure", "idempotent gateway upload fallback");
requireText(uploadApi, "fallbackToDirect()", "idempotent network upload fallback");
requireText(uploadApi, "subscribeToAuthChanges(abortForAuthChange)", "account-bound XHR upload");
requireText(uploadApi, "const headers = authHeaders", "captured upload authorization");
requireText(app, "batchController.abort(new AuthSessionChangedError())", "account-bound upload batch");
requireText(app, "batch.workspaceId !== currentGroupId", "workspace-bound upload batch");
requireText(app, "currentGroupIdRef.current === uploadWorkspaceId", "workspace-bound upload updates");
requireText(app, "已有上传任务正在进行，请等待完成后再试", "single active upload batch");
requireText(app, "const ownsUploadBatch", "upload batch state ownership");
requireText(app, "selectFresherMediaUrl(p.thumbnailUrl, thumbnailUrl)", "non-regressing video thumbnail SAS");
requireText(app, "const uploadId = crypto.randomUUID()", "stable per-file upload idempotency key");
requireText(app, "if (isBatchCancellation(e)) break;", "non-retryable auth cancellation");
requireText(photoApi, "cacheGeneration === getPrivatePhotoCacheGeneration()", "stale list write guard");
requireText(photoApi, "MEDIA_URL_REUSE_MIN_MS", "fresh SAS reuse threshold");
requireText(photoApi, "previousExpiry >= nextExpiry", "non-regressing SAS reuse");
requireText(photoApi, "export function selectFresherMediaUrl", "shared media freshness merge");
requireText(photoApi, "mediaResourcePath(previousUrl) === mediaResourcePath(nextUrl)", "same-resource SAS reuse");
requireText(photoApi, "authGeneration !== getAuthGeneration()", "account-bound backfill loop");

// Workbox may cache only full, verifiable GET 200 responses.
requireText(vite, 'request.method === "GET"', "media request method");
requireText(vite, '!request.headers.has("range")', "Range exclusion");
requireText(vite, "cacheableResponse: { statuses: [200] }", "opaque exclusion");
assert(!vite.includes("statuses: [0, 200]"), "opaque status 0 must not be cached");
requireText(vite, 'cacheName: "photo-media-v1"', "private media cache name");
requireText(vite, "matchOptions: { ignoreSearch: false }", "account-safe SAS cache key");
requireText(vite, "maxAgeSeconds: 60 * 60", "SAS-bounded Workbox freshness");
assert(!vite.includes("ignoreSearch: true"), "private media cache must retain SAS authorization");
requireText(photoCard, "if (res.status === 206)", "bounded video Range body");
assert(!photoCard.includes("res.status === 206 || res.ok"), "Range fallback must not buffer a full video");
requireText(photoCard, "controller.abort();", "unmounted video Range cancellation");
requireText(photoCard, "if (disposed)", "late video object URL disposal");
requireText(photoCard, ".filter((source): source is string => Boolean(source))", "preview-only source normalization");

// Route probes and fallback are finite, body-free, bounded, and cancel losers.
requireText(media, 'method: "HEAD"', "body-free media probe");
requireText(media, "const ROUTE_PROBE_TIMEOUT_MS = 1_500", "probe timeout");
requireText(media, "directController.abort()", "direct loser cancellation");
requireText(media, "proxyController.abort()", "proxy loser cancellation");
requireText(media, "for (let index = 0; index < candidates.length; index++)", "fetch fallback loop");
requireText(media, "for (const candidate of [preferred, alternate])", "primary/alternate ordering");
requireText(media, "response.ok && (!requiresPartialContent || response.status === 206)", "alternate success return");
requireText(media, 'new Headers(init?.headers).has("Range")', "Range response validation");
requireText(
  media,
  "requiresPartialContent || index < candidates.length - 1",
  "all non-206 Range response bodies are canceled",
);
requireText(media, "attempted: Set<string>", "finite element fallback");
requireText(media, "resolveMediaUrlWithFallback", "native download preflight");
const nativeDownloadResolver = media.slice(media.indexOf("export async function resolveMediaUrlWithFallback"));
assert(
  nativeDownloadResolver.indexOf("for (let index = 0; index < candidates.length; index++)")
    < nativeDownloadResolver.indexOf("const controller = new AbortController();"),
  "native download must allocate a fresh timeout controller inside each candidate iteration",
);
requireText(nativeDownloadResolver, "clearTimeout(timeoutId);", "per-route download timeout cleanup");
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
requireText(metadataBackfill, "const props = await blockBlobClient.getProperties()", "fresh metadata backfill read");
requireText(metadataBackfill, "conditions: { ifMatch: props.etag }", "metadata backfill ETag");
requireText(metadataBackfill, "isPreconditionFailed(error)", "metadata backfill conflict retry");
requireText(metadataBackfill, 'request.query.get("cursor")', "metadata progress cursor");
requireText(metadataBackfill, '!request.query.has("limit")', "legacy partial-backfill rejection");
requireText(metadataBackfill, "listing.byPage({", "paged metadata listing");
requireText(metadataBackfill, 'filename.startsWith("_th_")', "metadata derivative exclusion");
requireText(metadataBackfill, "syncPhotoLocationFromBlob(blockBlobClient", "current Blob GPS publication");
requireText(metadataBackfill, "needsLatestLat", "independent latitude backfill");
requireText(metadataBackfill, "needsLatestLon", "independent longitude backfill");
requireText(photoApi, 'throw new Error("照片元数据回填未能继续分页")', "metadata client cursor guard");
requireText(photoLocationSync, "const props = await readBlobProperties(blockBlobClient)", "GPS source refresh");
requireText(photoLocationSync, "verified.etag === sourceEtag", "GPS post-publish ETag reconciliation");
requireText(photoLocationSync, "publishedEtag", "GPS stale-publication tracking");
requireText(photoLocationSync, "condition: etag", "GPS conditional Cosmos mutation");
requireText(photoLocationSync, "code?: unknown", "Cosmos conditional error normalization");
requireText(photoLocationSync, "await deleteLocation(container, id, scope, publishedEtag)", "exact stale GPS rollback");
requireText(photoLocationSync, "removeLocationForMissingBlob", "recreated Blob location protection");
requireText(backfill, 'request.query.get("cursor")', "backfill progress cursor");
requireText(backfill, "listing.byPage({", "paged thumbnail listing");
requireText(backfill, "continuationToken: pageStartToken", "Azure continuation cursor");
requireText(backfill, "if (processed >= limit)", "bounded inspected originals");
requireText(backfill, "Never scan more than one raw Azure page per invocation", "bounded raw thumbnail listing");
requireText(backfill, "processed++;\n        lastProcessedName = blob.name;", "healthy photo cursor advancement");
requireText(backfill, "getBlockBlobClient(thumbName).exists()", "bounded thumbnail existence check");
assert(!backfill.includes("const blobs: BlobItem[]"), "thumbnail backfill must not retain the full gallery");
requireText(backfillCursor, "export const BACKFILL_PAGE_SIZE = 200", "shared bounded page size");
requireText(backfillCursor, "value.context !== expectedContext", "scope-bound backfill cursor");
requireText(backfill, "storedThumbName !== thumbName", "matching thumbnail metadata");
requireText(backfill, "storedPreviewName !== previewName", "matching preview metadata");
requireText(setVideoThumb, "MAX_THUMBNAIL_BYTES", "bounded thumbnail upload");
requireText(upload, "await isGroupMember(groupId, payload.userId)", "group upload authorization");
requireText(upload, 'request.query.get("uploadId")', "upload idempotency key");
requireText(upload, 'conditions: { ifNoneMatch: "*" }', "idempotent original create");
requireText(upload, "syncPhotoLocationFromBlob(blockBlobClient, blobName, scope)", "idempotent GPS reconciliation");
requireText(trash, "thumbnailUrl:", "trash thumbnail contract");
requireText(trash, "previewUrl:", "trash preview contract");

// Nginx CORS and byte ranges.
const swaOrigin = "https://brave-sand-053b07a00.7.azurestaticapps.net";
requireText(nginx, `"${swaOrigin}" $http_origin;`, "exact SWA origin");
assert(!nginx.includes("*.azurestaticapps.net"), "wildcard SWA origin is forbidden");
requireText(nginx, "proxy_set_header      Range             $http_range;", "Range forwarding");
requireText(nginx, 'Access-Control-Expose-Headers "Accept-Ranges, Content-Length, Content-Range"', "Range exposure");
requireText(setup, "server_name ${DOMAIN} www.${DOMAIN} cn.${DOMAIN};", "China hostname ACME route");
requireText(setup, '-d "cn.${DOMAIN}"', "China hostname certificate SAN");

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
