import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isGlobalShortcutEligible,
} from "./globalShortcutEligibility.ts";

const appSource = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");

function target(selectorMatch = false) {
  return {
    closest(selector) {
      for (const required of [
        "input",
        "textarea",
        "select",
        "button",
        "a[href]",
        "contenteditable",
        'role="button"',
      ]) {
        assert.ok(selector.includes(required), `missing interactive target selector: ${required}`);
      }
      return selectorMatch ? this : null;
    },
  };
}

function event(overrides = {}) {
  return {
    key: "r",
    defaultPrevented: false,
    isComposing: false,
    repeat: false,
    target: target(false),
    ...overrides,
  };
}

const noModal = { querySelector: () => null };
const openModal = {
  querySelector(selector) {
    assert.equal(selector, '[aria-modal="true"]');
    return {};
  },
};

test("rejects prevented, composing, repeated refresh, interactive, and modal events", () => {
  assert.equal(isGlobalShortcutEligible(event({ defaultPrevented: true }), noModal), false);
  assert.equal(isGlobalShortcutEligible(event({ isComposing: true }), noModal), false);
  assert.equal(isGlobalShortcutEligible(event({ repeat: true }), noModal), false);
  assert.equal(isGlobalShortcutEligible(event({ target: target(true) }), noModal), false);
  assert.equal(isGlobalShortcutEligible(event(), openModal), false);
});

test("accepts an unmodified body-target refresh when no modal is open", () => {
  assert.equal(isGlobalShortcutEligible(event(), noModal), true);
});

test("AuthenticatedApp uses the eligibility helper instead of an inline tag-name list", () => {
  assert.match(appSource, /isGlobalShortcutEligible\(e, document\)/);
  assert.doesNotMatch(appSource, /tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/);
});
