import assert from "node:assert/strict";
import test from "node:test";
import changelogResponse from "../dist/src/functions/changelogs/changelogResponse.js";

const { CHANGELOG_QUERY, toChangelogEntries } = changelogResponse;

test("uses a safe Cosmos projection without exposing all fields", () => {
  assert.match(CHANGELOG_QUERY, /c\["desc"\] AS description/);
  assert.doesNotMatch(CHANGELOG_QUERY, /\bAS\s+desc\b/i);
  assert.doesNotMatch(CHANGELOG_QUERY, /\bSELECT\s+\*/i);
});

test("maps the internal description alias to the public desc shape", () => {
  const [entry] = toChangelogEntries([
    {
      id: "entry",
      date: "2026-08-07",
      icon: "fix",
      title: "Fixed",
      description: "Public description",
      details: "Details",
      type: "fix",
      seq: 42,
      _ts: 99,
    },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(entry)), {
    id: "entry",
    date: "2026-08-07",
    icon: "fix",
    title: "Fixed",
    desc: "Public description",
    details: "Details",
    type: "fix",
    seq: 42,
  });
  assert.equal(Object.hasOwn(entry, "_ts"), false);
  assert.equal(Object.hasOwn(entry, "description"), false);
});

test("preserves date, sequence, timestamp, and id ordering", () => {
  const entries = toChangelogEntries([
    {
      id: "legacy-a",
      date: "2026-08-06",
      icon: "fix",
      title: "Legacy A",
      description: "A",
      _ts: 10,
    },
    {
      id: "newer-seq",
      date: "2026-08-07",
      icon: "fix",
      title: "Newer seq",
      description: "B",
      seq: 20,
    },
    {
      id: "older-seq",
      date: "2026-08-07",
      icon: "fix",
      title: "Older seq",
      description: "C",
      seq: 10,
    },
    {
      id: "legacy-b",
      date: "2026-08-06",
      icon: "fix",
      title: "Legacy B",
      description: "D",
      _ts: 20,
    },
    {
      id: "legacy-c",
      date: "2026-08-05",
      icon: "fix",
      title: "Legacy C",
      description: "E",
      _ts: 10,
    },
    {
      id: "legacy-d",
      date: "2026-08-05",
      icon: "fix",
      title: "Legacy D",
      description: "F",
      _ts: 10,
    },
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.id),
    [
      "newer-seq",
      "older-seq",
      "legacy-b",
      "legacy-a",
      "legacy-d",
      "legacy-c",
    ]
  );
});
