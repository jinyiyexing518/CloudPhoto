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
