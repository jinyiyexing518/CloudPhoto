import assert from "node:assert/strict";
import test from "node:test";
import {
  focusMenuItem,
  getEnabledMenuItems,
  handleMenuKeyDown,
} from "./menuKeyboard.ts";

class FakeItem {
  constructor(name, { checked = false, disabled = false } = {}) {
    this.name = name;
    this.disabled = disabled;
    this.checked = checked;
    this.focusCount = 0;
  }

  focus() {
    this.focusCount += 1;
  }

  getAttribute(name) {
    if (name === "aria-checked") return this.checked ? "true" : "false";
    return null;
  }
}

class FakeMenu {
  constructor(items) {
    this.items = items;
  }

  querySelectorAll() {
    return this.items;
  }
}

function keyEvent(key, shiftKey = false) {
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

test("enabled items exclude disabled menu actions", () => {
  const enabled = new FakeItem("enabled");
  const disabled = new FakeItem("disabled", { disabled: true });
  assert.deepEqual(getEnabledMenuItems(new FakeMenu([enabled, disabled])), [enabled]);
});

test("opening a selection menu focuses the checked item", () => {
  const first = new FakeItem("first");
  const selected = new FakeItem("selected", { checked: true });
  assert.equal(focusMenuItem(new FakeMenu([first, selected]), "selected"), true);
  assert.equal(selected.focusCount, 1);
});

test("opening an action menu focuses its first enabled item", () => {
  const disabled = new FakeItem("disabled", { disabled: true });
  const first = new FakeItem("first");
  assert.equal(focusMenuItem(new FakeMenu([disabled, first]), "first"), true);
  assert.equal(first.focusCount, 1);
});

test("Arrow keys wrap and Home/End reach boundaries", () => {
  const first = new FakeItem("first");
  const middle = new FakeItem("middle");
  const last = new FakeItem("last");
  const menu = new FakeMenu([first, middle, last]);

  for (const [key, active, expected] of [
    ["ArrowDown", last, first],
    ["ArrowUp", first, last],
    ["Home", middle, first],
    ["End", middle, last],
  ]) {
    const event = keyEvent(key);
    assert.equal(handleMenuKeyDown(event, menu, active, () => undefined), true);
    assert.equal(event.prevented, true);
    assert.equal(expected.focusCount > 0, true);
  }
});

test("Escape restores the trigger while Tab closes without stealing focus", () => {
  const item = new FakeItem("item");
  const menu = new FakeMenu([item]);
  const dismissals = [];

  const escape = keyEvent("Escape");
  assert.equal(handleMenuKeyDown(
    escape,
    menu,
    item,
    (restoreFocus) => dismissals.push(restoreFocus),
  ), true);
  assert.equal(escape.prevented, true);

  const tab = keyEvent("Tab");
  assert.equal(handleMenuKeyDown(
    tab,
    menu,
    item,
    (restoreFocus) => dismissals.push(restoreFocus),
  ), true);
  assert.equal(tab.prevented, false);
  assert.deepEqual(dismissals, [true, false]);
});
