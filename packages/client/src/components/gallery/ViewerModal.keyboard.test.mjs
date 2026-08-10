import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timelineSource = readFileSync(new URL("./PhotoGallery.tsx", import.meta.url), "utf8");
const folderSource = readFileSync(new URL("./FolderView.tsx", import.meta.url), "utf8");
const photoCardSource = readFileSync(new URL("./PhotoCard.tsx", import.meta.url), "utf8");
const timeDialogSource = readFileSync(new URL("../shared/PhotoTimeEditDialog.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../AuthenticatedApp.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../../authenticated.css", import.meta.url), "utf8");
const boundarySource = readFileSync(new URL("../shared/useModalFocusBoundary.ts", import.meta.url), "utf8");
const whatsNewSource = readFileSync(new URL("../whats-new/WhatsNewPopup.tsx", import.meta.url), "utf8");
const modalFocus = import("../shared/modalFocus.ts");

class FakeElement {
  constructor(name, { connected = true, inert = false, ariaHidden = null } = {}) {
    this.name = name;
    this.isConnected = connected;
    this.inert = inert;
    this.hidden = false;
    this.attributes = new Map();
    this.focusCount = 0;
    this.focusable = [];
    if (ariaHidden !== null) this.attributes.set("aria-hidden", ariaHidden);
  }

  focus() {
    this.focusCount += 1;
  }

  querySelectorAll() {
    return this.focusable;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

function fakeDocument(children) {
  return { body: { children } };
}

test("stacked modal isolation exposes only the active body layer", async () => {
  const {
    activateModalLayer,
    deactivateModalLayer,
    isTopModalLayer,
    resetModalLayerStackForTests,
  } = await modalFocus;
  resetModalLayerStackForTests();

  const root = new FakeElement("root");
  const preserved = new FakeElement("preserved", { inert: true, ariaHidden: "false" });
  const viewer = new FakeElement("viewer");
  const child = new FakeElement("child");
  const documentRoot = fakeDocument([root, preserved, viewer, child]);

  activateModalLayer(viewer, documentRoot);
  assert.equal(root.inert, true);
  assert.equal(root.getAttribute("aria-hidden"), "true");
  assert.equal(viewer.inert, false);
  assert.equal(isTopModalLayer(viewer), true);

  const lateModal = new FakeElement("late-modal");
  lateModal.querySelector = (selector) => selector === '[aria-modal="true"]' ? {} : null;
  documentRoot.body.children.push(lateModal);
  const { refreshModalIsolation } = await modalFocus;
  refreshModalIsolation(documentRoot);
  assert.equal(lateModal.inert, true);
  assert.equal(lateModal.hidden, true);
  assert.equal(lateModal.getAttribute("aria-hidden"), "true");

  activateModalLayer(child, documentRoot);
  assert.equal(viewer.inert, true);
  assert.equal(viewer.getAttribute("aria-hidden"), "true");
  assert.equal(child.inert, false);
  assert.equal(isTopModalLayer(viewer), false);
  assert.equal(isTopModalLayer(child), true);

  deactivateModalLayer(child, documentRoot);
  assert.equal(viewer.inert, false);
  assert.equal(viewer.getAttribute("aria-hidden"), null);
  assert.equal(root.inert, true);

  deactivateModalLayer(viewer, documentRoot);
  assert.equal(root.inert, false);
  assert.equal(root.getAttribute("aria-hidden"), null);
  assert.equal(preserved.inert, true);
  assert.equal(preserved.getAttribute("aria-hidden"), "false");
  resetModalLayerStackForTests();
});

test("timeline and folder viewers share the complete dialog boundary contract", () => {
  for (const [name, source] of [["timeline", timelineSource], ["folder", folderSource]]) {
    assert.match(source, /createPortal\(/, `${name} viewer must render outside #root`);
    assert.match(source, /useModalFocusBoundary\(\{[\s\S]*layerRef:[\s\S]*containerRef:[\s\S]*initialFocusRef:/);
    assert.match(source, /className="modal-overlay"[\s\S]*data-modal-layer/);
    assert.match(source, /className=(?:\{`modal-content|"modal-content")[\s\S]*role="dialog"/);
    assert.match(source, /aria-modal="true"/);
    assert.match(source, /aria-label=\{`照片详情：\$\{/);
    assert.match(source, /tabIndex=\{-1\}/);
    assert.match(source, /ref=\{viewerCloseButtonRef\}/);
    assert.match(source, /onModalKeyDown[\s\S]*ArrowLeft[\s\S]*ArrowRight/);
    assert.doesNotMatch(source, /Keyboard navigation when modal is open/);
  }
  assert.match(photoCardSource, /tabIndex=\{!onSelect && !interactionDisabled \? -1 : undefined\}/);
  assert.match(photoCardSource, /event\.currentTarget\.focus\(\{ preventScroll: true \}\);[\s\S]*onClick\(\)/);
  assert.match(photoCardSource, /videoRepairTargetRef\.current\?\.focus\(\{ preventScroll: true \}\);[\s\S]*setCtxMenu\(null\);[\s\S]*onClick\(\)/);
});

test("nested viewer layers are independently named and focus-managed", () => {
  for (const source of [timelineSource, folderSource]) {
    assert.match(source, /useModalFocusBoundary\(\{[\s\S]*active: showOriginalPreview/);
    assert.match(source, /className="modal-preview-overlay"[\s\S]*data-modal-layer/);
    assert.match(source, /className="modal-preview-content"[\s\S]*role="dialog"/);
    assert.match(source, /aria-label="原图预览"/);
  }

  assert.match(timeDialogSource, /useModalFocusBoundary\(\{/);
  assert.match(timeDialogSource, /className="confirm-overlay"[\s\S]*data-modal-layer/);
  assert.match(timeDialogSource, /className="time-edit-dialog"[\s\S]*role="dialog"/);
  assert.match(timeDialogSource, /aria-modal="true"/);
  assert.match(timeDialogSource, /aria-labelledby="photo-time-edit-title"/);
  assert.match(timeDialogSource, /id="photo-time-edit-title"/);
});

test("late portals are re-isolated and native media controls retain their keys", async () => {
  const { getFocusableElements, isModalShortcutTarget } = await modalFocus;
  const dialog = new FakeElement("dialog");
  const video = new FakeElement("video");
  dialog.focusable = [video];

  assert.deepEqual(getFocusableElements(dialog), [video]);
  assert.equal(isModalShortcutTarget({
    closest: (selector) => selector.includes("video[controls]") ? video : null,
  }), true);
  assert.match(boundarySource, /new MutationObserver\(\(\) => refreshModalIsolation\(document\)\)/);
  assert.match(boundarySource, /bodyObserver\.observe\(document\.body, \{ childList: true \}\)/);
  assert.match(boundarySource, /event\.stopImmediatePropagation\(\)/);
  assert.match(whatsNewSource, /if \(!popup \|\| hasActiveModalLayer\(\)\) return;/);
  assert.match(whatsNewSource, /const hideBehindSharedModal[\s\S]*setVisible\(false\)[\s\S]*hideBehindSharedModal\(\);[\s\S]*subscribeModalStack\(hideBehindSharedModal\)/);
  assert.match(timelineSource, /active: showShortcutHelp[\s\S]*onKeyDown:[\s\S]*event\.key === "\?"/);
});

test("header install entry remains removed while viewer accessibility changes", () => {
  assert.doesNotMatch(appSource, /header-install-button/);
  assert.doesNotMatch(cssSource, /\.header-install-button/);
});
