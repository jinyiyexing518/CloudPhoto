import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const card = readFileSync(new URL("./PhotoCard.tsx", import.meta.url), "utf8");

test("photo delete confirmation reuses the shared modal focus boundary", () => {
  assert.match(card, /import \{ useModalFocusBoundary \} from "\.\.\/shared\/useModalFocusBoundary"/);
  assert.match(card, /useModalFocusBoundary\(\{[\s\S]*active: showConfirm[\s\S]*layerRef: confirmLayerRef[\s\S]*containerRef: confirmDialogRef[\s\S]*initialFocusRef: cancelButtonRef/);
  assert.match(card, /restoreFocusTo: deleteDialogTriggerRef\.current/);
  assert.match(card, /onEscape: requestCloseDeleteDialog/);
  assert.doesNotMatch(card, /document\.addEventListener\("keydown"/);
});

test("photo delete confirmation is a fully named alertdialog portal", () => {
  assert.match(card, /className="confirm-overlay"[\s\S]*data-modal-layer/);
  assert.match(card, /className="confirm-dialog"[\s\S]*role="alertdialog"/);
  assert.match(card, /aria-modal="true"/);
  assert.match(card, /aria-labelledby=\{deleteDialogTitleId\}/);
  assert.match(card, /aria-describedby=\{deleteDialogDescriptionId\}/);
  assert.match(card, /tabIndex=\{-1\}/);
  assert.match(card, /id=\{deleteDialogTitleId\}[\s\S]*删除照片/);
  assert.match(card, /id=\{deleteDialogDescriptionId\}[\s\S]*此操作不可撤销/);
});

test("photo delete confirmation focuses cancel and protects every close path while pending", () => {
  assert.match(card, /if \(deletePending\) return false;[\s\S]*setShowConfirm\(false\)/);
  assert.match(card, /ref=\{cancelButtonRef\}[\s\S]*onClick=\{requestCloseDeleteDialog\}[\s\S]*disabled=\{deletePending\}/);
  assert.match(card, /className="confirm-delete-btn"[\s\S]*onClick=\{\(\) => void handleConfirmDelete\(\)\}[\s\S]*disabled=\{deletePending\}/);
  assert.match(card, /aria-busy=\{deletePending \|\| undefined\}/);
  assert.match(card, /setDeletePending\(true\)[\s\S]*await onDelete\(\)/);
});

test("photo delete confirmation restores its connected direct or context trigger", () => {
  assert.match(card, /deleteDialogTriggerRef\.current = e\.currentTarget;[\s\S]*setShowConfirm\(true\)/);
  assert.match(card, /deleteDialogTriggerRef\.current = primaryActionRef\.current;[\s\S]*setShowConfirm\(true\)/);
  assert.match(card, /restoreFocusTo: deleteDialogTriggerRef\.current/);
});
