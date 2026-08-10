import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const batchSource = readFileSync(new URL("./BatchOperationsBar.tsx", import.meta.url), "utf8");
const folderSource = readFileSync(new URL("../gallery/FolderView.tsx", import.meta.url), "utf8");
const timelineSource = readFileSync(new URL("../gallery/PhotoGallery.tsx", import.meta.url), "utf8");
const boundarySource = readFileSync(new URL("./useModalFocusBoundary.ts", import.meta.url), "utf8");

test("shared batch delete is a protected alertdialog in timeline and folder views", () => {
  assert.match(timelineSource, /<BatchOperationsBar/);
  assert.match(folderSource, /<BatchOperationsBar/);
  assert.match(batchSource, /useModalFocusBoundary\(\{[\s\S]*active: showBatchConfirm/);
  assert.match(batchSource, /data-modal-layer/);
  assert.match(batchSource, /role="alertdialog"/);
  assert.match(batchSource, /aria-modal="true"/);
  assert.match(batchSource, /aria-labelledby=\{titleId\}/);
  assert.match(batchSource, /aria-describedby=\{descriptionId\}/);
  assert.match(batchSource, /initialFocusRef: cancelButtonRef/);
  assert.match(batchSource, /onEscape: \(\) => \{[\s\S]*if \(busy\) return false/);
  assert.match(batchSource, /onClick=\{requestClose\}/);
});

test("folder share dialog uses a named boundary and blocks close while pending", () => {
  assert.match(folderSource, /useModalFocusBoundary\(\{[\s\S]*active: showShareFolderDialog && currentPath !== null/);
  assert.match(folderSource, /initialFocusRef: shareFirstOptionRef/);
  assert.match(folderSource, /const closeShareFolderDialog = useCallback[\s\S]*if \(sharingFolder \|\| mutationBusy\) return false/);
  assert.match(folderSource, /className="share-folder-dialog"[\s\S]*role="dialog"/);
  assert.match(folderSource, /aria-labelledby="share-folder-dialog-title"/);
  assert.match(folderSource, /aria-describedby="share-folder-dialog-description"/);
  assert.match(folderSource, /data-modal-layer/);
});

test("folder quick move is a protected named dialog with first-field focus", () => {
  assert.match(folderSource, /useModalFocusBoundary\(\{[\s\S]*active: quickMovePhoto !== null/);
  assert.match(folderSource, /initialFocusRef: quickMoveSelectRef/);
  assert.match(folderSource, /const closeQuickMoveDialog = useCallback[\s\S]*if \(quickMoveBusy\) return false/);
  assert.match(folderSource, /className="confirm-dialog"[\s\S]*role="dialog"[\s\S]*aria-labelledby="quick-move-dialog-title"/);
  assert.match(folderSource, /aria-describedby="quick-move-dialog-description"/);
  assert.match(folderSource, /disabled=\{quickMoveBusy\}/);
  assert.match(folderSource, /data-modal-layer/);
});

test("all added consumers inherit connected-only restoration and dynamic Tab trapping", () => {
  assert.match(boundarySource, /trapTabKey\(event, container, document\.activeElement\)/);
  assert.match(boundarySource, /restoreFocus\(restoreFocusRef\?\.current \?\? previousFocusRef\.current\)/);
});
