import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateUploadProgress,
  formatUploadResultSummary,
  getUploadConcurrencyPolicy,
  getUploadItemWeight,
  getUploadProgressPercent,
  runWeightedUploadQueue,
  sampleUploadSpeed,
} from "./uploadQueue.ts";

const file = (name, size, type = "image/jpeg") => ({ name, size, type });

test("network policy keeps small images concurrent while bounding heavy uploads", () => {
  assert.deepEqual(
    getUploadConcurrencyPolicy({ effectiveType: "4g", saveData: false }),
    { budget: 3 },
  );
  assert.deepEqual(
    getUploadConcurrencyPolicy({ effectiveType: "3g", saveData: false }),
    { budget: 2 },
  );
  assert.deepEqual(
    getUploadConcurrencyPolicy(undefined),
    { budget: 2 },
  );
  assert.deepEqual(
    getUploadConcurrencyPolicy({ effectiveType: "2g", saveData: false }),
    { budget: 1 },
  );
  assert.deepEqual(
    getUploadConcurrencyPolicy({ effectiveType: "4g", saveData: true }),
    { budget: 1 },
  );
  assert.equal(getUploadItemWeight(file("photo.jpg", 10)), 1);
  assert.equal(getUploadItemWeight(file("clip.mp4", 10, "video/mp4")), 2);
  assert.equal(getUploadItemWeight(file("large.jpg", 21 * 1024 * 1024)), 2);
});

test("weighted runner reaches three-image throughput and never exceeds the budget", async () => {
  let activeWeight = 0;
  let maxActiveWeight = 0;
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const items = [
    file("a.jpg", 10),
    file("b.jpg", 10),
    file("c.jpg", 10),
    file("d.jpg", 10),
  ];
  const started = [];
  const run = runWeightedUploadQueue({
    files: items,
    policy: { budget: 3 },
    worker: async (queueItem, controls) => {
      started.push(queueItem.file.name);
      activeWeight += queueItem.weight;
      maxActiveWeight = Math.max(maxActiveWeight, activeWeight);
      controls.markUploading();
      await blocker;
      activeWeight -= queueItem.weight;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(started, ["a.jpg", "b.jpg", "c.jpg"]);
  assert.equal(maxActiveWeight, 3);
  release();
  const result = await run;
  assert.equal(result.failed.length, 0);
  assert.equal(result.items.every((item) => item.status === "succeeded"), true);
});

test("a weight-two video shares a fast budget only with one image", async () => {
  let activeWeight = 0;
  let maxActiveWeight = 0;
  let maxActiveCount = 0;
  let activeCount = 0;
  await runWeightedUploadQueue({
    files: [
      file("clip.mp4", 100, "video/mp4"),
      file("a.jpg", 10),
      file("b.jpg", 10),
    ],
    policy: { budget: 3 },
    worker: async (queueItem, controls) => {
      controls.markUploading();
      activeWeight += queueItem.weight;
      activeCount += 1;
      maxActiveWeight = Math.max(maxActiveWeight, activeWeight);
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeWeight -= queueItem.weight;
      activeCount -= 1;
    },
  });
  assert.equal(maxActiveWeight, 3);
  assert.equal(maxActiveCount, 2);
});

test("pause blocks only new starts and lets active uploads finish", async () => {
  let paused = false;
  let resume;
  let releaseFirst;
  const firstBlocker = new Promise((resolve) => { releaseFirst = resolve; });
  const resumePromise = new Promise((resolve) => { resume = resolve; });
  const started = [];
  const run = runWeightedUploadQueue({
    files: [file("a.jpg", 10), file("b.jpg", 10)],
    policy: { budget: 1 },
    isPaused: () => paused,
    waitForResume: () => resumePromise,
    worker: async (queueItem, controls) => {
      started.push(queueItem.file.name);
      controls.markUploading();
      if (queueItem.file.name === "a.jpg") await firstBlocker;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  paused = true;
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(started, ["a.jpg"]);
  paused = false;
  resume();
  await run;
  assert.deepEqual(started, ["a.jpg", "b.jpg"]);
});

test("aggregate progress is completed bytes plus all active loaded bytes", () => {
  const progress = aggregateUploadProgress([
    { id: "1", file: file("done.jpg", 100), weight: 1, status: "succeeded", loaded: 100, attemptLoaded: 100, transferredBytes: 100 },
    { id: "2", file: file("active-a.jpg", 200), weight: 1, status: "uploading", loaded: 75, attemptLoaded: 75, transferredBytes: 75 },
    { id: "3", file: file("active-b.jpg", 300), weight: 1, status: "uploading", loaded: 125, attemptLoaded: 125, transferredBytes: 125 },
    { id: "4", file: file("queued.jpg", 400), weight: 1, status: "pending", loaded: 0, attemptLoaded: 0, transferredBytes: 0 },
  ]);
  assert.deepEqual(progress, {
    bytesLoaded: 300,
    bytesTotal: 1000,
    transferredBytes: 300,
    filesSettled: 1,
    filesTotal: 4,
    succeededCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    activeCount: 2,
    queuedCount: 1,
    activeFiles: ["active-a.jpg", "active-b.jpg"],
  });
});

test("failed and cancelled files retain only observed bytes and distinct outcomes", () => {
  const progress = aggregateUploadProgress([
    { id: "1", file: file("early-413.jpg", 100), weight: 1, status: "failed", loaded: 0, attemptLoaded: 0, transferredBytes: 0 },
    { id: "2", file: file("half-network.jpg", 200), weight: 1, status: "failed", loaded: 100, attemptLoaded: 100, transferredBytes: 100 },
    { id: "3", file: file("full-body-500.jpg", 300), weight: 1, status: "failed", loaded: 300, attemptLoaded: 300, transferredBytes: 300 },
    { id: "4", file: file("success.jpg", 400), weight: 1, status: "succeeded", loaded: 400, attemptLoaded: 400, transferredBytes: 400 },
    { id: "5", file: file("cancelled.jpg", 500), weight: 1, status: "cancelled", loaded: 125, attemptLoaded: 125, transferredBytes: 125 },
  ]);

  assert.deepEqual(progress, {
    bytesLoaded: 925,
    bytesTotal: 1500,
    transferredBytes: 925,
    filesSettled: 5,
    filesTotal: 5,
    succeededCount: 1,
    failedCount: 3,
    cancelledCount: 1,
    activeCount: 0,
    queuedCount: 0,
    activeFiles: [],
  });
  assert.equal(getUploadProgressPercent(progress), 62);
  assert.equal(
    formatUploadResultSummary(progress),
    "上传结束：成功 1，失败 3，取消 1",
  );
});

test("successful result summaries still report zero failures", () => {
  assert.equal(
    formatUploadResultSummary({
      succeededCount: 3,
      failedCount: 0,
      cancelledCount: 0,
    }),
    "上传结束：成功 3，失败 0",
  );
});

test("retry progress reset stays monotonic without double-counting the previous attempt", async () => {
  const result = await runWeightedUploadQueue({
    files: [file("retry.jpg", 100)],
    policy: { budget: 1 },
    worker: async (_queueItem, controls) => {
      controls.markUploading();
      controls.setLoaded(60);
      controls.markUploading();
      controls.setLoaded(20);
      controls.setLoaded(100);
    },
  });

  assert.equal(result.items[0].loaded, 100);
  assert.equal(result.items[0].attemptLoaded, 100);
  assert.equal(result.items[0].transferredBytes, 160);
});

test("an explicit route fallback attempt counts a second full request without progress events", async () => {
  const result = await runWeightedUploadQueue({
    files: [file("fallback.jpg", 100)],
    policy: { budget: 1 },
    worker: async (_queueItem, controls) => {
      controls.markUploading();
      controls.setLoaded(60);
      controls.markUploading();
    },
  });

  assert.equal(result.items[0].loaded, 100);
  assert.equal(result.items[0].transferredBytes, 160);
});

test("speed samples use monotonic transferred bytes and never spike on a reset", () => {
  const initial = { ts: 0, transferredBytes: 0, emaBytesPerSecond: 0 };
  const first = sampleUploadSpeed(initial, 100, 1_000);
  assert.deepEqual(first, {
    ts: 1_000,
    transferredBytes: 100,
    emaBytesPerSecond: 100,
    sampled: true,
  });

  const reset = sampleUploadSpeed(first, 20, 2_000);
  assert.deepEqual(reset, {
    ts: 2_000,
    transferredBytes: 100,
    emaBytesPerSecond: 0,
    sampled: true,
  });
});

test("zero-byte batches never divide by zero", () => {
  assert.equal(getUploadProgressPercent({
    bytesLoaded: 0,
    bytesTotal: 0,
    filesSettled: 0,
    filesTotal: 0,
    succeededCount: 0,
  }), 0);
  assert.equal(getUploadProgressPercent({
    bytesLoaded: 0,
    bytesTotal: 0,
    filesSettled: 2,
    filesTotal: 2,
    succeededCount: 1,
  }), 50);
});

test("incomplete byte and zero-byte batches never round up to 100 percent", () => {
  assert.equal(getUploadProgressPercent({
    bytesLoaded: 999,
    bytesTotal: 1_000,
    filesSettled: 1,
    filesTotal: 1,
    succeededCount: 0,
  }), 99);
  assert.equal(getUploadProgressPercent({
    bytesLoaded: 0,
    bytesTotal: 0,
    filesSettled: 201,
    filesTotal: 201,
    succeededCount: 200,
  }), 99);
  assert.equal(getUploadProgressPercent({
    bytesLoaded: 1_000,
    bytesTotal: 1_000,
    filesSettled: 1,
    filesTotal: 1,
    succeededCount: 0,
  }), 100);
});
