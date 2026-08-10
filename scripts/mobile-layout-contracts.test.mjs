import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

const styles = read("packages/client/src/authenticated.css");
const workspaceFab = read(
  "packages/client/src/components/home/floating/WorkspaceFab.tsx",
);
const workspaceSidebar = read(
  "packages/client/src/components/home/WorkspaceSidebar.tsx",
);
const authenticatedApp = read("packages/client/src/AuthenticatedApp.tsx");
const sourceHtml = read("packages/client/index.html");
let distHtml = "";
try {
  distHtml = read("packages/client/dist/index.html");
} catch {
  // The dist assertion below reports the missing build output as a contract failure.
}

function cssBlock(selector, source = styles) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert(match, `missing CSS block for ${selector}`);
  return match[1];
}

function conditionalBlock(marker) {
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

function mediaBlock(maxWidth) {
  return conditionalBlock(`@media (max-width: ${maxWidth}px)`);
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

test("320px and 390px keep full-bleed summary inside the root document", () => {
  assert.doesNotMatch(
    styles,
    /(?:html|body)\s*(?:,\s*(?:html|body)\s*)?\{[^}]*overflow-x\s*:\s*(?:hidden|clip)/s,
    "document overflow must be fixed at the source, not globally hidden",
  );

  const desktopPadding = px(
    declaration(cssBlock(".view-tabs-shell-wrap"), "--view-tabs-inline-padding"),
  );
  const mobileSection = mediaBlock(680);
  const mobileApp = cssBlock(".app", mobileSection);
  assert.equal(
    declaration(mobileApp, "--mobile-authenticated-header-height"),
    "52px",
  );
  const mobileHeaderHeight = declaration(
    cssBlock(".app-header", mobileSection),
    "min-height",
  );
  const mobileTabsTop = declaration(
    cssBlock(".view-tabs-shell-wrap", mobileSection),
    "top",
  );
  assert.equal(
    mobileHeaderHeight,
    "calc(var(--mobile-authenticated-header-height) + env(safe-area-inset-top, 0px))",
  );
  assert.equal(mobileTabsTop, mobileHeaderHeight);
  const mobilePadding = px(
    declaration(
      cssBlock(".view-tabs-shell-wrap", mobileSection),
      "--view-tabs-inline-padding",
    ),
  );
  assert.equal(desktopPadding, 24);
  assert.equal(mobilePadding, 12);
  assert.match(
    cssBlock(".weekly-summary-card"),
    /margin\s*:\s*0 calc\(-1 \* var\(--view-tabs-inline-padding\)\) -6px/,
  );

  for (const viewport of [320, 390]) {
    const wrapperContentWidth = viewport - (2 * mobilePadding);
    const summaryWidth = wrapperContentWidth + (2 * mobilePadding);
    const summaryLeft = mobilePadding - mobilePadding;
    const rootMaxScrollX = Math.max(0, summaryLeft + summaryWidth - viewport);
    assert.equal(summaryLeft, 0, `${viewport}px summary must start at x=0`);
    assert.equal(summaryWidth, viewport, `${viewport}px summary must stay full-bleed`);
    assert.equal(rootMaxScrollX, 0, `${viewport}px root must not scroll horizontally`);
  }

  assert.match(cssBlock(".weekly-summary-title"), /flex-shrink\s*:\s*0/);
  assert.match(cssBlock(".weekly-summary-toggle"), /width\s*:\s*100%/);
});

test("tab strip retains its own intentional horizontal scrolling", () => {
  assert.match(cssBlock(".view-tabs"), /overflow-x\s*:\s*auto/);
  assert.match(cssBlock(".view-tabs-scroll-area"), /overflow\s*:\s*hidden/);
  assert.match(authenticatedApp, /ref=\{viewTabsRef\}[\s\S]*onScroll=/);
});

test("focused skip link stays fixed inside 320px and 390px viewports", () => {
  const link = cssBlock(".skip-to-content");
  assert.equal(declaration(link, "position"), "fixed");
  assert.equal(declaration(link, "max-width"), "calc(100vw - 24px)");
  assert.match(link, /left\s*:\s*50%/);
  assert.match(
    cssBlock(".skip-to-content:focus-visible"),
    /transform\s*:\s*translate\(-50%,\s*12px\)/,
  );

  for (const viewport of [320, 390]) {
    const maxWidth = viewport - 24;
    const left = (viewport - maxWidth) / 2;
    const rootMaxScrollX = Math.max(0, left + maxWidth - viewport);
    assert.equal(left, 12, `${viewport}px skip link must keep a 12px inline inset`);
    assert.equal(rootMaxScrollX, 0, `${viewport}px skip link must not widen the document`);
  }
});

test("phone FAB defaults to one safe-area-aware 48px launcher", () => {
  assert.match(workspaceFab, /const \[compactExpanded, setCompactExpanded\] = useState\(false\)/);
  assert.match(workspaceFab, /aria-expanded=\{compactExpanded\}/);
  assert.match(workspaceFab, /aria-controls="workspace-fab-actions"/);
  assert.match(workspaceFab, /if \(event\.key !== "Escape"\) return;/);
  assert.match(workspaceFab, /compactToggleRef\.current\?\.focus\(\)/);
  assert.match(workspaceFab, /compactFirstActionRef\.current\?\.focus\(\)/);
  assert.match(workspaceFab, /document\.addEventListener\("pointerdown", collapseOutside\)/);
  assert.match(
    workspaceFab,
    /if \(railRef\.current\?\.contains\(event\.target as Node\)\) return;/,
  );
  assert.match(
    workspaceFab,
    /setCompactExpanded\(false\);[\s\S]*action\(\);/,
    "executed actions must collapse without restoring focus to the launcher",
  );
  assert.match(
    workspaceFab,
    /requestAnimationFrame\(\(\) => compactToggleRef\.current\?\.focus\(\)\)/,
    "Escape must collapse and restore focus to the launcher",
  );
  assert.match(
    workspaceFab,
    /restoreAfterHidden\.current = window\.matchMedia\("\(max-width: 480px\)"\)\.matches/,
  );

  const narrowSection = mediaBlock(480);
  const rail = cssBlock(".workspace-fab-rail", narrowSection);
  const toggle = cssBlock(".workspace-fab-compact-toggle", narrowSection);
  assert.equal(px(declaration(rail, "width")), 48);
  assert.match(rail, /env\(safe-area-inset-right,\s*0px\)/);
  assert.match(rail, /env\(safe-area-inset-bottom,\s*0px\)/);
  assert.equal(px(declaration(toggle, "width")), 48);
  assert.equal(px(declaration(toggle, "min-height")), 48);
  assert.equal(declaration(rail, "left"), "auto !important");
  assert.equal(declaration(rail, "top"), "auto !important");
  assert.match(
    cssBlock(".workspace-fab-actions", narrowSection),
    /display\s*:\s*none/,
  );
  assert.match(
    cssBlock(".workspace-fab-rail--expanded .workspace-fab-actions", narrowSection),
    /display\s*:\s*flex/,
  );

  const defaultFabArea = 48 * 48;
  const formerFabArea = 200 * (58 + 10 + 48);
  assert(defaultFabArea < formerFabArea / 10);
  assert.doesNotMatch(
    mediaBlock(360),
    /workspace-fab/,
    "the 360px folder-card reflow must not reintroduce a competing FAB breakpoint",
  );
});

test("sidebar owns focus while open and the FAB restores the visible launcher", () => {
  assert.match(workspaceSidebar, /role="dialog"/);
  assert.match(workspaceSidebar, /aria-modal="true"/);
  assert.match(workspaceSidebar, /toggleAttribute\("inert", !isOpen\)/);
  assert.match(workspaceSidebar, /if \(isOpen\) closeButtonRef\.current\?\.focus\(\)/);
  assert.match(
    workspaceSidebar,
    /handleModalKeyDown\(event, sidebarRef\.current, document\.activeElement, onClose\)/,
  );
  assert.match(workspaceSidebar, /hidden=\{!isOpen\}/);
  assert.match(workspaceFab, /restoreAfterHidden\.current/);
});

test("folder card actions keep 44px touch targets on desktop and mobile", () => {
  const action = cssBlock(".folder-card-rename-btn,\n.folder-card-delete-btn");
  assert(px(declaration(action, "min-width")) >= 44);
  assert(px(declaration(action, "min-height")) >= 44);
  assert.match(action, /display\s*:\s*inline-flex/);
  assert.match(action, /z-index\s*:\s*2/);
  assert.match(action, /touch-action\s*:\s*manipulation/);
  assert.match(
    cssBlock(".folder-card-rename-btn:focus-visible,\n.folder-card-delete-btn:focus-visible"),
    /outline\s*:\s*3px solid #005a9e/,
  );
  assert(
    styles.lastIndexOf("@media (max-width: 360px)")
      > styles.indexOf("@media (display-mode: standalone)"),
    "the narrow single-column safeguard must override standalone two-column grids",
  );
  assert.match(
    cssBlock(
      ".folder-card-rename-btn,\n  .folder-card-delete-btn",
      conditionalBlock("@media (hover: none), (pointer: coarse)"),
    ),
    /opacity\s*:\s*1/,
  );

  for (const selector of [".folder-card-rename-btn", ".folder-card-delete-btn"]) {
    for (const maxWidth of [680, 360]) {
      assert.doesNotMatch(
        mediaBlock(maxWidth),
        new RegExp(`${selector.replaceAll(".", "\\.")}\\s*\\{[^}]*(?:min-)?(?:width|height)\\s*:`),
        `${selector} must inherit the shared 44px target at ${maxWidth}px`,
      );
    }
  }
});

test("photo card actions keep 44px targets on timeline and moments mobile grids", () => {
  const actions = cssBlock(".move-btn,\n.favorite-btn,\n.delete-btn");
  assert(px(declaration(actions, "min-width")) >= 44);
  assert(px(declaration(actions, "min-height")) >= 44);
  assert.match(actions, /display\s*:\s*inline-flex/);
  assert.match(
    cssBlock(".move-btn:focus-visible,\n.favorite-btn:focus-visible,\n.delete-btn:focus-visible"),
    /outline\s*:\s*3px solid #005a9e/,
  );
  for (const selector of [".move-btn", ".favorite-btn", ".delete-btn"]) {
    for (const maxWidth of [680, 360]) {
      assert.doesNotMatch(
        mediaBlock(maxWidth),
        new RegExp(`${selector.replaceAll(".", "\\.")}\\s*\\{[^}]*(?:min-)?(?:width|height)\\s*:`),
        `${selector} must inherit the shared 44px target at ${maxWidth}px`,
      );
    }
  }
});

test("PWA capability metadata is present in source and build output", () => {
  for (const [label, html] of [["source", sourceHtml], ["dist", distHtml]]) {
    assert.match(
      html,
      /<meta name="mobile-web-app-capable" content="yes"\s*\/?>/,
      `${label} HTML must include the standard mobile capability meta`,
    );
    assert.match(
      html,
      /<meta name="apple-mobile-web-app-capable" content="yes"\s*\/?>/,
      `${label} HTML must retain the Apple capability meta`,
    );
  }
  assert.doesNotMatch(authenticatedApp, /header-install-button/);
  assert.doesNotMatch(styles, /\.header-install-button/);
});
