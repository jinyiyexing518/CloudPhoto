import assert from "node:assert/strict";
import test from "node:test";
import momentDateKey from "../dist/src/functions/moments/momentDateKey.js";

const { normalizeLocalDateKey } = momentDateKey;

test("moment view API accepts only canonical calendar dates", () => {
  const reference = new Date("2026-08-11T12:00:00.000Z");
  assert.equal(normalizeLocalDateKey("2026-08-11", reference), "2026-08-11");
  assert.equal(normalizeLocalDateKey(" 2026-08-11 ", reference), "2026-08-11");
  assert.equal(normalizeLocalDateKey("2026-08-12", reference), "2026-08-12");
  assert.equal(
    normalizeLocalDateKey("2026-08-10", new Date("2026-08-11T00:30:00.000Z")),
    "2026-08-10",
  );
  assert.equal(
    normalizeLocalDateKey("2026-08-12", new Date("2026-08-11T23:30:00.000Z")),
    "2026-08-12",
  );

  for (const value of [
    undefined,
    "",
    "2026-02-30",
    "2026-2-3",
    "2026/08/11",
    "2026-08-11T00:00:00Z",
    "2026-08-10",
    "9999-12-31",
  ]) {
    assert.equal(normalizeLocalDateKey(value, reference), null);
  }
});
