import assert from "node:assert/strict";
import test from "node:test";
import {
  BATCH_MUTATION_SOURCES,
  createInitialBatchMutationStates,
  getActiveBatchMutation,
  getBatchMutationPercent,
  reduceBatchMutationEvent,
  runBatchMutationBoundary,
} from "./batchMutationState.ts";

const operation = (id, kind = "rename", total = 4) => ({
  id,
  kind,
  done: 0,
  total,
  failed: 0,
});
test("tracks timeline, moments, and folder batch mutations independently", () => {
  assert.deepEqual(BATCH_MUTATION_SOURCES, ["timeline", "moments", "folder"]);
  let states = createInitialBatchMutationStates();
  for (const source of BATCH_MUTATION_SOURCES) {
    states = reduceBatchMutationEvent(states, source, {
      type: "start",
      operation: operation(`${source}-1`),
    });
  }
  assert.deepEqual(
    BATCH_MUTATION_SOURCES.map((source) => states[source]?.id),
    ["timeline-1", "moments-1", "folder-1"],
  );
});

test("finishing one source does not clear another active source", () => {
  let states = createInitialBatchMutationStates();
  states = reduceBatchMutationEvent(states, "timeline", {
    type: "start",
    operation: operation("timeline-1"),
  });
  states = reduceBatchMutationEvent(states, "moments", {
    type: "start",
    operation: operation("moments-1", "time"),
  });
  states = reduceBatchMutationEvent(states, "timeline", {
    type: "finish",
    operationId: "timeline-1",
  });
  assert.equal(states.timeline, null);
  assert.equal(states.moments?.id, "moments-1");
  assert.equal(getActiveBatchMutation(states)?.id, "moments-1");
});

test("stale progress and finish cannot overwrite a newer operation for the same source", () => {
  let states = createInitialBatchMutationStates();
  states = reduceBatchMutationEvent(states, "folder", {
    type: "start",
    operation: operation("folder-old", "move"),
  });
  states = reduceBatchMutationEvent(states, "folder", {
    type: "start",
    operation: operation("folder-new", "location", 8),
  });
  states = reduceBatchMutationEvent(states, "folder", {
    type: "progress",
    operationId: "folder-old",
    done: 4,
    failed: 1,
  });
  states = reduceBatchMutationEvent(states, "folder", {
    type: "finish",
    operationId: "folder-old",
  });
  assert.deepEqual(states.folder, operation("folder-new", "location", 8));
});

test("derives done, failed, and percent from active progress", () => {
  let states = createInitialBatchMutationStates();
  states = reduceBatchMutationEvent(states, "timeline", {
    type: "start",
    operation: operation("timeline-1", "rename", 5),
  });
  states = reduceBatchMutationEvent(states, "timeline", {
    type: "progress",
    operationId: "timeline-1",
    done: 3,
    failed: 1,
  });
  const active = getActiveBatchMutation(states);
  assert.deepEqual(active, {
    id: "timeline-1",
    kind: "rename",
    done: 3,
    total: 5,
    failed: 1,
  });
  assert.equal(getBatchMutationPercent(active), 60);
});

test("synchronous gate blocks double-click re-entry before the first await", async () => {
  const gate = { current: null };
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const first = runBatchMutationBoundary({
    gate,
    operation: operation("timeline-1", "rename", 1),
    items: ["photo"],
    worker: async () => {
      calls += 1;
      await blocker;
    },
  });
  const second = await runBatchMutationBoundary({
    gate,
    operation: operation("timeline-2", "rename", 1),
    items: ["photo"],
    worker: async () => {
      calls += 1;
    },
  });
  assert.equal(second, null);
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(gate.current, null);
});

test("bounded execution isolates rejected and false results and always finishes", async () => {
  const gate = { current: null };
  let active = 0;
  let maxActive = 0;
  const events = [];
  const result = await runBatchMutationBoundary({
    gate,
    operation: operation("folder-1", "move", 9),
    items: Array.from({ length: 9 }, (_, index) => index),
    concurrency: 4,
    onEvent: (event) => events.push(event),
    worker: async (index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (index === 2) throw new Error("rejected");
      return index !== 6;
    },
  });

  assert.equal(maxActive, 4);
  assert.deepEqual(result, { done: 9, total: 9, failed: 2 });
  assert.equal(events[0].type, "start");
  assert.deepEqual(events.at(-1), { type: "finish", operationId: "folder-1" });
  assert.deepEqual(
    events.filter((event) => event.type === "progress").at(-1),
    { type: "progress", operationId: "folder-1", done: 9, failed: 2 },
  );
  assert.equal(gate.current, null);
});
