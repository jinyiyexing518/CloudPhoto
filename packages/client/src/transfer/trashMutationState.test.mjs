import assert from "node:assert/strict";
import test from "node:test";
import {
  TRASH_MUTATION_KINDS,
  beginTrashMutation,
  createTrashMutation,
  finishTrashMutation,
  getTrashMutationBannerText,
  getTrashMutationGuardMessage,
  getTrashMutationPercent,
  isTrashMutationActive,
  reduceTrashMutationEvent,
  runTrashMutationBoundary,
  trashMutationWorkspaceMatches,
} from "./trashMutationState.ts";

const operation = (operationId, kind = "restore-all", total = 3, workspaceId = "group-a") =>
  createTrashMutation(operationId, kind, workspaceId, total);

test("defines every trash mutation kind with typed labels and percentages", () => {
  assert.deepEqual(TRASH_MUTATION_KINDS, [
    "item-restore",
    "item-delete",
    "restore-all",
    "empty-trash",
    "restore-folder",
    "delete-folder",
  ]);
  for (const kind of TRASH_MUTATION_KINDS) {
    const state = operation(`op-${kind}`, kind, 4);
    assert.ok(state.label.length > 0);
    assert.equal(state.done, 0);
    assert.equal(state.failed, 0);
    assert.equal(state.phase, "running");
  }
  assert.equal(getTrashMutationPercent({ ...operation("op", "restore-all", 4), done: 3 }), 75);
});

test("stale token progress and final events cannot overwrite a newer operation", () => {
  let state = reduceTrashMutationEvent(null, { type: "start", operation: operation("old") });
  state = reduceTrashMutationEvent(state, { type: "start", operation: operation("new", "empty-trash", 8) });
  const current = state;
  state = reduceTrashMutationEvent(state, {
    type: "progress",
    token: "old",
    done: 3,
    failed: 1,
  });
  state = reduceTrashMutationEvent(state, { type: "complete", token: "old" });
  assert.deepEqual(state, current);
});

test("synchronous gate blocks same-frame double-click and cross-kind re-entry", () => {
  const gate = { current: null };
  const first = operation("first", "item-restore", 1);
  assert.equal(beginTrashMutation(gate, first), true);
  assert.equal(beginTrashMutation(gate, operation("double", "item-restore", 1)), false);
  assert.equal(beginTrashMutation(gate, operation("cross", "empty-trash", 5)), false);
  finishTrashMutation(gate, "stale");
  assert.equal(gate.current?.token, "first");
  finishTrashMutation(gate, first.token);
  assert.equal(gate.current, null);
});

test("a rejected re-entry cannot take ownership of the active controller slot", async () => {
  const gate = { current: null };
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  let controllerOwner = null;
  const first = runTrashMutationBoundary({
    gate,
    operation: operation("first", "item-restore", 1),
    items: ["a"],
    onAcquired: () => { controllerOwner = "first"; },
    worker: async () => blocker,
  });
  const second = await runTrashMutationBoundary({
    gate,
    operation: operation("second", "item-delete", 1),
    items: ["b"],
    onAcquired: () => { controllerOwner = "second"; },
    worker: async () => undefined,
  });
  assert.equal(second, null);
  assert.equal(controllerOwner, "first");
  release();
  await first;
});

test("gate and active state remain held until remote reconciliation finishes", async () => {
  const gate = { current: null };
  const events = [];
  let release;
  const reconciliation = new Promise((resolve) => { release = resolve; });
  let finalizing;
  const enteredFinalization = new Promise((resolve) => { finalizing = resolve; });
  const run = runTrashMutationBoundary({
    gate,
    operation: operation("reconcile", "restore-all", 1),
    items: ["a"],
    onEvent: (event) => events.push(event),
    worker: async () => undefined,
    beforeFinish: async () => {
      finalizing();
      await reconciliation;
    },
  });

  await enteredFinalization;
  assert.equal(gate.current?.token, "reconcile");
  assert.equal(events.some((event) => event.type === "complete"), false);
  release();
  await run;
  assert.equal(gate.current, null);
  assert.equal(events.at(-1).type, "complete");
});

test("runner uses a stable sequential snapshot and isolates ordinary failures", async () => {
  const source = ["a", "b", "c"];
  const calls = [];
  const events = [];
  const resultPromise = runTrashMutationBoundary({
    gate: { current: null },
    operation: operation("batch", "restore-all", source.length),
    items: source,
    worker: async (item) => {
      calls.push(item);
      if (item === "a") source.push("late");
      if (item === "b") throw new Error("ordinary failure");
    },
    onEvent: (event) => events.push(event),
  });
  const result = await resultPromise;

  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.deepEqual(result, { done: 3, total: 3, failed: 1, stopped: false });
  assert.deepEqual(
    events.filter((event) => event.type === "progress").at(-1),
    { type: "progress", token: "batch", done: 3, failed: 1 },
  );
});

test("stop aborts the current request, starts no next item, and preserves partial statistics", async () => {
  const controller = new AbortController();
  const calls = [];
  const events = [];
  const result = await runTrashMutationBoundary({
    gate: { current: null },
    operation: operation("stop", "empty-trash", 3),
    items: ["a", "b", "c"],
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    worker: async (item, _index, signal) => {
      calls.push(item);
      if (item === "a") return;
      controller.abort(new DOMException("stop", "AbortError"));
      signal.throwIfAborted();
    },
  });

  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(result, { done: 1, total: 3, failed: 0, stopped: true });
  const stopped = events.at(-1);
  assert.equal(stopped.type, "stop");
  assert.equal(stopped.done, 1);
  assert.equal(stopped.failed, 0);
});

test("aborted work is not counted as a normal failure or reported complete", async () => {
  const controller = new AbortController();
  const events = [];
  const result = await runTrashMutationBoundary({
    gate: { current: null },
    operation: operation("abort", "item-delete", 1),
    items: ["a"],
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    worker: async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    },
  });
  assert.deepEqual(result, { done: 0, total: 1, failed: 0, stopped: true });
  assert.equal(events.some((event) => event.type === "complete"), false);
});

test("active, workspace, guard, stopped banner, and accessible copy are explicit", () => {
  let state = operation("copy", "delete-folder", 5);
  state = reduceTrashMutationEvent(state, { type: "progress", token: state.token, done: 2, failed: 1 });
  assert.equal(isTrashMutationActive(state), true);
  assert.equal(trashMutationWorkspaceMatches(state, "group-a"), true);
  assert.equal(trashMutationWorkspaceMatches(state, "group-b"), false);
  assert.match(getTrashMutationGuardMessage(state), /彻底删除文件夹.*2\/5.*失败 1/);
  state = reduceTrashMutationEvent(state, {
    type: "stop",
    token: state.token,
    done: 2,
    failed: 1,
    message: "任务已停止，远端状态已重新对账。",
  });
  assert.equal(state?.phase, "stopped");
  assert.equal(isTrashMutationActive(state), false);
  assert.match(getTrashMutationBannerText(state), /已停止.*2\/5.*失败 1/);
});
