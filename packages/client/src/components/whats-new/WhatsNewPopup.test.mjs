import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync(
  new URL("./WhatsNewPopup.tsx", import.meta.url),
  "utf8",
);

const modalFocus = import("./modalFocus.ts");

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

function keyboardEvent(shiftKey = false) {
  return {
    key: "Tab",
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

test("focuses the explicit initial control", async () => {
  const { focusElement } = await modalFocus;
  const closeButton = new FakeElement("close");

  assert.equal(focusElement(closeButton), true);
  assert.equal(closeButton.focusCount, 1);
});

test("cycles Tab forward within the current modal controls", async () => {
  const { trapTabKey } = await modalFocus;
  const dialog = new FakeElement("dialog");
  const first = new FakeElement("first");
  const last = new FakeElement("last");
  dialog.focusable = [first, last];
  const event = keyboardEvent();

  assert.equal(trapTabKey(event, dialog, last), true);
  assert.equal(event.prevented, true);
  assert.equal(first.focusCount, 1);
});

test("cycles Shift+Tab backward within the current modal controls", async () => {
  const { trapTabKey } = await modalFocus;
  const dialog = new FakeElement("dialog");
  const first = new FakeElement("first");
  const last = new FakeElement("last");
  dialog.focusable = [first, last];
  const event = keyboardEvent(true);

  assert.equal(trapTabKey(event, dialog, first), true);
  assert.equal(event.prevented, true);
  assert.equal(last.focusCount, 1);
});

test("Escape pins and dismisses the modal", async () => {
  const { handleModalKeyDown } = await modalFocus;
  const dialog = new FakeElement("dialog");
  const event = { ...keyboardEvent(), key: "Escape" };
  let pinCount = 0;
  let dismissCount = 0;

  assert.equal(handleModalKeyDown(
    event,
    dialog,
    null,
    () => { dismissCount += 1; },
    () => { pinCount += 1; },
  ), true);
  assert.equal(event.prevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(pinCount, 1);
  assert.equal(dismissCount, 1);
});

test("modal keyboard interaction is pinned and withheld from background shortcuts", async () => {
  const { handleModalKeyDown } = await modalFocus;
  const dialog = new FakeElement("dialog");
  const event = { ...keyboardEvent(), key: "Delete" };
  let pinCount = 0;

  assert.equal(handleModalKeyDown(
    event,
    dialog,
    null,
    () => assert.fail("Delete must not dismiss the modal"),
    () => { pinCount += 1; },
  ), false);
  assert.equal(event.propagationStopped, true);
  assert.equal(pinCount, 1);
});

test("recomputes controls after dynamic expansion", async () => {
  const { trapTabKey } = await modalFocus;
  const dialog = new FakeElement("dialog");
  const close = new FakeElement("close");
  const fixToggle = new FakeElement("fix-toggle");
  dialog.focusable = [close];
  trapTabKey(keyboardEvent(), dialog, close);

  dialog.focusable = [close, fixToggle];
  const event = keyboardEvent();
  assert.equal(trapTabKey(event, dialog, fixToggle), true);
  assert.equal(close.focusCount, 2);
});

test("restores focus only while the original element remains connected", async () => {
  const { restoreFocus } = await modalFocus;
  const connected = new FakeElement("connected");
  const disconnected = new FakeElement("disconnected", { connected: false });

  assert.equal(restoreFocus(connected), true);
  assert.equal(restoreFocus(disconnected), false);
  assert.equal(connected.focusCount, 1);
  assert.equal(disconnected.focusCount, 0);
});

test("clears every modal timer when keyboard focus pins the popup", async () => {
  const { clearModalTimers } = await modalFocus;
  const handles = { idle: 1, fade: 2, close: 3, initialFocus: 4 };
  const cleared = [];

  clearModalTimers(handles, (handle) => cleared.push(handle));

  assert.deepEqual(cleared, [1, 2, 3, 4]);
  assert.deepEqual(handles, {
    idle: null,
    fade: null,
    close: null,
    initialFocus: null,
  });
});

test("component keeps the complete dialog accessibility contract", () => {
  assert.match(componentSource, /type="button"[\s\S]*className="whats-new-item-summary"/);
  assert.doesNotMatch(componentSource, /role="button"/);
  assert.match(componentSource, /aria-controls=\{detailsId\}/);
  assert.match(componentSource, /id=\{detailsId\}/);
  assert.match(componentSource, /aria-labelledby="whats-new-title"/);
  assert.match(componentSource, /id="whats-new-title"/);
  assert.match(componentSource, /handleModalKeyDown\(event, popup, document\.activeElement, dismiss, pinPopup\)/);
  assert.match(componentSource, /previousFocusRef\.current = document\.activeElement/);
  assert.match(componentSource, /onFocusCapture=\{handlePopupFocus\}/);
  assert.match(componentSource, /clearModalTimers\(timerHandles\.current\)/);
  assert.match(componentSource, /restoreFocus\(previousFocusRef\.current\)/);
  assert.match(componentSource, /requestId !== changelogRequestIdRef\.current/);
  assert.match(componentSource, /entry\.details \? \([\s\S]*<button[\s\S]*type="button"/);
  assert.match(componentSource, /: \([\s\S]*<div className="whats-new-item-summary">/);
});
