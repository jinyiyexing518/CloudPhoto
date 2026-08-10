import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatPhotoDate,
  formatPhotoDateTime,
  formatPhotoGroupDate,
  getPhotoDateKey,
} from "../packages/client/src/utils/dateFormat.ts";

const read = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

const styles = read("packages/client/src/authenticated.css");
const workspaceFab = read(
  "packages/client/src/components/home/floating/WorkspaceFab.tsx",
);
const workspaceSidebar = read(
  "packages/client/src/components/home/WorkspaceSidebar.tsx",
);
const photoCard = read("packages/client/src/components/gallery/PhotoCard.tsx");
const photoGallery = read("packages/client/src/components/gallery/PhotoGallery.tsx");
const folderView = read("packages/client/src/components/gallery/FolderView.tsx");
const filterBar = read("packages/client/src/components/gallery/FilterBar.tsx");
const photoTimeDialog = read(
  "packages/client/src/components/shared/PhotoTimeEditDialog.tsx",
);
const timeCapsule = read(
  "packages/client/src/components/time-capsule/TimeCapsule.tsx",
);

function cssBlock(selector, source = styles) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`(?:^|\\n)\\s*${escaped}\\s*(?:,[^{]+)?\\{([^}]+)\\}`),
  );
  assert(match, `missing CSS block for ${selector}`);
  return match[1];
}

function mediaBlock(maxWidth) {
  const marker = `@media (max-width: ${maxWidth}px)`;
  const start = styles.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const open = styles.indexOf("{", start);
  let depth = 1;
  for (let index = open + 1; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] === "}") depth -= 1;
    if (depth === 0) return styles.slice(open + 1, index);
  }
  assert.fail(`unterminated ${marker}`);
}

function declaration(block, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escaped}\\s*:\\s*([^;]+)`));
  assert(match, `missing ${property} declaration`);
  return match[1].trim();
}

function px(value) {
  const match = value.match(/^(\d+)px$/);
  assert(match, `expected a pixel value, received ${value}`);
  return Number(match[1]);
}

test("shared photo dates stay zh-CN and reject invalid values", () => {
  assert.equal(formatPhotoGroupDate("2026-08-10"), "2026年8月10日");
  assert.equal(formatPhotoDate("2026-06-02T12:00:00"), "2026年6月2日");
  assert.match(formatPhotoDateTime("2026-06-02T12:34:00"), /^2026年6月2日\s+12:34$/);

  for (const invalid of ["", "not-a-date", new Date(Number.NaN)]) {
    assert.equal(formatPhotoDate(invalid), "");
    assert.equal(formatPhotoDateTime(invalid), "");
  }
  assert.equal(formatPhotoGroupDate("2026-02-30"), "");
  assert.equal(formatPhotoDate("2026-02-30T12:00:00"), "");
  for (const nonCanonical of [
    "2026-2-30",
    "2026/02/30",
    "2026-02-30 12:00:00",
  ]) {
    assert.equal(formatPhotoDate(nonCanonical), "");
  }

  const timestamp = "2026-08-09T16:30:00Z";
  const localDate = new Date(timestamp);
  assert.equal(
    getPhotoDateKey(timestamp),
    [
      localDate.getFullYear(),
      String(localDate.getMonth() + 1).padStart(2, "0"),
      String(localDate.getDate()).padStart(2, "0"),
    ].join("-"),
  );
});

test("gallery, card, timeline, and folder reuse one explicit locale formatter", () => {
  assert.match(photoGallery, /formatPhotoGroupDate\(key\)/);
  assert.match(photoCard, /formatPhotoDate\(photo\.createdAt\)/);
  assert.match(photoCard, /formatPhotoDate\(photo\.takenAt\)/);
  assert.match(photoGallery, /formatPhotoDateTime\(/);
  assert.match(folderView, /formatPhotoDateTime\(/);
  assert.doesNotMatch(photoGallery, /toLocale(?:DateString|String)\(undefined/);
  assert.doesNotMatch(photoCard, /toLocaleDateString\(undefined/);
  assert.doesNotMatch(folderView, /toLocaleString\(undefined/);
  assert.match(photoGallery, /formatPhotoGroupDate\(key\) \|\| "日期未知"/);
  assert.match(photoGallery, /getPhotoDateKey\(raw \?\? ""\) \|\| "0000-00-00"/);
});

test("all authenticated native date inputs share readable native control metrics", () => {
  const selector = [
    '.filter-field input[type="date"],',
    '.time-edit-input[type="date"],',
    '.capsule-input[type="date"]',
  ].join("\n");
  const block = cssBlock(selector);
  assert.equal(declaration(block, "font-family"), "inherit");
  assert.equal(declaration(block, "font-size"), "0.9rem");
  assert.equal(declaration(block, "line-height"), "1.25rem");
  assert.equal(px(declaration(block, "height")), 44);
  assert.equal(px(declaration(block, "min-height")), 44);
  assert.doesNotMatch(block, /appearance\s*:/);

  for (const source of [filterBar, photoTimeDialog, timeCapsule]) {
    assert.match(source, /type="date"/);
  }
});

test("compact FAB covers common phones and remains bounded at 200% zoom", () => {
  const compact = mediaBlock(480);
  const rail = cssBlock(".workspace-fab-rail", compact);
  const actions = cssBlock(".workspace-fab-actions", compact);
  const pill = cssBlock(".workspace-fab-pill", compact);
  assert.equal(px(declaration(rail, "width")), 48);
  assert.equal(declaration(rail, "left"), "auto !important");
  assert.equal(declaration(rail, "top"), "auto !important");
  assert.equal(
    declaration(actions, "width"),
    "min(200px, calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)))",
  );
  assert.equal(declaration(pill, "min-width"), "0");
  assert.equal(declaration(pill, "width"), "100%");

  for (const physicalWidth of [320, 360, 390, 430, 480]) {
    for (const zoom of [1, 2]) {
      const viewport = physicalWidth / zoom;
      const panelWidth = Math.min(200, viewport - 24);
      const panelLeft = viewport - 12 - panelWidth;
      assert(panelLeft >= 0, `${physicalWidth}px at ${zoom * 100}% must not overflow left`);
      assert(panelLeft + panelWidth <= viewport, `${physicalWidth}px at ${zoom * 100}% must not overflow right`);
    }
  }
});

test("compact FAB collapses after actions and outside interaction without losing keyboard behavior", () => {
  assert.match(workspaceFab, /const runCompactAction = useCallback/);
  assert.match(workspaceFab, /setCompactExpanded\(false\);[\s\S]*action\(\);/);
  assert.match(workspaceFab, /document\.addEventListener\("pointerdown"/);
  assert.match(workspaceFab, /document\.removeEventListener\("pointerdown"/);
  assert.match(workspaceFab, /if \(event\.key !== "Escape"\) return;/);
  assert.match(workspaceFab, /requestAnimationFrame\(\(\) => compactToggleRef\.current\?\.focus\(\)\)/);
  assert.match(workspaceFab, /compactFirstActionRef\.current\?\.focus\(\)/);
  assert.match(workspaceFab, /aria-expanded=\{compactExpanded\}/);
  assert.match(workspaceFab, /const restoreTarget = compact \? compactToggleRef\.current : event\.currentTarget/);
  assert.match(workspaceFab, /onOpenSidebar\(restoreTarget \?\? event\.currentTarget\)/);
  assert.doesNotMatch(workspaceFab, /restoreAfterHidden/);
  assert.match(workspaceFab, /onClick=\{openSidebarFromFab\}/);
  assert.match(workspaceFab, /runCompactAction\(onPrimaryChipClick, primaryChipRef, activeTab === "timeline"\)/);
  assert.match(workspaceFab, /runCompactAction\(onSecondaryChipClick, secondaryChipRef, activeTab === "timeline"\)/);
  assert.match(workspaceFab, /if \(compact && !restoreFocus\) compactToggleRef\.current\?\.focus\(\);[\s\S]*action\(\)/);
  assert.doesNotMatch(workspaceFab, /compactWasExpanded/);
  assert.match(workspaceSidebar, /useModalFocusBoundary/);
  assert.match(workspaceSidebar, /initialFocusRef: closeButtonRef/);
  assert.match(workspaceSidebar, /ref=\{closeButtonRef\}[^>]*workspace-sidebar-close/);
  assert.match(workspaceSidebar, /sidebarRef\.current\.inert = !isOpen/);
  assert.match(workspaceSidebar, /aria-hidden=\{!isOpen\}/);
  assert.doesNotMatch(workspaceSidebar, /\shidden=\{!isOpen\}/);
});

test("photo actions and avatar expose non-overlapping 44px hitboxes", () => {
  for (const selector of [".move-btn", ".favorite-btn", ".delete-btn", ".user-avatar-btn"]) {
    const block = cssBlock(selector);
    assert(px(declaration(block, "min-width")) >= 44, `${selector} width`);
    assert(px(declaration(block, "min-height")) >= 44, `${selector} height`);
  }

  const info = cssBlock(".photo-info");
  const gap = px(declaration(info, "gap"));
  assert(gap >= 4);
  const hitboxes = [0, 1, 2].map((index) => ({
    left: index * (44 + gap),
    right: index * (44 + gap) + 44,
  }));
  for (let index = 1; index < hitboxes.length; index += 1) {
    assert(hitboxes[index - 1].right <= hitboxes[index].left);
  }

  const compact = mediaBlock(480);
  const compactInfo = cssBlock(".photo-info", compact);
  assert.equal(declaration(compactInfo, "flex-wrap"), "wrap");
  assert.equal(declaration(compactInfo, "gap"), "0");
  assert.equal(declaration(compactInfo, "padding"), "8px 2px");

  const zoomSection = mediaBlock(360);
  assert.equal(
    declaration(cssBlock(".photo-grid", zoomSection), "grid-template-columns"),
    "minmax(0, 1fr)",
  );
  assert.equal(
    declaration(
      cssBlock(".folder-section-grid.photo-grid", zoomSection),
      "grid-template-columns",
    ),
    "minmax(0, 1fr)",
  );

  for (const physicalWidth of [320, 360, 390, 430, 480]) {
    for (const zoom of [1, 2]) {
      const viewport = physicalWidth / zoom;
      const columns = viewport <= 360 ? 1 : 2;
      const cardWidth = (viewport - 24 - (columns - 1) * 10) / columns;
      const actionRowWidth = cardWidth - 4;
      assert(
        actionRowWidth >= 3 * 44,
        `${physicalWidth}px at ${zoom * 100}% must fit three touch targets`,
      );
    }
  }
});

test("44px avatar preserves the shared 52px sticky header boundary", () => {
  const header = cssBlock(".app-header");
  assert.equal(declaration(header, "padding"), "4px 24px");
  assert.equal(
    declaration(header, "padding-top"),
    "calc(4px + env(safe-area-inset-top, 0px))",
  );
  assert.equal(
    declaration(header, "min-height"),
    "calc(52px + env(safe-area-inset-top, 0px))",
  );
  assert.equal(
    declaration(cssBlock(".view-tabs-shell-wrap"), "top"),
    "calc(52px + env(safe-area-inset-top, 0px))",
  );
});
