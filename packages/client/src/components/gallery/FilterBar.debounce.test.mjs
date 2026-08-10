import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFilterNameDebouncer } from "./filterNameDebounce.ts";

const filterBarSource = readFileSync(new URL("./FilterBar.tsx", import.meta.url), "utf8");
const authenticatedAppSource = readFileSync(
  new URL("../../AuthenticatedApp.tsx", import.meta.url),
  "utf8",
);
const workspaceSidebarSource = readFileSync(
  new URL("../home/WorkspaceSidebar.tsx", import.meta.url),
  "utf8",
);

const emptyFilter = {
  name: "",
  subject: "",
  uploader: "",
  dateFrom: "",
  dateTo: "",
  favoriteOnly: false,
  missingSubjectOnly: false,
  uncategorizedOnly: false,
  noGpsOnly: false,
  folder: "",
};

class FakeScheduler {
  now = 0;
  nextId = 1;
  tasks = new Map();

  set = (callback, delayMs) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, dueAt: this.now + delayMs });
    return id;
  };

  clear = (id) => {
    this.tasks.delete(id);
  };

  advanceBy(delayMs) {
    this.now += delayMs;
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.dueAt <= this.now)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);
    for (const [id, task] of due) {
      this.tasks.delete(id);
      task.callback();
    }
  }
}

function createHarness() {
  const scheduler = new FakeScheduler();
  let filters = { ...emptyFilter };
  let onChange = () => {};
  const debouncer = createFilterNameDebouncer({
    readFilters: () => filters,
    readOnChange: () => onChange,
    scheduler,
  });

  return {
    scheduler,
    debouncer,
    setFilters(nextFilters) {
      filters = nextFilters;
    },
    setOnChange(nextOnChange) {
      onChange = nextOnChange;
    },
  };
}

test("pending name uses the latest filters and callback", () => {
  const harness = createHarness();
  const staleCalls = [];
  const latestCalls = [];
  harness.setOnChange((filters) => staleCalls.push(filters));
  harness.debouncer.schedule("海边");

  harness.setFilters({
    ...emptyFilter,
    subject: "旅行",
    dateFrom: "2026-08-10",
    favoriteOnly: true,
  });
  harness.setOnChange((filters) => latestCalls.push(filters));
  harness.scheduler.advanceBy(300);

  assert.deepEqual(staleCalls, []);
  assert.deepEqual(latestCalls, [{
    ...emptyFilter,
    name: "海边",
    subject: "旅行",
    dateFrom: "2026-08-10",
    favoriteOnly: true,
  }]);
});

test("rapid typing commits only the final name", () => {
  const harness = createHarness();
  const calls = [];
  harness.setOnChange((filters) => calls.push(filters));

  harness.debouncer.schedule("海");
  harness.scheduler.advanceBy(100);
  harness.debouncer.schedule("海边");
  harness.scheduler.advanceBy(299);
  assert.deepEqual(calls, []);

  harness.scheduler.advanceBy(1);
  assert.deepEqual(calls.map(({ name }) => name), ["海边"]);
});

test("clear or external reset invalidates a pending name", () => {
  const harness = createHarness();
  const calls = [];
  harness.setOnChange((filters) => calls.push(filters));

  harness.debouncer.schedule("会复活的名称");
  harness.debouncer.cancel();
  harness.setFilters(emptyFilter);
  harness.scheduler.advanceBy(300);

  assert.deepEqual(calls, []);
});

test("cleanup cancellation prevents callbacks after sidebar unmount", () => {
  const harness = createHarness();
  const calls = [];
  harness.setOnChange((filters) => calls.push(filters));

  harness.debouncer.schedule("卸载后不提交");
  harness.debouncer.cancel();
  harness.scheduler.advanceBy(300);

  assert.deepEqual(calls, []);
});

test("StrictMode cleanup can be followed by a fresh schedule", () => {
  const harness = createHarness();
  const calls = [];
  harness.setOnChange((filters) => calls.push(filters));

  harness.debouncer.schedule("synthetic mount");
  harness.debouncer.cancel();
  harness.debouncer.schedule("real mount");
  harness.scheduler.advanceBy(300);

  assert.deepEqual(calls.map(({ name }) => name), ["real mount"]);
});

test("invalidated callbacks stay inert even if a scheduler cannot unschedule them", () => {
  const scheduler = new FakeScheduler();
  const calls = [];
  const debouncer = createFilterNameDebouncer({
    readFilters: () => emptyFilter,
    readOnChange: () => (filters) => calls.push(filters),
    scheduler: {
      set: scheduler.set,
      clear: () => {},
    },
  });

  debouncer.schedule("stale");
  debouncer.cancel();
  scheduler.advanceBy(300);

  assert.deepEqual(calls, []);
});

test("FilterBar wires latest refs, reset cancellation, cleanup, and button safety", () => {
  assert.match(filterBarSource, /readFilters:\s*\(\)\s*=>\s*filtersRef\.current/);
  assert.match(filterBarSource, /readOnChange:\s*\(\)\s*=>\s*onChangeRef\.current/);
  assert.match(filterBarSource, /resetChanged\s*\|\|\s*filters === emptyFilter/);
  assert.match(filterBarSource, /useLayoutEffect\(\(\)\s*=>\s*\{/);
  assert.match(filterBarSource, /\(\)\s*=>\s*nameDebouncerRef\.current\?\.cancel\(\)/);
  assert.match(
    filterBarSource,
    /<button type="button" className="filter-clear-btn" onClick=\{clearAll\}>/,
  );
  assert.doesNotMatch(
    filterBarSource,
    /setTimeout\(\(\)\s*=>\s*onChange\(\{\s*\.\.\.filters,\s*name:/,
  );
});

test("external filter replacements advance an explicit reset generation", () => {
  assert.match(
    authenticatedAppSource,
    /setFilterResetVersion\(\(current\)\s*=>\s*current \+ 1\)/,
  );
  assert.match(
    authenticatedAppSource,
    /filterResetVersion=\{filterResetVersion\}/,
  );
  assert.match(
    authenticatedAppSource,
    /useLayoutEffect\(\(\)\s*=>\s*\{\s*resetFilters\(\);\s*\},\s*\[currentGroupId,\s*resetFilters\]\)/,
  );
  assert.match(
    workspaceSidebarSource,
    /resetVersion=\{filterResetVersion\}/,
  );
});
