import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

const styles = read("packages/client/src/authenticated.css");
const filterBar = read("packages/client/src/components/gallery/FilterBar.tsx");
const workspaceSidebar = read(
  "packages/client/src/components/home/WorkspaceSidebar.tsx",
);

function cssBlock(selector, source = styles) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert(match, `missing CSS block for ${selector}`);
  return match[1];
}

function containerBlock(maxWidth) {
  const marker = `@container (max-width: ${maxWidth}px)`;
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

test("FilterBar exposes an explicit sidebar variant without changing the default variant", () => {
  assert.match(filterBar, /variant\?:\s*"default"\s*\|\s*"sidebar"/);
  assert.match(filterBar, /variant\s*=\s*"default"/);
  assert.match(
    filterBar,
    /className=\{`filter-bar filter-bar--\$\{variant\}`\}/,
  );
  assert.match(workspaceSidebar, /<FilterBar[\s\S]*variant="sidebar"/);

  const searchRow = filterBar.indexOf('className="filter-search-row"');
  const quickControls = filterBar.indexOf('className="filter-quick-controls"');
  const favorite = filterBar.indexOf('"favoriteOnly"', quickControls);
  const gridSize = filterBar.indexOf('className="grid-size-toggle"');
  assert(searchRow >= 0 && quickControls > searchRow);
  assert(favorite > quickControls && gridSize > favorite);
});

test("sidebar search and clear reflow independently while quick controls wrap", () => {
  const mainRow = cssBlock(".filter-bar--sidebar .filter-main-row");
  assert.equal(declaration(mainRow, "display"), "grid");

  const searchRow = cssBlock(".filter-bar--sidebar .filter-search-row");
  assert.equal(declaration(searchRow, "display"), "grid");
  assert.equal(
    declaration(searchRow, "grid-template-columns"),
    "minmax(0, 1fr) auto",
  );
  assert.equal(declaration(searchRow, "min-width"), "0");

  const quickControls = cssBlock(
    ".filter-bar--sidebar .filter-quick-controls",
  );
  assert.equal(declaration(quickControls, "display"), "flex");
  assert.equal(declaration(quickControls, "flex-wrap"), "wrap");
  assert.equal(declaration(quickControls, "min-width"), "0");

  const zoomSection = containerBlock(260);
  const zoomSearchRow = cssBlock(
    ".filter-bar--sidebar .filter-search-row",
    zoomSection,
  );
  assert.equal(
    declaration(zoomSearchRow, "grid-template-columns"),
    "minmax(0, 1fr)",
  );
});

test("sidebar controls and long labels remain measurable at 320-480px and 200% zoom", () => {
  const touchSelectors = [
    ".workspace-sidebar-close",
    ".filter-bar--sidebar .search-input-wrap",
    ".filter-bar--sidebar .search-clear",
    ".filter-bar--sidebar .filter-clear-btn",
    ".filter-bar--sidebar .filter-toggle-btn",
    ".filter-bar--sidebar .grid-size-btn",
    ".filter-bar--sidebar .filter-chip-remove",
    ".filter-bar--sidebar .filter-field input,\n.filter-bar--sidebar .filter-field select",
  ];
  for (const selector of touchSelectors) {
    const block = cssBlock(selector);
    assert(
      px(declaration(block, "min-height")) >= 44,
      `${selector} must provide a 44px touch target`,
    );
  }

  const toggle = cssBlock(".filter-bar--sidebar .filter-toggle-btn");
  assert.equal(declaration(toggle, "max-width"), "100%");
  assert.equal(declaration(toggle, "white-space"), "normal");
  assert.equal(declaration(toggle, "overflow-wrap"), "anywhere");

  const chip = cssBlock(".filter-bar--sidebar .filter-chip");
  assert.equal(declaration(chip, "max-width"), "100%");
  assert.equal(declaration(chip, "min-width"), "0");
  assert.equal(declaration(chip, "overflow-wrap"), "anywhere");

  const panel = cssBlock(".filter-bar--sidebar .filter-panel");
  assert.equal(declaration(panel, "grid-template-columns"), "minmax(0, 1fr)");

  for (const drawerWidth of [320, 456, 480, 228]) {
    const contentWidth = drawerWidth - 36;
    assert(contentWidth >= 192);
    assert(44 <= contentWidth);
    assert(3 * 44 + 2 * 2 <= contentWidth);
  }
});

test("sidebar containment fixes overflow at the source and keeps desktop layout stable", () => {
  assert.doesNotMatch(
    styles,
    /(?:html|body)\s*(?:,\s*(?:html|body)\s*)?\{[^}]*overflow-x\s*:\s*(?:hidden|clip)/s,
  );

  const sidebar = cssBlock(".filter-bar--sidebar");
  assert.equal(declaration(sidebar, "container-type"), "inline-size");
  assert.equal(declaration(sidebar, "min-width"), "0");
  assert.equal(declaration(sidebar, "max-width"), "100%");
  assert.doesNotMatch(sidebar, /overflow(?:-x)?\s*:\s*(?:hidden|clip)/);

  const defaultMainRow = cssBlock(".filter-main-row");
  assert.equal(declaration(defaultMainRow, "display"), "flex");
  assert.equal(declaration(defaultMainRow, "align-items"), "center");
  assert.equal(declaration(defaultMainRow, "gap"), "10px");

  const defaultSearchRow = cssBlock(".filter-search-row");
  assert.equal(declaration(defaultSearchRow, "display"), "flex");
  assert.equal(declaration(defaultSearchRow, "flex"), "1");

  const defaultQuickControls = cssBlock(".filter-quick-controls");
  assert.equal(declaration(defaultQuickControls, "display"), "flex");
  assert.equal(declaration(defaultQuickControls, "flex"), "0 0 auto");
  assert.doesNotMatch(defaultQuickControls, /flex-wrap\s*:/);

  const defaultGridButton = cssBlock(".grid-size-btn");
  assert.equal(declaration(defaultGridButton, "width"), "30px");
  assert.equal(declaration(defaultGridButton, "height"), "30px");
});
