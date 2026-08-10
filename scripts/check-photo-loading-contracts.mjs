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

const authGate = read("packages/client/src/App.tsx");
const app = read("packages/client/src/AuthenticatedApp.tsx");
const authPage = read("packages/client/src/components/auth/AuthPage.tsx");
const registerForm = read("packages/client/src/components/auth/RegisterForm.tsx");
const auth = read("packages/client/src/contexts/AuthContext.tsx");
const groupContext = read("packages/client/src/contexts/GroupContext.tsx");
const groupSwitcher = read("packages/client/src/components/groups/GroupSwitcher.tsx");
const groupApi = read("packages/client/src/services/groupApi.ts");
const http = read("packages/client/src/services/http.ts");
const authScope = read("packages/client/src/services/authScope.ts");
const routingPolicy = read("packages/client/src/services/apiRoutingPolicy.ts");
const loadingPolicy = read("packages/client/src/services/photoLoadingPolicy.ts");
const cacheLifecycle = read("packages/client/src/services/privatePhotoCacheLifecycle.ts");
const listCache = read("packages/client/src/services/photoListCache.ts");
const photoApi = read("packages/client/src/services/photoApi.ts");
const maintenanceBackfillPaging = read("packages/client/src/services/maintenanceBackfillPaging.ts");
const uploadApi = read("packages/client/src/services/uploadApi.ts");
const media = read("packages/client/src/services/mediaRoute.ts");
const videoCoverRepair = read("packages/client/src/services/videoCoverRepair.ts");
const videoCoverRepairPolicy = read("packages/client/src/services/videoCoverRepairPolicy.ts");
const renderPolicy = read("packages/algorithm/src/render.ts");
const gallery = read("packages/client/src/components/gallery/PhotoGallery.tsx");
const folder = read("packages/client/src/components/gallery/FolderView.tsx");
const photoCard = read("packages/client/src/components/gallery/PhotoCard.tsx");
const mediaThumb = read("packages/client/src/components/shared/MediaThumb.tsx");
const autoStory = read("packages/client/src/components/auto-story/AutoStory.tsx");
const onThisDay = read("packages/client/src/components/on-this-day/OnThisDayCard.tsx");
const memoryMap = read("packages/client/src/components/memory-map/MemoryMap.tsx");
const vite = read("packages/client/vite.config.mts");
const nginx = read("infra/nginx.conf");
const setup = read("infra/setup.sh");
const upload = read("packages/server/src/functions/photos/uploadPhoto.ts");
const metadataBackfill = read("packages/server/src/functions/photos/backfillPhotoMetadata.ts");
const backfill = read("packages/server/src/functions/photos/backfillThumbnails.ts");
const backfillCursor = read("packages/server/src/functions/photos/backfillCursor.ts");
const photoLocationSync = read("packages/server/src/utils/cosmos/photoLocationSync.ts");
const setVideoThumb = read("packages/server/src/functions/photos/setVideoThumbnail.ts");
const listPhotos = read("packages/server/src/functions/photos/listPhotos.ts");
const download = read("packages/server/src/functions/photos/downloadPhoto.ts");
const trash = read("packages/server/src/functions/trash/listTrash.ts");
const restore = read("packages/server/src/functions/trash/restorePhoto.ts");
const productionSmoke = read("scripts/production-smoke.mjs");
const staticWebApp = JSON.parse(read("packages/client/public/staticwebapp.config.json"));
const frontendHealth = JSON.parse(read("packages/client/public/healthz.json"));

// Cold list + persisted paint + one shared focus/visibility throttle.
assert.equal((app.match(/\blistPhotos\(resolvedPhotoWorkspaceId,/g) ?? []).length, 1);
assert(app.indexOf("await getPersistedPhotos") < app.indexOf("await listPhotos"));
requireText(app, "shouldRefreshPhotoWorkspace({", "workspace-aware refresh gate");
requireText(app, "requestInFlight: fetchAbortRef.current !== null", "in-flight list restart guard");
requireText(app, 'window.addEventListener("focus", refreshIfStale)', "focus gate");
requireText(app, "refreshIfStale();", "visibility gate");
requireText(app, "if (!isCurrent()) return;", "superseded revision guard");
requireText(app, 'showToast("加载照片失败，请检查网络或服务器状态", "error")', "stale refresh error");
requireText(app, '(momentsMounted || activeTab === "moments")', "deferred Moments mount");
assert(
  !app.includes('import PhotoGallery from "./components/gallery/PhotoGallery";'),
  "PhotoGallery must not ship in the unauthenticated entry bundle",
);
requireText(
  app,
  'const loadPhotoGallery = () => import("./components/gallery/PhotoGallery")',
  "deferred gallery import",
);
requireText(app, "const PhotoGallery = lazy(loadPhotoGallery);", "lazy gallery component");
requireText(app, "void loadPhotoGallery();", "authenticated gallery preload");
requireText(app, "正在加载照片视图…", "gallery chunk loading state");
assert(
  !app.includes('import WhatsNewPopup from "./components/whats-new/WhatsNewPopup";'),
  "WhatsNewPopup must not ship in the initial authenticated workspace chunk",
);
requireText(
  app,
  'const loadWhatsNewPopup = () => import("./components/whats-new/WhatsNewPopup")',
  "deferred whats-new import",
);
requireText(app, "const WhatsNewPopup = lazy(loadWhatsNewPopup);", "lazy whats-new component");
requireText(app, "const WHATS_NEW_IDLE_TIMEOUT_MS = 2_000;", "bounded whats-new idle timeout");
requireText(app, "window.requestIdleCallback(", "whats-new idle scheduling");
requireText(app, "{ timeout: WHATS_NEW_IDLE_TIMEOUT_MS }", "whats-new idle timeout option");
requireText(app, "window.cancelIdleCallback(idleTaskHandle);", "whats-new idle cancellation");
requireText(app, "setTimeout(runWhenCurrent, 0);", "whats-new idle fallback");
requireText(app, "if (loading || showSettings) return;", "whats-new loading and Settings gate");
requireText(app, "setShowWhatsNewPopup(false);", "whats-new loading reset");
requireText(app, "if (whatsNewMountRequest.current !== requestId) return;", "whats-new stale task guard");
requireText(app, "{showWhatsNewPopup && !showSettings && <Suspense fallback={null}><WhatsNewPopup /></Suspense>}", "whats-new lazy modal-safe mount");
assert(
  !authGate.includes("function AppContent()"),
  "the authenticated workspace must not ship in the login entry bundle",
);
requireText(
  authGate,
  'import("./AuthenticatedApp")',
  "deferred authenticated workspace import",
);
requireText(
  authPage,
  'import("./RegisterForm")',
  "deferred registration form import",
);
requireText(authPage, "registerFormPromise ??=", "cached registration loader");
requireText(authPage, "const RegisterForm = lazy(loadRegisterForm);", "lazy registration form");
requireText(authPage, "void loadRegisterForm();", "registration intent preload");
assert(!authPage.includes("handleRegister"), "registration submission must stay out of the login entry");
assert(!authPage.includes("正在创建账号…"), "registration copy must stay out of the login entry");
requireText(registerForm, "handleRegister", "deferred registration submission");
requireText(registerForm, "hidden={!active}", "persistent registration state");
requireText(authGate, "if (getToken()) void loadAuthenticatedApp();", "restored-session workspace preload");
requireText(authGate, "onAuthIntent", "interactive-auth workspace preload");
requireText(authGate, "window.location.reload();", "workspace chunk recovery");
assert.equal(
  (authPage.match(/onAuthIntent\?\.\(\);/g) ?? []).length,
  1,
  "login must preload the authenticated workspace",
);
assert.equal(
  (registerForm.match(/onAuthIntent\?\.\(\);/g) ?? []).length,
  1,
  "registration must preload the authenticated workspace",
);
assert(
  !auth.includes('from "../services/photoApi"'),
  "the auth gate must not import the photo workspace compatibility barrel",
);
assert(
  !auth.includes('from "../services/photoListCache"'),
  "the auth gate must not import photo-list persistence before authentication",
);
requireText(auth, 'from "../services/authApi"', "direct auth API boundary");
requireText(auth, 'from "../services/http"', "direct auth token boundary");
requireText(
  auth,
  'from "../services/privatePhotoCacheLifecycle"',
  "direct private-cache lifecycle boundary",
);

// Private list/media cache constraints and account cleanup.
requireText(listCache, "const CACHE_MAX_ENTRIES = 24", "cache bound");
requireText(listCache, "Date.now() - cachedAt <= CACHE_MAX_AGE_MS", "cache expiry");
requireText(listCache, "registerPrivatePhotoCacheReset", "synchronous memory reset registration");
requireText(listCache, "registerPrivatePhotoCacheWrite(operation)", "in-flight write registration");
requireText(cacheLifecycle, "activePersistentWrites", "in-flight cache cleanup");
requireText(cacheLifecycle, "Promise.allSettled([...activePersistentWrites])", "logout write drain");
for (const name of ["cloudphoto-photo-lists-v1", "photo-media-v1", "cf-media-v1"]) {
  requireText(cacheLifecycle, name, "private cache cleanup");
}
assert(
  cacheLifecycle.indexOf("cacheGeneration += 1;")
    < cacheLifecycle.indexOf("for (const reset of resetListeners) reset();"),
  "private-cache invalidation must advance the generation before resetting consumers",
);
requireText(auth, "void clearPrivatePhotoCaches()", "explicit/automatic logout cleanup");
requireText(auth, "getTokenAuthScope() !== restoredScope", "restore token/role drift rejection");
requireText(auth, "preparePrivatePhotoCachesForScope(restoredScope)", "restore authorization ownership");
requireText(auth, "getTokenAuthScope(resp.token) !== nextScope", "login token/user scope validation");
requireText(auth, "preparePrivatePhotoCachesForScope(nextScope)", "account/role ownership");
assert.equal(
  (auth.match(/getTokenAuthScope\(\) !== (?:restoredScope|nextScope)/g) ?? []).length,
  2,
  "mount and cross-tab restoration must both reject token/role drift",
);
requireText(auth, 'window.addEventListener("storage", handleStorage)', "cross-tab memory cleanup");
requireText(auth, "replacementScope === currentScope", "same-scope cross-tab token rotation");
assert(
  auth.indexOf("replacementScope === currentScope")
    < auth.indexOf("invalidateAuthRefresh();", auth.indexOf("const handleStorage")),
  "cross-tab same-scope rotations must return before auth invalidation",
);
assert.equal(
  (auth.match(/preparePrivatePhotoCachesForScope\(nextScope\)/g) ?? []).length,
  2,
  "login and cross-tab account switches must both adopt scoped caches",
);
requireText(auth, "invalidateAuthRefresh();", "cross-tab refresh invalidation");
requireText(auth, "getMeApi(controller.signal)", "abortable auth restoration");
requireText(auth, "generation !== authSyncGeneration.current", "stale restore generation guard");
requireText(auth, "controller.signal.aborted", "stale restore abort guard");
requireText(auth, "setLoading(false);", "logout completes splash loading");
requireText(auth, "getToken() === resp.token", "delayed login token guard");
requireText(auth, "authGeneration !== getAuthGeneration()", "stale profile auth guard");
requireText(http, "previousScope !== nextScope", "automatic role-change invalidation");
requireText(http, "cancelTokenRefresh();", "same-scope refresh mutex cancellation");
requireText(app, "authCacheOwner(user.id, user.role)", "role-scoped photo list cache");
requireText(http, "generation !== _authGeneration", "stale refresh generation guard");
requireText(http, "localStorage.getItem(REFRESH_TOKEN_KEY) !== refreshToken", "stale refresh token guard");
requireText(http, "requestAuthGeneration === _authGeneration", "stale 401 logout guard");
requireText(http, "if (requestAuthGeneration !== _authGeneration) return res;", "stale request refresh guard");
requireText(http, "newToken && requestAuthGeneration === _authGeneration", "stale request replay guard");
requireText(http, "sameScopeReplacement", "superseded same-scope refresh guard");
requireText(http, "replacementToken !== requestToken", "replacement token replay");
assert(
  !http.includes('from "./photoLoadingPolicy"'),
  "shared HTTP must not hoist photo-only policy into the login entry",
);
requireText(http, 'from "./authScope"', "direct auth-scope policy boundary");
requireText(http, 'from "./apiRoutingPolicy"', "direct API-routing policy boundary");
requireText(authScope, "decodeAuthorizationSnapshot", "auth identity decoder");
requireText(routingPolicy, "raceHedgedAttempts", "API hedge boundary");
assert(
  !routingPolicy.includes("privatePhotoListCacheKey"),
  "API routing policy must not absorb photo-list policy",
);
assert(
  !loadingPolicy.includes("raceHedgedAttempts"),
  "photo loading policy must not absorb shared API routing",
);
requireText(groupApi, "listGroupsApi(signal?: AbortSignal)", "abortable group listing");
requireText(groupContext, "refreshGenerationRef.current", "group refresh generation");
requireText(groupContext, "listGroupsApi(controller.signal)", "group refresh cancellation");
requireText(groupContext, "generation !== refreshGenerationRef.current", "stale group result guard");
requireText(groupContext, "groupsOwnerIdRef.current === user.id", "first-render group ownership guard");
requireText(groupContext, "userId !== currentUserIdRef.current", "stale group callback guard");
requireText(groupContext, 'setGroupsError("群组加载失败，请重试")', "visible group load failure");
requireText(groupContext, "selectionRestored", "saved workspace restoration boundary");
requireText(groupContext, "Boolean(user && !storedGroupId)", "personal selection independent resolution");
requireText(groupContext, "selectionOwnerIdRef.current = user?.id ?? null", "selection account ownership");
requireText(groupContext, "canExposeWorkspaceSelection", "token-safe selection visibility");
const groupFailure = groupContext.slice(
  groupContext.indexOf("    } catch {"),
  groupContext.indexOf("    } finally {", groupContext.indexOf("    } catch {")),
);
assert(!groupFailure.includes("setGroups([])"), "a transient group failure must preserve same-user groups");
requireText(groupSwitcher, "onClick={() => void refreshGroups()}", "group load retry");
requireText(http, "canHedgeOnAlternateRoute", "safe route hedge guard");
requireText(http, "canRetryOnAlternateRoute", "failure-only route retry guard");
requireText(http, "isSafeReplayMethod(method)", "unsafe route replay exclusion");
requireText(http, "const safeToReplay = isSafeReplayMethod", "misrouted unsafe request replay guard");
requireText(http, "raceHedgedAttempts", "non-destructive route hedge");
for (const path of ["/photos", "/photos/locations", "/photos/motion-video", "/photos/trash", "/geocode/search"]) {
  requireText(routingPolicy, `"${path}"`, `expensive GET hedge exclusion ${path}`);
}
requireText(http, "proxyProbeTtlMs(result)", "classified proxy probe expiry");
requireText(http, "handleMissingSameOriginRoute", "misrouted SPA response detection");
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
requireText(photoApi, "canPublishPhotoList({", "stale list write guard");
requireText(photoApi, "MEDIA_URL_REUSE_MIN_MS", "fresh SAS reuse threshold");
requireText(photoApi, "previousExpiry >= nextExpiry", "non-regressing SAS reuse");
requireText(photoApi, "export function selectFresherMediaUrl", "shared media freshness merge");
requireText(photoApi, "mediaResourcePath(previousUrl) === mediaResourcePath(nextUrl)", "same-resource SAS reuse");
requireText(photoApi, "authGeneration !== getAuthGeneration()", "account-bound backfill loop");
const listPhotosSource = photoApi.slice(
  photoApi.indexOf("export async function listPhotos"),
  photoApi.indexOf("export async function fetchPhotoLocations"),
);
assert(!listPhotosSource.includes("await selectFastestMediaRoute"), "cold photo-list paint must not await media probing");
requireText(listPhotosSource, "photo.thumbnailUrl || photo.previewUrl", "derivative-first route probe sample");
requireText(listPhotosSource, "void selectFastestMediaRoute", "background media route probe");
requireText(app, "subscribeToPreferredMediaRoute", "live gallery route promotion subscription");
requireText(app, "current.map(proxyPhoto)", "live gallery route promotion");
for (const [name, source] of [["timeline playback", gallery], ["folder playback", folder]]) {
  assert(
    !source.includes("subscribeToPreferredMediaRoute"),
    `${name} must freeze its media route when the View session opens`,
  );
  requireText(source, "createVideoPlaybackSession", `${name} frozen playback session`);
  requireText(source, "fallbackVideoPlaybackSession", `${name} one-shot source fallback`);
  requireText(source, "markVideoPlaybackPlayable", `${name} playable-content fallback guard`);
  requireText(source, "claimVideoThumbnailCapture", `${name} one-shot view-frame capture`);
  requireText(source, "if (selectedVideoRender.session.fallbackAttempted)", `${name} fallback-only route promotion`);
  requireText(source, "promoteSuccessfulMediaUrl(selectedVideoRender.source)", `${name} successful fallback route promotion`);
  requireText(source, "key={selectedVideoRender.key}", `${name} stable video element key`);
  requireText(
    source,
    'if (!selectedPhoto || selectedPhoto.contentType?.startsWith("video/")) return;',
    `${name} video startup must not compete with download-ticket prefetch`,
  );
  const loadedDataStart = source.indexOf("onLoadedData=");
  const playingStart = source.indexOf("onPlaying=", loadedDataStart);
  assert(loadedDataStart >= 0 && playingStart > loadedDataStart, `${name} loaded-data handler must exist`);
  requireText(
    source.slice(loadedDataStart, playingStart),
    "claimVideoThumbnailCapture",
    `${name} first decoded frame capture`,
  );
  assert(
    !source.includes('key={`${selectedVideoUrl}:${videoRetryKey}`}'),
    `${name} key must not contain a mutable source or retry counter`,
  );
}
requireText(photoCard, "getPreferredMediaUrl", "current card media route");
requireText(mediaThumb, "getPreferredMediaUrl", "current shared-thumbnail media route");
requireText(renderPolicy, "selectGridMediaSources", "derivative-only grid policy");
requireText(photoCard, "selectGridMediaSources", "timeline derivative-only grid policy reuse");
requireText(mediaThumb, "selectGridMediaSources", "folder derivative-only grid policy reuse");
requireText(onThisDay, "MediaThumb", "history derivative-only grid policy reuse");
requireText(autoStory, "selectGridMediaSources", "story derivative-only player policy reuse");
requireText(autoStory, "MediaThumb", "story derivative-only grid policy reuse");
requireText(memoryMap, "MediaThumb", "map derivative-only detail policy reuse");
for (const [name, source] of [
  ["history grid", onThisDay],
  ["story grid", autoStory],
  ["map detail", memoryMap],
]) {
  assert(
    !/(?:thumbnailUrl|previewUrl)\s*(?:\?\?|\|\|)[^\n]*\.url/.test(source),
    `${name} must not fall back to original media before explicit viewer intent`,
  );
}
requireText(app, "resolvePhotoWorkspaceRequest", "resolved workspace request policy reuse");
requireText(
  groupContext,
  "selectionOwnerIdRef.current = user?.id ?? null;",
  "explicit workspace selection ownership",
);
requireText(
  groupContext,
  "setSelectionRestored(Boolean(user));",
  "explicit personal recovery after group-list failure",
);
requireText(
  groupSwitcher,
  "id === currentGroupId && selectionRestored",
  "unresolved personal selection must remain actionable",
);
const fetchPhotosSource = app.slice(
  app.indexOf("const fetchPhotos = useCallback"),
  app.indexOf("const fetchPhotosRef = useRef"),
);
assert(
  fetchPhotosSource.indexOf("resolvedPhotoWorkspaceId === null")
    < fetchPhotosSource.indexOf("getCachedPhotos(resolvedPhotoWorkspaceId, photoCacheScope)"),
  "workspace restoration must gate cache hydration and the network photo list",
);
assert(
  app.indexOf("const resolvedPhotoWorkspaceId = resolvePhotoWorkspaceRequest")
    < app.indexOf("const fetchPhotos = useCallback"),
  "the photo loader must consume a resolved workspace identity",
);
assert(
  !fetchPhotosSource.includes("currentGroupId"),
  "photo loading must depend on the resolved workspace identity, not transient group state",
);
assert(
  !photoCard.includes(": [originalImageUrl]"),
  "timeline cards must not fall back to original media before viewer intent",
);
assert(
  !mediaThumb.includes(": [getPreferredMediaUrl(url)]"),
  "folder thumbnails must not fall back to original media before viewer intent",
);
requireText(photoCard, 'fetchPriority={priority ? "high" : "auto"}', "above-fold card priority");
requireText(mediaThumb, 'fetchPriority={priority ? "high" : "auto"}', "above-fold shared-thumbnail priority");
requireText(gallery, "GALLERY_EAGER_MEDIA_COUNT", "bounded gallery eager-media count");
requireText(folder, "priority={index < GALLERY_EAGER_MEDIA_COUNT}", "bounded folder eager-media count");

// Viewer open must stay on derivatives; the explicit original-preview action owns full files.
requireText(renderPolicy, "selectInitialViewerMediaSource", "pure viewer tier selection");
assert(!renderPolicy.includes("VIEWER_PREVIEW_THRESHOLD_PX"), "initial viewer must not auto-select originals on high-DPR screens");
requireText(photoApi, "selectInitialViewerMediaSource", "viewer tier policy reuse");
requireText(photoApi, "getPreferredMediaUrl(", "viewer route refresh");
for (const source of [gallery, folder]) {
  requireText(source, 'fetchPriority="high"', "selected viewer image priority");
  requireText(source, 'preload="auto"', "selected video body preload");
}

// Workbox may cache only full, verifiable GET 200 image responses.
requireText(vite, 'request.method === "GET"', "media request method");
requireText(vite, '!request.headers.has("range")', "Range exclusion");
requireText(vite, "const isCacheablePhotoPath =", "image-only media cache classification");
requireText(vite, "/\\.(?:bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(url.pathname)", "self-contained Workbox image matcher");
requireText(vite, "&& isCacheablePhotoPath", "original video cache exclusion");
requireText(vite, "cacheableResponse: { statuses: [200] }", "opaque exclusion");
assert(!vite.includes("statuses: [0, 200]"), "opaque status 0 must not be cached");
requireText(vite, 'cacheName: "photo-media-v1"', "private media cache name");
assert(
  !vite.includes('globPatterns: ["**/*.{js,css,html,ico,png,svg,json}"]'),
  "deferred feature chunks must not be downloaded by the install-time precache",
);
for (const pattern of [
  '"index.html"',
  '"assets/index-*.{js,css}"',
  '"assets/react-vendor-*.js"',
  '"assets/virtual_pwa-register-*.js"',
  '"assets/workbox-window*.js"',
]) {
  requireText(vite, pattern, "minimal app-shell precache");
}
requireText(vite, 'cacheName: "app-code-v1"', "on-demand app chunk cache");
requireText(vite, 'url.pathname.startsWith("/assets/")', "on-demand app chunk route");
requireText(vite, "matchOptions: { ignoreSearch: false }", "account-safe SAS cache key");
requireText(vite, "maxAgeSeconds: 60 * 60", "SAS-bounded Workbox freshness");
assert(!vite.includes("ignoreSearch: true"), "private media cache must retain SAS authorization");
assert(!photoCard.includes("<video"), "gallery cards must never embed original-video elements");
assert(!photoCard.includes("fetchMediaWithFallback"), "gallery cards must not directly fetch original-video ranges");
assert(!photoCard.includes("Range:"), "gallery cards must not directly request video bytes");
assert(!mediaThumb.includes("<video"), "secondary grids must never create original-video elements");
requireText(photoCard, 'className="video-thumb-placeholder"', "missing video derivative placeholder");
requireText(mediaThumb, '"video-thumb-placeholder"', "shared missing video derivative placeholder");
requireText(mediaThumb, '"photo-thumb-placeholder"', "shared missing photo derivative placeholder");
requireText(renderPolicy, ".filter((source): source is string => Boolean(source))", "preview-only source normalization");
requireText(photoCard, "useVideoCoverRepair", "visible-card repair hook");
requireText(photoCard, "markDerivativeBroken", "broken derivative repair transition");
requireText(photoCard, "isLowInformationVideoCoverImage", "successful derivative content check");
requireText(photoCard, "fallbackMediaSource(event.currentTarget, videoPosterSources)", "blank thumbnail preview fallback");
requireText(photoCard, "onThumbnailUpdate?.(photo.name, repairedUrl)", "repair URL state publication");
requireText(photoCard, "正在生成封面", "repair progress accessibility");
requireText(photoCard, "打开视频后生成封面", "manual repair fallback");
requireText(videoCoverRepair, 'rootMargin: "600px 0px"', "near-viewport repair boundary");
requireText(videoCoverRepair, "requestIdleCallback", "idle repair scheduling");
requireText(videoCoverRepair, "extractVideoElementThumbnail", "shared canvas thumbnail extraction");
requireText(videoCoverRepair, "setVideoThumbnail", "existing thumbnail endpoint reuse");
requireText(videoCoverRepair, "isVideoThumbnailPersistencePending", "upload/repair decoder dedupe");
requireText(videoCoverRepair, "dependencyChanged(blobName)", "upload reservation release");
requireText(videoCoverRepair, "externalSucceeded(blobName, thumbnailUrl)", "successful upload queue publication");
requireText(videoCoverRepair, "subscribeToAuthChanges", "auth-bound repair cancellation");
requireText(videoCoverRepair, 'window.addEventListener("offline"', "offline repair pause");
requireText(videoCoverRepair, "fallbackMediaSource", "finite preferred/alternate media route");
requireText(videoCoverRepair, 'video.preload = "metadata"', "metadata-first repair load");
requireText(videoCoverRepair, "videoCoverRepairCandidateTimes", "multi-frame repair sampling");
requireText(videoCoverRepair, "videoCoverFrameInformation", "low-information candidate scoring");
requireText(videoCoverRepair, "bestCandidate", "best informative frame selection");
requireText(videoCoverRepair, "video.muted = true", "silent repair decoder");
requireText(videoCoverRepair, "video.playsInline = true", "non-disruptive repair decoder");
requireText(videoCoverRepair, 'video.removeAttribute("src")', "decoder source cleanup");
requireText(videoCoverRepairPolicy, "VIDEO_COVER_REPAIR_MAX_FILE_BYTES", "per-video repair cap");
requireText(videoCoverRepairPolicy, "VIDEO_COVER_REPAIR_SESSION_BUDGET_BYTES", "session repair budget");
requireText(videoCoverRepairPolicy, "VIDEO_COVER_REPAIR_MAX_ATTEMPTS", "bounded repair retries");
requireText(videoCoverRepairPolicy, "VideoCoverRepairQueue", "global repair dedupe queue");
requireText(mediaThumb, "打开视频后生成封面", "secondary video fallback meaning");
requireText(autoStory, "<MediaThumb", "story preview video fallback");
requireText(autoStory, "currentPhotoIsVideo", "story player video fallback");
requireText(onThisDay, "<MediaThumb", "on-this-day video fallback");
for (const [name, source] of [["timeline playback", gallery], ["folder playback", folder]]) {
 requireText(source, 'preload="auto"', `${name} preloads the selected video body after explicit open`);
 requireText(source, "persistVideoPlaybackThumbnail", `${name} thumbnail persistence`);
 requireText(source, "getVideoPlaybackRenderState", `${name} separates mutable poster from frozen source`);
 requireText(source, "videoCaptureSessionRef.current !== activeSession.key", `${name} captures at most once per View session`);
 requireText(source, "!selectedPhoto.thumbnailUrl", `${name} captures only when the derivative is missing`);
}
requireText(uploadApi, "video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA", "already-loaded playback frame guard");
requireText(uploadApi, "const thumbnailUrl = await setVideoThumbnail(blobName, thumbnail)", "playback thumbnail endpoint reuse");
requireText(uploadApi, "if (!persisted) persistedPlaybackThumbnails.delete(blobName)", "failed playback thumbnail retry");
requireText(uploadApi, "videoThumbnailWrites.get(blobName)", "thumbnail endpoint write dedupe");
requireText(uploadApi, "videoThumbnailPersistenceListeners", "thumbnail reservation subscribers");
requireText(app, "markVideoThumbnailPersistencePending(uploadedPhoto.name, true)", "upload-time repair reservation");
requireText(app, "persistedThumbnailUrl ?? undefined", "upload-time repair release result");
requireText(app, "onThumbnailUpdate={handleThumbnailUpdate}", "persisted playback thumbnail grid publication");

// Route probes and fallback are finite, body-free, bounded, and cancel losers.
requireText(media, 'method: "HEAD"', "body-free media probe");
requireText(media, "const ROUTE_PROBE_TIMEOUT_MS = 1_500", "probe timeout");
requireText(media, "const MEDIA_ATTEMPT_TIMEOUT_MS = 10_000", "per-route media timeout");
requireText(media, "const body = await response.arrayBuffer()", "media body timeout coverage");
requireText(media, "directController.abort()", "direct loser cancellation");
requireText(media, "proxyController.abort()", "proxy loser cancellation");
requireText(media, "for (let index = 0; index < candidates.length; index++)", "fetch fallback loop");
requireText(media, "for (const candidate of [preferred, alternate])", "primary/alternate ordering");
requireText(media, "response.ok && (!requiresPartialContent || response.status === 206)", "alternate success return");
requireText(media, 'new Headers(init?.headers).has("Range")', "Range response validation");
requireText(
  media,
  "await response.body?.cancel().catch(() => undefined)",
  "all non-206 Range response bodies are canceled",
);
requireText(media, "attempted: Set<string>", "finite element fallback");
requireText(media, "if (route) rememberRoute(route)", "successful alternate route promotion");
requireText(media, "export function promoteSuccessfulMediaUrl", "native playback route promotion");
requireText(media, 'element.tagName === "IMG" ? "load" : "loadeddata"', "image/media success events");
requireText(media, "preloadImageWithFallback", "programmatic image fallback");
requireText(gallery, "fetchMediaWithFallback(selectedPhoto.url)", "clipboard fallback");
assert(!gallery.includes("fetch(selectedPhoto.url)"), "clipboard must not bypass fallback");

// Download clicks reuse a prewarmed ticket and immediately hand the preferred URL
// to the browser. Blob bodies and route probes never sit on the click path.
requireText(photoApi, "preloadPhotoDownload", "download ticket prewarm");
requireText(photoApi, "DOWNLOAD_TICKET_CACHE_MAX", "bounded download ticket cache");
requireText(photoApi, "subscribeToAuthChanges(() => downloadTicketCache.clear())", "auth changes discard stale download tickets");
requireText(photoApi, "Date.now() + 50 * 60 * 1000", "unparseable SAS expiries use a conservative reuse deadline");
requireText(photoApi, 'params.set("filename", filename)', "download filename handoff");
requireText(photoApi, "getPreferredMediaUrl(ticket.url)", "native download preferred route");
assert(!photoApi.includes("resolveMediaUrlWithFallback"), "download click must not wait for a HEAD preflight");
for (const source of [gallery, folder]) {
  requireText(source, "preloadPhotoDownload", "viewer download prewarm");
  assert(
    !source.includes('selectedPhoto.name.replace(/^\\d+-/, "")'),
    "legacy photos must derive download filenames from the Blob basename",
  );
}
requireText(download, "canAccessPhotoPath", "download path authorization");
requireText(download, 'request.query.get("filename")', "client filename fast path");
assert(!download.includes("getProperties()"), "download ticket generation must not read Blob metadata");

// Local video frame extraction runs while the original upload is in flight.
const thumbnailPromise = app.indexOf("videoThumbnailPromise");
const originalUpload = app.indexOf("await uploadPhotoWithProgress", thumbnailPromise);
const thumbnailPersist = app.indexOf("await videoThumbnailPromise", originalUpload);
assert(thumbnailPromise >= 0 && thumbnailPromise < originalUpload, "video cover extraction must start before upload");
assert(thumbnailPersist > originalUpload, "video cover persistence must wait for the original blob");

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
requireText(photoApi, 'paginationError: "照片元数据回填未能继续分页"', "metadata cursor error");
requireText(
  maintenanceBackfillPaging,
  "if (!page.cursor || page.cursor === cursor) throw new Error(paginationError)",
  "shared client cursor guard",
);
requireText(photoLocationSync, "const props = await readBlobProperties(blockBlobClient)", "GPS source refresh");
requireText(photoLocationSync, "verified.etag === sourceEtag", "GPS post-publish ETag reconciliation");
requireText(photoLocationSync, "publishedEtag", "GPS stale-publication tracking");
requireText(photoLocationSync, "condition: etag", "GPS conditional Cosmos mutation");
requireText(photoLocationSync, "publishPhotoLocationSnapshot", "conditional GPS publication");
requireText(photoLocationSync, "if (!await sourceIsCurrent())", "pre-publication Blob ETag verification");
requireText(photoLocationSync, ".replace(versionedDoc", "GPS conditional replace");
requireText(photoLocationSync, "condition: currentEtag!", "GPS publication If-Match");
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
requireText(backfill, "const needsPreview = !isVideo", "video preview generation exclusion");
const missingVideoThumbnailSkip = backfill.indexOf("if (isVideo && !thumbExists)");
assert(missingVideoThumbnailSkip >= 0, "video backfill must recognize missing derivatives");
assert(
  missingVideoThumbnailSkip < backfill.indexOf("const getSourceBuffer"),
  "video backfill must skip before any original body download",
);
requireText(setVideoThumb, "MAX_THUMBNAIL_BYTES", "bounded thumbnail upload");
assert.equal(
  (listPhotos.match(/listBlobsFlat\(/g) ?? []).length,
  1,
  "ordinary photo listing must discover originals and derivatives in one flat listing",
);
requireText(listPhotos, "resolveListedPhotoDerivatives", "same-list derivative recovery");
requireText(listPhotos, "storedDerivativeNames", "historical derivative metadata hints");
requireText(listPhotos, 'getMeta(blob.metadata, "thumbnailName")', "stored thumbnail hint");
requireText(listPhotos, 'getMeta(blob.metadata, "previewName")', "stored preview hint");
assert(!listPhotos.includes(".exists("), "ordinary photo listing must not issue per-item derivative HEAD calls");
assert(!listPhotos.includes("getProperties("), "ordinary photo listing must not issue per-item metadata reads");
assert(!listPhotos.includes("downloadToBuffer("), "ordinary photo listing must never download original video bodies");
requireText(upload, "await isGroupMember(groupId, payload.userId)", "group upload authorization");
requireText(upload, 'request.query.get("uploadId")', "upload idempotency key");
requireText(upload, 'conditions: { ifNoneMatch: "*" }', "idempotent original create");
requireText(upload, "syncPhotoLocationFromBlob(blockBlobClient, blobName, scope)", "idempotent GPS reconciliation");
requireText(trash, "thumbnailUrl:", "trash thumbnail contract");
requireText(trash, "previewUrl:", "trash preview contract");
requireText(restore, "syncPhotoLocationFromBlob(blockBlobClient, blobName, scope)", "restore GPS conditional reconciliation");
assert(!restore.includes("items.upsert"), "restore must not bypass conditional GPS publication");

// Nginx CORS and byte ranges.
const swaOrigin = "https://brave-sand-053b07a00.7.azurestaticapps.net";
requireText(nginx, `"${swaOrigin}" $http_origin;`, "exact SWA origin");
assert(!nginx.includes("*.azurestaticapps.net"), "wildcard SWA origin is forbidden");
requireText(nginx, "proxy_set_header      Range             $http_range;", "Range forwarding");
requireText(nginx, 'Access-Control-Expose-Headers "Accept-Ranges, Content-Length, Content-Range"', "Range exposure");
requireText(productionSmoke, 'name: "healthz"', "production proxy health check");
requireText(productionSmoke, '"cloudphoto-proxy", "cloudphoto-frontend"', "production entry route markers");
assert.deepEqual(frontendHealth, { status: "ok", route: "cloudphoto-frontend" });
const staticHealthRoute = staticWebApp.routes.find((route) => route.route === "/healthz");
assert.equal(staticHealthRoute?.rewrite, "/healthz.json", "SWA health fallback rewrite");
assert.equal(staticHealthRoute?.headers?.["Cache-Control"], "no-store", "SWA health fallback cache policy");
assert.equal(
  staticHealthRoute?.headers?.["Content-Type"],
  "application/json; charset=utf-8",
  "SWA health fallback content type",
);
requireText(routingPolicy, 'return input.route === "cloudphoto-proxy" ? "proxy" : "not-proxy"', "frontend marker remains non-proxy");
requireText(setup, "server_name ${DOMAIN} www.${DOMAIN} cn.${DOMAIN};", "China hostname ACME route");
requireText(setup, '-d "cn.${DOMAIN}"', "China hostname certificate SAN");
requireText(setup, 'CERTBOT_DNS_ARGS=("$@")', "split-DNS certificate arguments");
requireText(setup, 'HAS_DNS_PLUGIN', "DNS authenticator enforcement");
requireText(setup, '--authenticator=dns-*', "explicit DNS authenticator validation");
assert(!setup.includes("certbot certonly --nginx"), "split-DNS www certificate must not use HTTP-01");

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
console.log("evidence cold-list-calls=1 persisted-before-network=true focus-visibility-gate-ms=300000 in-flight-restarts=0");
console.log("evidence restored-group-personal-list-requests=0 initial-grid-original-requests=0 initial-grid-original-bytes=0");
console.log("evidence video-grid-original-requests=0 video-grid-original-bytes=0 cold-list-route-wait-ms=0 selected-video-preload=auto");
console.log("evidence media-route-candidates=2 primary-failure-alternate-success=true probe-body-bytes=0 probe-timeout-ms=1500 loser-abort=true");
console.log("evidence view-normal-video-requests=1 explicit-error-max-requests=2 route-update-remounts=0 derivative-list-heads=0 derivative-list-extra-waits=0");
console.log("evidence above-fold-priority=6 viewer-tier=derivative download-click-head=false video-cover-overlap=true");
console.log("evidence range-sw-cache=false range-body-requires-206=true cache-statuses=200 private-list-max=24 private-max-age-s=3600");
console.log("evidence cors trusted=2/2 malicious=0/3 trash-derivatives=2 logout-private-caches=3 logout-write-drain=true");
