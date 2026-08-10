import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const capsuleSource = readFileSync(new URL("./TimeCapsule.tsx", import.meta.url), "utf8");
const boundarySource = readFileSync(new URL("../shared/useModalFocusBoundary.ts", import.meta.url), "utf8");

test("capsule creator uses the shared stacked dialog boundary", () => {
  assert.match(capsuleSource, /useModalFocusBoundary\(\{[\s\S]*active: showCreate/);
  assert.match(capsuleSource, /className="capsule-dialog-overlay"[\s\S]*data-modal-layer/);
  assert.match(capsuleSource, /className="capsule-dialog"[\s\S]*role="dialog"/);
  assert.match(capsuleSource, /aria-modal="true"/);
  assert.match(capsuleSource, /aria-labelledby="capsule-create-title"/);
  assert.match(capsuleSource, /id="capsule-create-title"/);
  assert.match(capsuleSource, /tabIndex=\{-1\}/);
  assert.match(capsuleSource, /initialFocusRef: capsuleTitleInputRef/);
  assert.match(capsuleSource, /ref=\{capsuleTitleInputRef\}/);
  assert.match(capsuleSource, /htmlFor="capsule-title-input"[\s\S]*id="capsule-title-input"/);
  assert.match(capsuleSource, /htmlFor="capsule-unlock-date"[\s\S]*id="capsule-unlock-date"/);
});

test("capsule cancel and Escape share one close path for connected-only restoration", () => {
  assert.match(capsuleSource, /const closeCreateDialog = useCallback\(\(\) => \{[\s\S]*setShowCreate\(false\)/);
  assert.match(capsuleSource, /onEscape: \(\) => \{[\s\S]*closeCreateDialog\(\)/);
  assert.match(capsuleSource, /className="capsule-cancel-btn" onClick=\{closeCreateDialog\}/);
  assert.match(boundarySource, /restoreFocus\(previousFocusRef\.current\)/);
});

test("capsule's dynamic photo controls stay trapped and all keys stop before global shortcuts", () => {
  assert.match(capsuleSource, /visibleDisplayPhotos\.map[\s\S]*<button[\s\S]*aria-pressed=\{sel\}/);
  assert.match(boundarySource, /event\.stopPropagation\(\);[\s\S]*event\.key === "Tab"[\s\S]*trapTabKey/);
  assert.match(boundarySource, /document\.addEventListener\("keydown", handleKeyDown\)/);
});

test("capsule photo picker incrementally mounts bounded derivative-only batches", () => {
  assert.match(capsuleSource, /displayPhotos\.slice\(0, visiblePhotoCount\)/);
  assert.match(capsuleSource, /new IntersectionObserver\([\s\S]*root: scrollRoot[\s\S]*rootMargin: "0px 0px 96px 0px"/);
  assert.match(capsuleSource, /advanceIncrementalWindow\(/);
  assert.match(capsuleSource, /observer\.disconnect\(\)/);
  assert.match(capsuleSource, /active = false/);
  assert.match(capsuleSource, /resetCapsulePhotoWindow\(\)/);
  assert.match(capsuleSource, /capsulePhotoGridRef\.current\.scrollTop = 0/);
  assert.match(capsuleSource, /photoGridHasScrolled/);
  assert.doesNotMatch(capsuleSource, /visibleDisplayPhotos[\s\S]*url=\{p\.url\}[\s\S]*<video/);
});

test("capsule selection remains independent from the visible photo window", () => {
  assert.match(capsuleSource, /const \[selectedNames, setSelectedNames\] = useState<Set<string>>/);
  assert.match(capsuleSource, /photoNames: \[\.\.\.selectedNames\]/);
  assert.match(capsuleSource, /创建胶囊 \(\{selectedNames\.size\} 张\)/);
  assert.match(capsuleSource, /value=\{folderFilter\}[\s\S]*resetCapsulePhotoWindow\(\);[\s\S]*setFolderFilter\(e\.target\.value\)/);
});

test("opened capsule viewer is also a named reusable modal layer", () => {
  assert.match(capsuleSource, /useModalFocusBoundary\(\{[\s\S]*active: openedCapsule !== undefined/);
  assert.match(capsuleSource, /className="capsule-view-overlay"[\s\S]*data-modal-layer/);
  assert.match(capsuleSource, /className="capsule-view-dialog"[\s\S]*role="dialog"/);
  assert.match(capsuleSource, /aria-modal="true"/);
});
