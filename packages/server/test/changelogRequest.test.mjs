import assert from "node:assert/strict";
import test from "node:test";
import changelogRequest from "../dist/src/functions/changelogs/changelogRequest.js";

const { parseChangelogDays } = changelogRequest;

test("normalizes changelog day ranges to the supported contract", () => {
  const cases = [
    [null, 30],
    ["abc", 30],
    ["0", 30],
    ["-1", 30],
    ["1.5", 30],
    ["1", 1],
    ["30", 30],
    ["999", 365],
  ];

  for (const [input, expected] of cases) {
    assert.equal(parseChangelogDays(input), expected, `days=${input}`);
  }
});
