import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateUploadProgress,
  getUploadConcurrencyPolicy,
  getUploadItemWeight,
  runWeightedUploadQueue,
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
    { id: "1", file: file("done.jpg", 100), weight: 1, status: "succeeded", loaded: 100 },
    { id: "2", file: file("active-a.jpg", 200), weight: 1, status: "uploading", loaded: 75 },
    { id: "3", file: file("active-b.jpg", 300), weight: 1, status: "uploading", loaded: 125 },
    { id: "4", file: file("queued.jpg", 400), weight: 1, status: "pending", loaded: 0 },
  ]);
  assert.deepEqual(progress, {
    bytesLoaded: 300,
    bytesTotal: 1000,
    filesDone: 1,
    filesTotal: 4,
    activeCount: 2,
    queuedCount: 1,
    activeFiles: ["active-a.jpg", "active-b.jpg"],
  });
});
