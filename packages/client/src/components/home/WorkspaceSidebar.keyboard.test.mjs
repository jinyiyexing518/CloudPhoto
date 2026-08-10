import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebarSource = readFileSync(new URL("./WorkspaceSidebar.tsx", import.meta.url), "utf8");
const fabSource = readFileSync(new URL("./floating/WorkspaceFab.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../AuthenticatedApp.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../settings/SettingsDialog.tsx", import.meta.url), "utf8");
const boundarySource = readFileSync(new URL("../shared/useModalFocusBoundary.ts", import.meta.url), "utf8");
const modalFocus = import("../shared/modalFocus.ts");

class FakeElement {
  constructor({ connected = true, visible = true } = {}) {
    this.isConnected = connected;
    this.visible = visible;
    this.focusCount = 0;
    this.focusable = [];
    this.attributes = new Map();
  }

  focus() {
    this.focusCount += 1;
  }

  querySelectorAll() {
    return this.focusable;
  }

  getClientRects() {
    return this.visible ? [{}] : [];
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

function keyboardEvent({ shiftKey = false } = {}) {
  return {
    key: "Tab",
    shiftKey,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

test("closed sidebar stays mounted for transition but is excluded from Tab and the AX tree", () => {
  assert.match(sidebarSource, /createPortal\(/);
  assert.match(sidebarSource, /data-modal-layer/);
  assert.match(sidebarSource, /sidebarRef\.current\.inert = !isOpen/);
  assert.match(sidebarSource, /aria-hidden=\{!isOpen\}/);
  assert.doesNotMatch(sidebarSource, /\shidden=\{!isOpen\}/);
  assert.match(sidebarSource, /useModalFocusBoundary\(\{[\s\S]*active: isOpen && activeTab !== "folder"/);
});

test("open sidebar is a labelled modal drawer with dynamic focus containment and Escape dismissal", () => {
  assert.match(sidebarSource, /role="dialog"/);
  assert.match(sidebarSource, /aria-modal=\{isOpen \? "true" : undefined\}/);
  assert.match(sidebarSource, /aria-labelledby="workspace-sidebar-title"/);
  assert.match(sidebarSource, /id="workspace-sidebar-title"/);
  assert.match(sidebarSource, /initialFocusRef: closeButtonRef/);
  assert.match(sidebarSource, /restoreFocusTo/);
  assert.match(sidebarSource, /const requestClose = useCallback\(\(\) => \{[\s\S]*onClose\(\);[\s\S]*return true/);
  assert.match(sidebarSource, /onEscape: requestClose/);
  assert.match(sidebarSource, /className="workspace-sidebar-backdrop"[\s\S]*onClick=\{onClose\}/);
  assert.match(boundarySource, /trapTabKey\(event, container, document\.activeElement\)/);
  assert.match(boundarySource, /restoreFocus\(previousFocusRef\.current\)/);
});

test("FAB hands the real desktop or compact restore trigger to the sidebar", () => {
  assert.match(fabSource, /onOpenSidebar: \(trigger: HTMLButtonElement\) => void/);
  assert.match(fabSource, /const restoreTarget = compact \? compactToggleRef\.current : event\.currentTarget/);
  assert.match(fabSource, /onOpenSidebar\(restoreTarget \?\? event\.currentTarget\)/);
  assert.doesNotMatch(fabSource, /restoreAfterHidden/);
  assert.match(appSource, /sidebarRestoreFocusRef\.current = trigger/);
  assert.match(appSource, /restoreFocusTo=\{sidebarRestoreFocusRef\.current\}/);
});

test("Settings forms a stacked shared modal and restores to its sidebar action", () => {
  assert.match(settingsSource, /createPortal\(/);
  assert.match(settingsSource, /useModalFocusBoundary\(\{/);
  assert.match(settingsSource, /data-modal-layer/);
  assert.match(settingsSource, /restoreFocusTo/);
  assert.match(appSource, /settingsRestoreFocusRef\.current = document\.activeElement/);
  assert.match(appSource, /onOpenManagedShares=\{\(\) => openSettingsTab/);
  assert.match(appSource, /onOpenDiagnostics=\{\(\) => openSettingsTab/);
  assert.match(appSource, /document\.querySelector\('\[data-modal-layer\]:not\(\[inert\]\)'\)/);
  assert.match(appSource, /isScrollableModalTouchTarget\(target, activeModalLayer\)/);
});

test("folder teardown closes the drawer and shared cleanup restores only connected visible triggers", async () => {
  const { restoreFocus } = await modalFocus;
  assert.match(appSource, /if \(tab === "folder"\) closeWorkspaceSidebar\(\)/);
  assert.match(appSource, /if \(!sidebarOpen \|\| activeTab === "folder"\) return/);
  assert.match(appSource, /if \(activeTabRef\.current === "folder"\) return/);

  const connected = new FakeElement();
  const disconnected = new FakeElement({ connected: false });
  const hidden = new FakeElement({ visible: false });
  assert.equal(restoreFocus(connected), true);
  assert.equal(restoreFocus(disconnected), false);
  assert.equal(restoreFocus(hidden), false);
  assert.equal(connected.focusCount, 1);
});

test("Tab and Shift+Tab use the current control set after stacked dialogs close", async () => {
  const { trapTabKey } = await modalFocus;
  const drawer = new FakeElement();
  const close = new FakeElement();
  const action = new FakeElement();
  drawer.focusable = [close, action];

  assert.equal(trapTabKey(keyboardEvent(), drawer, action), true);
  assert.equal(close.focusCount, 1);

  drawer.focusable = [close];
  assert.equal(trapTabKey(keyboardEvent({ shiftKey: true }), drawer, close), true);
  assert.equal(close.focusCount, 2);
});

test("iOS touch lock allows real inner scrolling but rejects both modal backdrops", async () => {
  const { isScrollableModalTouchTarget } = await modalFocus;
  const layer = {
    parentElement: null,
    scrollHeight: 900,
    clientHeight: 400,
    scrollWidth: 400,
    clientWidth: 400,
    contains(node) {
      for (let current = node; current; current = current.parentElement) {
        if (current === this) return true;
      }
      return false;
    },
  };
  const backdrop = {
    parentElement: layer,
    scrollHeight: 900,
    clientHeight: 400,
    scrollWidth: 400,
    clientWidth: 400,
  };
  const dialog = {
    parentElement: layer,
    scrollHeight: 400,
    clientHeight: 400,
    scrollWidth: 400,
    clientWidth: 400,
  };
  const scrollBody = {
    parentElement: dialog,
    scrollHeight: 900,
    clientHeight: 400,
    scrollWidth: 400,
    clientWidth: 400,
  };
  const fixedBody = {
    ...scrollBody,
    scrollHeight: 400,
  };
  const readStyle = (element) => (
    element === layer
      ? { overflowX: "hidden", overflowY: "auto" }
      : element === backdrop
        ? { overflowX: "hidden", overflowY: "hidden" }
        : { overflowX: "hidden", overflowY: "auto" }
  );

  assert.equal(isScrollableModalTouchTarget(layer, layer, readStyle), false);
  assert.equal(isScrollableModalTouchTarget(backdrop, layer, readStyle), false);
  assert.equal(isScrollableModalTouchTarget(scrollBody, layer, readStyle), true);
  assert.equal(isScrollableModalTouchTarget(fixedBody, layer, readStyle), false);
});

test("the open drawer owns S without stealing text-entry keystrokes", async () => {
  const { isModalShortcutTarget } = await modalFocus;
  assert.match(sidebarSource, /onKeyDown: handleSidebarKeyDown/);
  assert.match(sidebarSource, /event\.key\.toLowerCase\(\) !== "s"/);
  assert.match(sidebarSource, /isModalShortcutTarget\(event\.target\)/);
  assert.match(sidebarSource, /event\.preventDefault\(\);[\s\S]*onClose\(\)/);

  assert.equal(isModalShortcutTarget({ closest: () => ({ tagName: "INPUT" }) }), true);
  assert.equal(isModalShortcutTarget({ closest: () => null }), false);
});
