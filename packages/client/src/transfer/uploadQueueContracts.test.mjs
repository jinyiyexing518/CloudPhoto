import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(
  new URL("../AuthenticatedApp.tsx", import.meta.url),
  "utf8",
);

test("upload queue keeps workspace, auth generation, and stable uploadId guards", () => {
  assert.match(appSource, /batch\.workspaceId !== currentGroupId[\s\S]*batch\.controller\.abort\(new UploadWorkspaceChangedError\(\)\)/);
  assert.match(appSource, /subscribeToAuthChanges[\s\S]*batchController\.abort\(new AuthSessionChangedError\(\)\)/);
  const uploadIds = appSource.indexOf("const uploadIds = new Map");
  const retryLoop = appSource.indexOf("for (let attempt = 0; attempt < 3");
  assert.ok(uploadIds >= 0 && retryLoop > uploadIds);
  assert.match(appSource, /uploadId,\s*controls\.markUploading,\s*\)/s);
});

test("pause gates dispatch without aborting active XHRs", () => {
  assert.match(appSource, /isPaused: \(\) => pausedRef\.current/);
  assert.match(appSource, /waitForResume,/);
  assert.doesNotMatch(appSource, /handleToggleUploadPause[\s\S]{0,500}\.abort\(/);
});

test("video cover work remains inside the weighted worker boundary", () => {
  const worker = appSource.indexOf("worker: async (queueItem, controls)");
  const thumbnail = appSource.indexOf("const thumbnail = await videoThumbnailPromise", worker);
  const workerEnd = appSource.indexOf("\n        },\n      });", worker);
  assert.ok(worker >= 0 && thumbnail > worker && workerEnd > thumbnail);
});

test("failed batches keep truthful final progress through refresh and report both outcomes", () => {
  assert.doesNotMatch(
    appSource,
    /setUploadProgress\(\{\s*bytesLoaded: bytesTotal,\s*bytesTotal,\s*filesDone: valid\.length/s,
  );
  assert.match(appSource, /const finalProgress = aggregateUploadProgress\(result\.items\)/);
  assert.match(appSource, /setUploadProgress\(\{\s*\.\.\.finalProgress,/s);
  assert.match(appSource, /if \(result\.succeeded\.length > 0\) \{\s*await fetchPhotos\(\)/s);
  assert.match(appSource, /成功 \$\{result\.succeeded\.length\}，失败 \$\{result\.failed\.length\}/);
  assert.match(appSource, /成功 \$\{uploadProgress\.succeededCount\} \/ 失败 \$\{uploadProgress\.failedCount\}/);
});

test("upload speed and percentage use named truthful helpers", () => {
  assert.match(appSource, /sampleUploadSpeed\(\s*speedRef\.current,\s*progress\.transferredBytes,\s*Date\.now\(\)/s);
  assert.match(appSource, /getUploadProgressPercent\(uploadProgress\)/);
  assert.doesNotMatch(appSource, /uploadProgress\.bytesLoaded \/ uploadProgress\.bytesTotal/);
});
