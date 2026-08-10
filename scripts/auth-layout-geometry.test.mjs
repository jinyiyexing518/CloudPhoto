import test from "node:test";
import assert from "node:assert/strict";
import { meetsMinimumTarget } from "./auth-layout-geometry.mjs";

test("accepts Chromium subpixel noise for a 44px target", () => {
  assert.equal(meetsMinimumTarget(43.99998474121094), true);
});

test("rejects a genuinely undersized target", () => {
  assert.equal(meetsMinimumTarget(43.999), false);
});
