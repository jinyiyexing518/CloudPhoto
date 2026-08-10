import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("location search request lifecycle aborts and generation-invalidates stale work", async () => {
  const { createLocationSearchRequestLifecycle } = await import("./locationSearchRequestLifecycle.ts");
  const lifecycle = createLocationSearchRequestLifecycle();

  const first = lifecycle.begin();
  const second = lifecycle.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(lifecycle.isCurrent(first), false);
  assert.equal(lifecycle.isCurrent(second), true);

  for (const reason of ["clear", "coordinates", "close", "unmount", "workspace-change"]) {
    const request = lifecycle.begin();
    lifecycle.invalidate(reason);
    assert.equal(request.signal.aborted, true, `${reason} must abort the active request`);
    assert.equal(lifecycle.isCurrent(request), false, `${reason} must invalidate its generation`);
  }
});

test("location search exposes labelled live semantic controls and complete keyboard behavior", async () => {
  const [panel, styles] = await Promise.all([
    source("./LocationSearchPanel.tsx"),
    source("../../authenticated.css"),
  ]);

  assert.match(panel, /useId\(\)/);
  assert.match(panel, /<label[^>]*className="location-search-label"[^>]*htmlFor=\{inputId\}/);
  assert.match(panel, /<input[\s\S]*id=\{inputId\}[\s\S]*disabled=\{saving\}/);
  assert.match(panel, /className="location-search-panel"[\s\S]*aria-busy=\{searching \|\| saving\}/);
  assert.match(panel, /role="status"[\s\S]*aria-live="polite"[\s\S]*aria-atomic="true"/);
  assert.match(panel, /<button[\s\S]*className="location-search-coord-preview"[\s\S]*disabled=\{saving\}[\s\S]*aria-label=/);
  assert.match(panel, /<li[\s\S]*<button[\s\S]*className="location-search-result"[\s\S]*disabled=\{saving\}[\s\S]*aria-label=/);
  assert.doesNotMatch(panel, /<(?:div|li)[^>]*onClick=/);
  assert.match(panel, /e\.key === "ArrowDown" \|\| e\.key === "ArrowUp"/);
  assert.match(panel, /getSearchChoices\(\)/);
  assert.match(panel, /e\.key === "Escape"[\s\S]*if \(saving\) return;[\s\S]*invalidateSearch\("close"\)/);
  assert.match(styles, /\.location-search-label\s*\{[\s\S]*clip-path:\s*inset\(50%\)/);
  assert.match(styles, /\.location-search-result\s*\{[\s\S]*min-height:\s*44px/);
  assert.match(styles, /\.location-search-coord-preview\s*\{[\s\S]*min-height:\s*44px/);
});

test("query, coordinates, unmount, and request-scope changes cannot publish stale results", async () => {
  const [panel, geocode, memoryMap, timeline, folders, batch] = await Promise.all([
    source("./LocationSearchPanel.tsx"),
    source("../../utils/geocode.ts"),
    source("../memory-map/MemoryMap.tsx"),
    source("../gallery/PhotoGallery.tsx"),
    source("../gallery/FolderView.tsx"),
    source("./BatchOperationsBar.tsx"),
  ]);

  assert.match(panel, /requestScope\s*=/);
  assert.match(panel, /requestLifecycleRef\.current\.begin\(\)/);
  assert.match(panel, /requestLifecycleRef\.current\.isCurrent\(request\)/);
  assert.match(panel, /invalidateSearch\(coords \? "coordinates" : "query-change"\)/);
  assert.match(panel, /\(\) => invalidateSearch\("unmount"\)/);
  assert.match(panel, /invalidateSearch\("workspace-change"\)/);
  assert.match(panel, /useLayoutEffect\(\(\) => \{[\s\S]*requestScopeRef\.current === requestScope/);
  assert.match(panel, /if \(!requestLifecycleRef\.current\.isCurrent\(request\)\) return;[\s\S]*setResults\(res\)[\s\S]*setSearching\(false\)/);
  assert.match(geocode, /options:\s*\{\s*signal\?: AbortSignal\s*\}/);
  assert.match(geocode, /signal:\s*options\.signal/);
  assert.match(geocode, /getAuthGeneration\(\) === generation/);
  assert.match(geocode, /fetchWithDeadline\([\s\S]*options\.signal/);
  assert.match(memoryMap, /requestScope=\{groupId \?\? "personal"\}/);
  assert.match(timeline, /requestScope=\{privateMomentsWorkspace \?\? "personal"\}/);
  assert.match(folders, /locationRequestScope=\{contextKey\}/);
  assert.match(folders, /requestScope=\{locationRequestScope\}/);
  assert.match(batch, /locationRequestScope/);
});
