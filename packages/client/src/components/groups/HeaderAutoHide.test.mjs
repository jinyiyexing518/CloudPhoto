import assert from "node:assert/strict";
import test from "node:test";
import { getHeaderVisibilityAction } from "../../headerAutoHide.ts";

const scrollingDown = {
  scrollY: 240,
  delta: 12,
  sidebarOpen: false,
  headerFocusWithin: false,
  headerMenuOpen: false,
  headerDialogActive: false,
};

test("focus, either header menu, and a header dialog pin the header visible", () => {
  for (const lock of [
    "headerFocusWithin",
    "headerMenuOpen",
    "headerDialogActive",
  ]) {
    assert.equal(
      getHeaderVisibilityAction({ ...scrollingDown, [lock]: true }),
      "reveal",
      `${lock} must reveal instead of hiding`,
    );
  }
});

test("natural focus departure only permits a later downward scroll to hide", () => {
  assert.equal(getHeaderVisibilityAction(scrollingDown), "hide");
  assert.equal(
    getHeaderVisibilityAction({ ...scrollingDown, delta: 0 }),
    "preserve",
  );
  assert.equal(
    getHeaderVisibilityAction({ ...scrollingDown, delta: -12 }),
    "reveal",
  );
});

test("near-top and sidebar states continue to reveal the header", () => {
  assert.equal(
    getHeaderVisibilityAction({ ...scrollingDown, scrollY: 32 }),
    "reveal",
  );
  assert.equal(
    getHeaderVisibilityAction({ ...scrollingDown, sidebarOpen: true }),
    "reveal",
  );
});
