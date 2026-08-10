import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(new URL("./SettingsDialog.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../AuthenticatedApp.tsx", import.meta.url), "utf8");
const modalFocus = import("../shared/modalFocus.ts");
const closeGuard = import("./settingsCloseGuard.ts");

class FakeElement {
  constructor(name, { connected = true } = {}) {
    this.name = name;
    this.isConnected = connected;
    this.focusCount = 0;
    this.focusable = [];
  }

  focus() {
    this.focusCount += 1;
  }

  querySelectorAll() {
    return this.focusable;
  }
}

function keyboardEvent(key, shiftKey = false) {
  return {
    key,
    shiftKey,
    prevented: false,
    propagationStopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
}

test("Settings exposes dialog semantics and an explicit initial focus target", () => {
  assert.match(settingsSource, /className="settings-dialog"[\s\S]*role="dialog"/);
  assert.match(settingsSource, /aria-modal="true"/);
  assert.match(settingsSource, /aria-labelledby="settings-dialog-title"/);
  assert.match(settingsSource, /id="settings-dialog-title"/);
  assert.match(settingsSource, /ref=\{closeButtonRef\}/);
  assert.match(settingsSource, /focusElement\(closeButtonRef\.current\)/);
  assert.match(settingsSource, /previousFocusRef\.current = restoreFocusTo/);
  assert.match(appSource, /restoreFocusTo=\{settingsRestoreFocusRef\.current\}/);
  assert.match(appSource, /settingsRestoreFocusRef\.current = userAvatarButtonRef\.current/);
});

test("Escape uses the protected close path while ordinary keys stay inside Settings", async () => {
  const { handleModalKeyDown } = await modalFocus;
  const { getSettingsCloseGuardMessage } = await closeGuard;
  const dialog = new FakeElement("dialog");
  let closeCount = 0;
  const notices = [];
  const protectedClose = (maintenanceActive, trashActive) => {
    const message = getSettingsCloseGuardMessage({ maintenanceActive, trashActive });
    if (message) {
      notices.push(message);
      return;
    }
    closeCount += 1;
  };

  const idleEscape = keyboardEvent("Escape");
  handleModalKeyDown(idleEscape, dialog, null, () => protectedClose(false, false));
  assert.equal(closeCount, 1);
  assert.equal(idleEscape.prevented, true);
  assert.equal(idleEscape.propagationStopped, true);

  const activeEscape = keyboardEvent("Escape");
  handleModalKeyDown(activeEscape, dialog, null, () => protectedClose(true, false));
  assert.equal(closeCount, 1);
  assert.match(notices[0], /维护任务运行中/);

  const trashEscape = keyboardEvent("Escape");
  handleModalKeyDown(trashEscape, dialog, null, () => protectedClose(false, true));
  assert.equal(closeCount, 1);
  assert.match(notices[1], /回收站任务运行中/);

  const ordinaryKey = keyboardEvent("r");
  handleModalKeyDown(ordinaryKey, dialog, null, () => assert.fail("R must not close Settings"));
  assert.equal(ordinaryKey.prevented, false);
  assert.equal(ordinaryKey.propagationStopped, true);
});

test("Tab and Shift+Tab dynamically cycle through current enabled controls", async () => {
  const { trapTabKey } = await modalFocus;
  const dialog = new FakeElement("dialog");
  const close = new FakeElement("close");
  const dynamicControl = new FakeElement("dynamic");
  dialog.focusable = [close];

  assert.equal(trapTabKey(keyboardEvent("Tab"), dialog, close), true);
  assert.equal(close.focusCount, 1);

  dialog.focusable = [close, dynamicControl];
  const forward = keyboardEvent("Tab");
  assert.equal(trapTabKey(forward, dialog, dynamicControl), true);
  assert.equal(close.focusCount, 2);

  const backward = keyboardEvent("Tab", true);
  assert.equal(trapTabKey(backward, dialog, close), true);
  assert.equal(dynamicControl.focusCount, 1);
});

test("focus restoration is connected-only and Settings cleans it up on unmount", async () => {
  const { restoreFocus } = await modalFocus;
  const connected = new FakeElement("connected");
  const disconnected = new FakeElement("disconnected", { connected: false });

  assert.equal(restoreFocus(connected), true);
  assert.equal(restoreFocus(disconnected), false);
  assert.equal(connected.focusCount, 1);
  assert.equal(disconnected.focusCount, 0);
  assert.match(
    settingsSource,
    /return \(\) => \{[\s\S]*restoreFocus\(previousFocusRef\.current\);[\s\S]*previousFocusRef\.current = null;/,
  );
});

test("Settings wires every key through the modal boundary and Escape through the close guard", () => {
  assert.match(settingsSource, /onKeyDown=\{handleDialogKeyDown\}/);
  assert.match(
    settingsSource,
    /handleModalKeyDown\(event, dialog, document\.activeElement, handleProtectedClose\)/,
  );
});

test("deferred WhatsNew cannot overlap Settings or steal its focus", () => {
  assert.match(appSource, /if \(loading \|\| showSettings\) return;/);
  assert.match(
    appSource,
    /\{showWhatsNewPopup && !showSettings && \([\s\S]*<AuxiliaryLazyBoundary label="版本更新">[\s\S]*<Suspense fallback=\{null\}><WhatsNewPopup \/><\/Suspense>/,
  );
});
