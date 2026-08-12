import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypeScript(relativeUrl) {
  const source = await readFile(new URL(relativeUrl, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const policy = await importTypeScript("./videoCoverRepairPolicy.ts");
const hook = await readFile(new URL("./useResilientVideoPlayback.ts", import.meta.url), "utf8");
const gallery = await readFile(
  new URL("../components/gallery/PhotoGallery.tsx", import.meta.url),
  "utf8",
);
const folder = await readFile(
  new URL("../components/gallery/FolderView.tsx", import.meta.url),
  "utf8",
);
const photoCard = await readFile(
  new URL("../components/gallery/PhotoCard.tsx", import.meta.url),
  "utf8",
);
const mediaThumb = await readFile(
  new URL("../components/shared/MediaThumb.tsx", import.meta.url),
  "utf8",
);
const uploadApi = await readFile(new URL("./uploadApi.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");

test("known-broken cover facts are auth and workspace scoped", () => {
  assert.equal(typeof policy.VideoCoverBrokenRegistry, "function");
  const registry = new policy.VideoCoverBrokenRegistry();
  const personal = "personal/user-a/album/large.mp4";
  const group = "groups/group-a/album/large.mp4";
  registry.mark(7, personal);
  assert.equal(registry.has(7, personal), true);
  assert.equal(registry.has(8, personal), false, "another auth generation must not inherit the fact");
  assert.equal(registry.has(7, group), false, "another workspace blob must not inherit the fact");
  registry.clear(7, personal);
  assert.equal(registry.has(7, personal), false);
});

test("explicit playback captures missing or known-broken covers regardless of auto-repair size", () => {
  assert.equal(policy.needsPlaybackVideoCoverCapture(false, false), true);
  assert.equal(policy.needsPlaybackVideoCoverCapture(true, true), true);
  assert.equal(policy.needsPlaybackVideoCoverCapture(true, false), false);
  assert.equal(policy.canAutoRepairVideoCover({
    contentType: "video/mp4",
    hasDerivative: true,
    derivativeBroken: true,
    size: policy.VIDEO_COVER_REPAIR_MAX_FILE_BYTES + 1,
    sessionEstimatedBytes: 0,
  }), false, "a 93 MB video must stay outside passive repair");
  assert.equal(policy.canInspectPlaybackVideoCover({
    needsCapture: true,
    captureAttempted: false,
    canCapture: true,
    currentTime: 18,
  }), true, "already-decoded explicit playback is not subject to the passive size cap");
});

test("playback capture scores progressed frames before claiming or uploading", () => {
  const scorer = hook.indexOf("videoPlaybackCoverFrameInformation(video)");
  const lowInformationGuard = hook.indexOf("information.lowInformation", scorer);
  const claim = hook.indexOf("claimVideoThumbnailCapture(", lowInformationGuard);
  const persist = hook.indexOf("persistVideoPlaybackThumbnail(", claim);
  assert(scorer >= 0);
  assert(lowInformationGuard > scorer);
  assert(claim > lowInformationGuard, "a blank frame must not consume the session capture claim");
  assert(persist > claim, "a blank frame must never reach persistence");
  assert.match(hook, /canInspectPlaybackVideoCover\(\{[\s\S]{0,260}currentTime: video\.currentTime/);
  assert.doesNotMatch(
    hook,
    /onLoadedData:[\s\S]{0,900}videoPlaybackCoverFrameInformation/,
    "loadeddata frame zero must not be captured",
  );
  assert.match(hook, /onPlaying:[\s\S]{0,180}maybeCaptureThumbnail/);
  assert.match(hook, /onTimeUpdate:[\s\S]{0,180}maybeCaptureThumbnail/);
});

test("explicit repair reuses the viewer element and remains stale-session safe", () => {
  assert.doesNotMatch(hook, /document\.createElement\(["']video["']\)/);
  assert.match(hook, /const requestToken = requestTokenRef\.current/);
  assert.match(
    hook,
    /requestToken !== requestTokenRef\.current[\s\S]{0,180}active\.key !== key/,
  );
  assert.match(hook, /canCaptureVideoPlaybackThumbnail\(current\.source\)/);
  assert.match(uploadApi, /videoThumbnailResultListeners/);
  assert.match(uploadApi, /listener\(blobName, thumbnailUrl\)/);
  assert.match(app, /subscribeToVideoThumbnailResults\(handleThumbnailUpdate\)/);
});

test("published thumbnails cannot mutate another workspace or an absent photo", () => {
  assert.equal(
    policy.isPhotoBlobInWorkspace("personal/user-a/trips/large.mp4", ""),
    true,
  );
  assert.equal(
    policy.isPhotoBlobInWorkspace("groups/group-a/trips/large.mp4", "group-a"),
    true,
  );
  assert.equal(
    policy.isPhotoBlobInWorkspace("groups/group-b/trips/large.mp4", "group-a"),
    false,
  );
  assert.equal(
    policy.isPhotoBlobInWorkspace("personal/user-a/trips/large.mp4", "group-a"),
    false,
  );
  assert.equal(policy.isPhotoBlobInWorkspace("groups/group-a/a.mp4", null), false);

  const handlerStart = app.indexOf("const handleThumbnailUpdate");
  const handlerEnd = app.indexOf("useEffect(", handlerStart);
  const handler = app.slice(handlerStart, handlerEnd);
  assert.match(handler, /isPhotoBlobInWorkspace\(name, resolvedPhotoWorkspaceIdRef\.current\)/);
  assert.match(handler, /photosRef\.current\.some\(\(photo\) => photo\.name === name\)/);
  assert(
    handler.indexOf("isPhotoBlobInWorkspace") < handler.indexOf("mutatePhotos("),
    "workspace scope must be checked before mutation side effects",
  );
  assert(
    handler.indexOf("photosRef.current.some") < handler.indexOf("mutatePhotos("),
    "an absent photo must not abort or invalidate the active list request",
  );
});

test("both viewers include known-broken covers and publish one shared repair result", () => {
  for (const source of [gallery, folder]) {
    assert.match(
      source,
      /needsThumbnailCapture:\s*needsPlaybackVideoCoverCapture\([\s\S]{0,120}isVideoCoverKnownBroken\(photo\.name\)/,
    );
    assert.match(source, /onThumbnailCaptured:/);
    assert.match(source, /onThumbnailUpdate\?\.\(photoName, thumbnailUrl\)/);
  }
});

test("PhotoCard and MediaThumb register broken derivatives by blob identity", () => {
  assert.match(
    photoCard,
    /isLowInformationVideoCoverImage[\s\S]{0,180}markDerivativeBroken\(\);[\s\S]{0,80}advanceOrFail\(\);/,
    "content-confirmed low-information covers should be registered immediately",
  );
  assert.match(
    photoCard,
    /coverDeadlineSources =[\s\S]{0,200}retryVideoPosterSources/,
    "video poster fallbacks must use the shared per-source cover deadline",
  );
  assert.match(
    photoCard,
    /retryVideoPosterSources = videoPosterSources\.map\(\(source\) =>\s*withCoverRequestState\(source, imageRetryKey, true\)\)/,
    "video poster derivatives must use the cover-only deadline and retry request state",
  );
  assert.match(mediaThumb, /blobName\?: string/);
  assert.match(
    mediaThumb,
    /onError=\{\(event\) => \{\s*if \(!fallbackMediaSource\(event\.currentTarget, imageSources\)\) \{\s*if \(blobName\) markVideoCoverBroken\(blobName\);/,
  );
});
