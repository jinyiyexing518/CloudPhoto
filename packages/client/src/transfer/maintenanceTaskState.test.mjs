import assert from "node:assert/strict";
import test from "node:test";
import {
  beginMaintenanceTask,
  createMaintenanceTask,
  finishMaintenanceTask,
  getMaintenanceBannerText,
  getMaintenanceGuardMessage,
  isMaintenanceTaskActive,
  maintenanceWorkspaceMatches,
  reduceMaintenanceTaskEvent,
} from "./maintenanceTaskState.ts";

test("tracks cumulative thumbnail progress and derives accurate copy", () => {
  let state = reduceMaintenanceTaskEvent(null, {
    type: "start",
    operation: createMaintenanceTask("thumb-1", "thumbnails", "group-a"),
  });
  state = reduceMaintenanceTaskEvent(state, {
    type: "progress",
    operationId: "thumb-1",
    processed: 60,
    changed: 42,
    skipped: 17,
    failed: 1,
    hasMore: true,
  });

  assert.equal(isMaintenanceTaskActive(state), true);
  assert.equal(
    getMaintenanceGuardMessage(state),
    "生成历史缩略图进行中（已处理 60 张，生成 42 张，失败 1 张），请勿离开当前页面",
  );
  assert.equal(
    getMaintenanceBannerText(state),
    "生成历史缩略图：已处理 60 张，生成 42 张，跳过 17 张，失败 1 张",
  );
});

test("tracks metadata recovery, missing, budget, and byte progress", () => {
  let state = reduceMaintenanceTaskEvent(null, {
    type: "start",
    operation: createMaintenanceTask("meta-1", "metadata", ""),
  });
  state = reduceMaintenanceTaskEvent(state, {
    type: "progress",
    operationId: "meta-1",
    processed: 30,
    changed: 18,
    skipped: 0,
    failed: 2,
    candidates: 20,
    estimatedBytes: 2_000_000,
    bytesRead: 1_500_000,
    recovered: 10,
    cleanedInvalid: 4,
    trulyMissing: 6,
    skippedBudget: 2,
    hasMore: true,
  });

  assert.equal(
    getMaintenanceBannerText(state),
    "回填照片元数据：候选 20 张，恢复 10 张，确认缺失 6 张，清理无效 4 张，预算跳过 2 张，读取 1.4 MiB，失败 2 张",
  );
  assert.doesNotMatch(getMaintenanceBannerText(state), /%/);
});

test("stale progress and completion cannot overwrite or clear a newer operation", () => {
  let state = reduceMaintenanceTaskEvent(null, {
    type: "start",
    operation: createMaintenanceTask("old", "metadata", ""),
  });
  state = reduceMaintenanceTaskEvent(state, {
    type: "start",
    operation: createMaintenanceTask("new", "thumbnails", "group-b"),
  });
  const current = state;

  state = reduceMaintenanceTaskEvent(state, {
    type: "progress",
    operationId: "old",
    processed: 300,
    changed: 300,
    skipped: 0,
    failed: 0,
    hasMore: false,
  });
  state = reduceMaintenanceTaskEvent(state, { type: "clear", operationId: "old" });

  assert.deepEqual(state, current);
});

test("a synchronous gate rejects double-click and cross-kind re-entry", () => {
  const gate = { current: null };
  assert.equal(beginMaintenanceTask(gate, "thumb-1", "thumbnails"), true);
  assert.equal(beginMaintenanceTask(gate, "thumb-2", "thumbnails"), false);
  assert.equal(beginMaintenanceTask(gate, "meta-1", "metadata"), false);
  finishMaintenanceTask(gate, "stale");
  assert.equal(gate.current?.operationId, "thumb-1");
  finishMaintenanceTask(gate, "thumb-1");
  assert.equal(gate.current, null);
});

test("stopping preserves completed-page statistics", () => {
  let state = reduceMaintenanceTaskEvent(null, {
    type: "start",
    operation: createMaintenanceTask("meta-1", "metadata", "group-a"),
  });
  state = reduceMaintenanceTaskEvent(state, {
    type: "progress",
    operationId: "meta-1",
    processed: 30,
    changed: 12,
    skipped: 0,
    failed: 1,
    hasMore: true,
  });
  state = reduceMaintenanceTaskEvent(state, {
    type: "stop",
    operationId: "meta-1",
    message: "任务已停止，已保留完成页面的统计。",
  });

  assert.equal(state?.phase, "stopped");
  assert.equal(state?.processed, 30);
  assert.equal(state?.changed, 12);
  assert.equal(state?.hasMore, true);
  assert.equal(isMaintenanceTaskActive(state), false);
});

test("workspace matching is explicit", () => {
  const state = createMaintenanceTask("meta-1", "metadata", "group-a");
  assert.equal(maintenanceWorkspaceMatches(state, "group-a"), true);
  assert.equal(maintenanceWorkspaceMatches(state, "group-b"), false);
});
