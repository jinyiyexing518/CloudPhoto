import assert from "node:assert/strict";
import test from "node:test";
import {
  getDangerousOperationSnapshot,
  hasDangerousOperation,
  setDangerousOperationActivity,
} from "./dangerousOperationGate.ts";

const idleFacts = {
  upload: false,
  download: false,
  deletion: false,
  voice: false,
  batchMutation: false,
  trashMutation: false,
  maintenance: false,
  folderRename: false,
};

test("every destructive or in-flight operation independently closes the reload gate", () => {
  assert.equal(hasDangerousOperation(idleFacts), false);
  for (const operation of Object.keys(idleFacts)) {
    assert.equal(
      hasDangerousOperation({ ...idleFacts, [operation]: true }),
      true,
      `${operation} must block worker activation and reload`,
    );
  }
});

test("multiple sources cannot clear another tab-local operation", () => {
  setDangerousOperationActivity("transfer", true, "uploading");
  setDangerousOperationActivity("folder-rename", true, "renaming");
  setDangerousOperationActivity("transfer", false, "");
  assert.deepEqual(getDangerousOperationSnapshot(), {
    active: true,
    message: "renaming",
  });
  setDangerousOperationActivity("folder-rename", false, "");
  assert.deepEqual(getDangerousOperationSnapshot(), {
    active: false,
    message: "",
  });
});
