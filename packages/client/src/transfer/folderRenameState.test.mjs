import assert from "node:assert/strict";
import test from "node:test";
import {
  abortFolderRenameForWorkspaceDrift,
  beginFolderRename,
  createFolderRenameOperation,
  finishFolderRename,
  reduceFolderRenameEvent,
  validateFolderRenameInput,
} from "./folderRenameState.ts";

test("local rename validation rejects separators, dot segments, and sibling conflicts", () => {
  for (const value of ["Nested/Name", "Nested\\Name", ".", "..", "bad\u0000name"]) {
    const result = validateFolderRenameInput("Trips/Old", value, ["Old", "Sibling"]);
    assert.equal(result.ok, false);
  }
  const conflict = validateFolderRenameInput("Trips/Old", " Sibling ", ["Old", "Sibling"]);
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /同级文件夹.*已存在/);
  assert.deepEqual(
    validateFolderRenameInput("Trips/Old", " New ", ["Old", "Sibling"]),
    { ok: true, oldFolder: "Trips/Old", newFolder: "Trips/New", oldLabel: "Old", newLabel: "New" },
  );
  assert.deepEqual(
    validateFolderRenameInput("Trips/Cafe\u0301", "New", ["Cafe\u0301"]),
    {
      ok: true,
      oldFolder: "Trips/Cafe\u0301",
      newFolder: "Trips/New",
      oldLabel: "Cafe\u0301",
      newLabel: "New",
    },
  );
});

test("synchronous gate blocks double-click and only matching finally clears it", () => {
  const gate = { current: null };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = createFolderRenameOperation("rename-1", "personal", "Old", "New");
  const second = createFolderRenameOperation("rename-2", "personal", "Other", "Later");

  assert.equal(beginFolderRename(gate, first, firstController), true);
  assert.equal(beginFolderRename(gate, second, secondController), false);
  finishFolderRename(gate, "rename-stale");
  assert.equal(gate.current?.operationId, "rename-1");
  finishFolderRename(gate, "rename-1");
  assert.equal(gate.current, null);
});

test("stale phase and finish events cannot clear a newer rename operation", () => {
  const oldOperation = createFolderRenameOperation("rename-old", "personal", "Old", "New");
  const newOperation = createFolderRenameOperation("rename-new", "personal", "Other", "Latest");
  let state = reduceFolderRenameEvent(null, { type: "start", operation: oldOperation });
  state = reduceFolderRenameEvent(state, { type: "start", operation: newOperation });
  state = reduceFolderRenameEvent(state, { type: "phase", operationId: "rename-old", phase: "reconciling" });
  state = reduceFolderRenameEvent(state, { type: "finish", operationId: "rename-old" });
  assert.deepEqual(state, newOperation);
});

test("workspace drift aborts the client wait without clearing the active token", () => {
  const gate = { current: null };
  const controller = new AbortController();
  const operation = createFolderRenameOperation("rename-1", "group-a", "Old", "New");
  assert.equal(beginFolderRename(gate, operation, controller), true);
  assert.equal(abortFolderRenameForWorkspaceDrift(gate, "group-a"), false);
  assert.equal(controller.signal.aborted, false);
  assert.equal(abortFolderRenameForWorkspaceDrift(gate, "group-b"), true);
  assert.equal(controller.signal.aborted, true);
  assert.match(String(controller.signal.reason), /工作空间已变更/);
  assert.equal(gate.current?.operationId, "rename-1");
});
