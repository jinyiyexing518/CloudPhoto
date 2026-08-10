import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const source = await readFile(
  join(root, "packages/client/src/services/videoCoverRepairPolicy.ts"),
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const policy = await import(
  `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
);

assert.deepEqual(
  policy.videoCoverRepairNetworkPolicy({ online: true, effectiveType: "4g", saveData: false }),
  { enabled: true, concurrency: 2, reason: null },
);
assert.deepEqual(
  policy.videoCoverRepairNetworkPolicy({ online: true }),
  { enabled: true, concurrency: 1, reason: null },
);
for (const network of [
  { online: false },
  { online: true, effectiveType: "2g", saveData: false },
  { online: true, effectiveType: "slow-2g", saveData: false },
  { online: true, effectiveType: "4g", saveData: true },
]) {
  assert.equal(policy.videoCoverRepairNetworkPolicy(network).enabled, false);
}

assert.equal(policy.canAutoRepairVideoCover({
  contentType: "video/mp4",
  hasDerivative: true,
  derivativeBroken: false,
  size: 1,
  sessionEstimatedBytes: 0,
}), false, "healthy videos must issue zero repair requests");
assert.equal(policy.canAutoRepairVideoCover({
  contentType: "image/jpeg",
  hasDerivative: false,
  derivativeBroken: false,
  size: 1,
  sessionEstimatedBytes: 0,
}), false);
assert.equal(policy.canAutoRepairVideoCover({
  contentType: "video/mp4",
  hasDerivative: false,
  derivativeBroken: false,
  size: policy.VIDEO_COVER_REPAIR_MAX_FILE_BYTES + 1,
  sessionEstimatedBytes: 0,
}), false);
assert.equal(policy.canAutoRepairVideoCover({
  contentType: "video/mp4",
  hasDerivative: false,
  derivativeBroken: false,
  size: 1,
  sessionEstimatedBytes: policy.VIDEO_COVER_REPAIR_SESSION_BUDGET_BYTES,
}), false);

const pixels = (values) => new Uint8ClampedArray(values.flatMap(
  ([red, green, blue]) => [red, green, blue, 255],
));
assert.equal(
  policy.videoCoverFrameInformation(pixels(Array(64).fill([255, 255, 255]))).lowInformation,
  true,
  "a 200/400px derivative can still be a blank white cover",
);
assert.equal(
  policy.videoCoverFrameInformation(pixels(Array(64).fill([224, 225, 223]))).lowInformation,
  true,
  "a nearly uniform light-gray derivative must be repairable",
);
assert.equal(
  policy.videoCoverFrameInformation(pixels(Array.from({ length: 64 }, (_, index) =>
    index % 2 === 0 ? [245, 245, 235] : [180, 210, 240]))).lowInformation,
  false,
  "bright textured scenes must not be mistaken for blank covers",
);
const candidateTimes = policy.videoCoverRepairCandidateTimes(10);
assert(candidateTimes.length >= 3);
assert(candidateTimes[0] > 0, "automatic repair must not be fixed to frame zero");
assert(candidateTimes[1] > candidateTimes[0]);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const request = (blobName, overrides = {}) => ({
  blobName,
  originalUrl: blobName,
  contentType: "video/mp4",
  size: 1_000,
  hasDerivative: false,
  derivativeBroken: false,
  ...overrides,
});

{
  const starts = [];
  const releases = [];
  const observed = [];
  const queue = new policy.VideoCoverRepairQueue({
    execute: (request, signal) => {
      starts.push(request.blobName);
      const pending = deferred();
      releases.push(() => pending.resolve(signal.aborted ? null : `thumb:${request.blobName}`));
      return pending.promise;
    },
    network: () => ({ online: true, effectiveType: "4g", saveData: false }),
    now: () => 1_000,
  });
  const first = queue.subscribe(request("clip.mp4"), (state) => observed.push(state));
  const second = queue.subscribe(request("clip.mp4"), (state) => observed.push(state));
  first.setVisible(true);
  second.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(starts, ["clip.mp4"], "duplicate instances must share one job");
  releases[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(
    observed.some((state) => state.phase === "succeeded" && state.thumbnailUrl === "thumb:clip.mp4"),
    "success must update every subscribed poster",
  );
  first.dispose();
  second.dispose();

  let refreshedState;
  const refreshed = queue.subscribe(
    request("clip.mp4", { hasDerivative: true }),
    (state) => { refreshedState = state; },
  );
  assert.equal(refreshedState.thumbnailUrl, null, "a refreshed derivative must replace the retained SAS");
  refreshed.dispose();
}

{
  const starts = [];
  const queue = new policy.VideoCoverRepairQueue({
    execute: async (request) => {
      starts.push(request.blobName);
      return `thumb:${request.blobName}`;
    },
    network: () => ({ online: true, effectiveType: "4g", saveData: true }),
    now: () => 1_000,
  });
  const handle = queue.subscribe(request("save-data.mp4"), () => {});
  handle.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(starts, [], "save-data mode must not download video bytes");
  handle.dispose();
}

{
  const starts = [];
  const releases = [];
  const queue = new policy.VideoCoverRepairQueue({
    execute: (item) => {
      starts.push(item.blobName);
      const pending = deferred();
      releases.push(() => pending.resolve(`thumb:${item.blobName}`));
      return pending.promise;
    },
    network: () => ({ online: true, effectiveType: "4g", saveData: false }),
  });
  const handles = ["a.mp4", "b.mp4", "c.mp4"].map((name) =>
    queue.subscribe(request(name), () => {}));
  handles.forEach((handle) => handle.setVisible(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts.length, 2, "fast networks must cap repair concurrency at two");
  releases[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts.length, 3);
  releases.slice(1).forEach((release) => release());
  handles.forEach((handle) => handle.dispose());
}

{
  const starts = [];
  const pending = deferred();
  const queue = new policy.VideoCoverRepairQueue({
    execute: (item) => {
      starts.push(item.blobName);
      return pending.promise;
    },
    network: () => ({ online: true }),
  });
  const handles = ["unknown-a.mp4", "unknown-b.mp4"].map((name) =>
    queue.subscribe(request(name), () => {}));
  handles.forEach((handle) => handle.setVisible(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(starts, ["unknown-a.mp4"], "unknown networks must cap concurrency at one");
  pending.resolve("thumb:unknown-a.mp4");
  await new Promise((resolve) => setTimeout(resolve, 0));
  handles.forEach((handle) => handle.dispose());
}

{
  let starts = 0;
  const queue = new policy.VideoCoverRepairQueue({
    execute: async () => {
      starts += 1;
      return "thumb";
    },
    network: () => ({ online: true, effectiveType: "4g" }),
  });
  const offscreen = queue.subscribe(request("offscreen.mp4"), () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts, 0, "offscreen cards must not start repair");
  offscreen.dispose();
}

{
  let uploadPending = true;
  let starts = 0;
  const queue = new policy.VideoCoverRepairQueue({
    execute: async () => {
      starts += 1;
      return "thumb";
    },
    network: () => ({ online: true, effectiveType: "4g" }),
    blocked: () => uploadPending,
  });
  const states = [];
  const handle = queue.subscribe(request("uploading.mp4", {
    size: policy.VIDEO_COVER_REPAIR_MAX_FILE_BYTES,
  }), (state) => states.push(state));
  handle.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts, 0);
  assert.equal(states.at(-1).attempts, 0, "upload reservations must not consume repair attempts");
  queue.externalSucceeded("uploading.mp4", "thumb:uploaded");
  uploadPending = false;
  queue.dependencyChanged("uploading.mp4");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts, 0, "a successful upload thumbnail must not restart original-video repair");
  assert.equal(states.at(-1).thumbnailUrl, "thumb:uploaded");
  handle.setVisible(false);
  handle.dispose();

  uploadPending = false;
  const budgetHandles = ["budget-a.mp4", "budget-b.mp4", "budget-c.mp4"].map((name) => {
    const budgetHandle = queue.subscribe(request(name, {
      size: policy.VIDEO_COVER_REPAIR_MAX_FILE_BYTES,
    }), () => {});
    budgetHandle.setVisible(true);
    return budgetHandle;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts, 3, "a deferred upload must consume none of the session repair budget");
  budgetHandles.forEach((budgetHandle) => budgetHandle.dispose());
}

{
  let now = 10_000;
  let starts = 0;
  const queue = new policy.VideoCoverRepairQueue({
    execute: async () => {
      starts += 1;
      return null;
    },
    network: () => ({ online: true, effectiveType: "4g" }),
    now: () => now,
  });
  const handle = queue.subscribe(request("retry.mp4"), () => {});
  handle.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  handle.setVisible(false);
  handle.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts, 1, "retry backoff must suppress immediate re-entry storms");
  now += policy.VIDEO_COVER_REPAIR_RETRY_BACKOFF_MS;
  handle.setVisible(false);
  handle.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts, 2);
  now += policy.VIDEO_COVER_REPAIR_RETRY_BACKOFF_MS;
  handle.setVisible(false);
  handle.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts, 2, "session retry count must be bounded");
  handle.dispose();
}

{
  let aborted = false;
  let online = true;
  const queue = new policy.VideoCoverRepairQueue({
    execute: (_item, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
    network: () => ({ online }),
  });
  const handle = queue.subscribe(request("cleanup.mp4"), () => {});
  handle.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  online = false;
  queue.networkChanged();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true, "offline transitions must abort the detached decoder");
  handle.dispose();
}

{
  let aborted = false;
  const queue = new policy.VideoCoverRepairQueue({
    execute: (_item, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
    network: () => ({ online: true }),
  });
  const handle = queue.subscribe(request("unmount.mp4"), () => {});
  handle.setVisible(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  handle.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true, "unmount must abort the detached decoder");
}

console.log("video-cover repair policy: PASS");
