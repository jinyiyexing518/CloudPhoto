import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  compositeHex,
  contrastRatio,
  meetsContrast,
  relativeLuminance,
} from "../../accessibility/contrast.mjs";

const styles = readFileSync(new URL("../../authenticated.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]+)\\}`, "m"));
  assert(match, `missing CSS block for ${selector}`);
  return match[1];
}

function hexDeclaration(selector, property) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`${property}\\s*:[^;#]*(#[0-9a-f]{3,6})\\b`, "i");

  for (const match of styles.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "g"))) {
    const color = match[1].match(declaration);
    if (color) return color[1];
  }

  assert.fail(`missing ${property} hex color for ${selector}`);
}

function assertContrast(label, foreground, background, minimum) {
  const ratio = contrastRatio(foreground, background);
  assert.ok(
    ratio >= minimum,
    `${label} must meet ${minimum}:1; received ${ratio.toFixed(2)}:1 (${foreground} on ${background})`,
  );
}

test("shared contrast helpers implement WCAG luminance, alpha composition, and thresholds", () => {
  assert.equal(relativeLuminance("#000"), 0);
  assert.equal(relativeLuminance("#fff"), 1);
  assert.equal(contrastRatio("#000", "#fff"), 21);
  assert.equal(compositeHex("#000", "#fff", 0.5), "#808080");
  assert.equal(meetsContrast("#888", "#fff", 4.5), false);
  assert.throws(() => compositeHex("#000", "#fff", 1.1), /between 0 and 1/);
});

test("photo and folder card filenames, metadata, counts, and new-folder states meet 4.5:1", () => {
  const white = "#ffffff";
  for (const [label, selector, background] of [
    ["photo filename", ".photo-name", white],
    ["photo uploader", ".photo-meta-by", white],
    ["photo upload date", ".photo-meta-date", white],
    ["photo taken date", ".photo-meta-taken", white],
    ["photo subject", ".photo-subject-tag", hexDeclaration(".photo-subject-tag", "background")],
    ["folder name", ".folder-card-name", white],
    ["folder count", ".folder-card-count", white],
    ["new-folder button", ".folder-new-btn", hexDeclaration(".folder-new-btn", "background")],
    ["new-folder hover", ".folder-new-btn", hexDeclaration(".folder-new-btn:hover", "background")],
  ]) {
    assertContrast(label, hexDeclaration(selector, "color"), background, 4.5);
  }
});

test("card action icons meet 3:1 in normal, hover, and selected states without opacity loss", () => {
  const white = "#ffffff";
  assert.match(cssBlock(".favorite-btn"), /opacity\s*:\s*1\b/);
  assert.match(cssBlock(".delete-btn"), /opacity\s*:\s*1\b/);
  assert.match(cssBlock(".folder-card-rename-btn,\n.folder-card-delete-btn"), /opacity\s*:\s*1\b/);

  for (const [label, selector, backgroundSelector] of [
    ["move", ".move-btn", ".move-btn"],
    ["move hover", ".move-btn", ".move-btn:hover"],
    ["favorite", ".favorite-btn", null],
    ["favorite hover", ".favorite-btn:hover", null],
    ["favorite selected", ".favorite-btn--on", null],
    ["delete", ".delete-btn", null],
    ["delete hover", ".delete-btn", ".delete-btn:hover"],
    ["folder rename", ".folder-card-rename-btn", null],
    ["folder rename hover", ".folder-card-rename-btn", ".folder-card-rename-btn:hover"],
    ["folder delete", ".folder-card-delete-btn", null],
    ["folder delete hover", ".folder-card-delete-btn", ".folder-card-delete-btn:hover"],
  ]) {
    const background = backgroundSelector
      ? hexDeclaration(backgroundSelector, "background")
      : white;
    assertContrast(label, hexDeclaration(selector, "color"), background, 3);
  }

  for (const selector of [".move-btn", ".favorite-btn", ".favorite-btn--on", ".delete-btn"]) {
    assertContrast(
      `${selector} on selected card`,
      hexDeclaration(selector, "color"),
      "#eef6ff",
      3,
    );
  }
});

test("card focus, selection, and media badges preserve non-text and small-text contrast", () => {
  const white = "#ffffff";
  for (const [label, selector, property, background, minimum] of [
    ["photo primary focus", ".photo-card-primary:focus-visible", "outline", white, 3],
    ["photo action focus", ".photo-card-controls button:focus-visible", "outline", white, 3],
    ["selected photo outline", ".photo-card--selected", "outline", white, 3],
    ["unselected badge boundary", ".photo-select-badge", "border", white, 3],
    ["selected badge fill", ".photo-select-badge--on", "background", white, 3],
    ["folder primary focus", ".folder-card-open:focus-visible", "outline", white, 3],
    ["folder action focus", ".folder-card-rename-btn:focus-visible,\n.folder-card-delete-btn:focus-visible", "outline", white, 3],
    ["folder hover boundary", ".folder-card:hover", "border-color", white, 3],
    ["folder drag boundary", ".folder-card--dragover", "border-color", hexDeclaration(".folder-card--dragover", "background"), 3],
    ["format badge", ".photo-format-badge", "background", hexDeclaration(".photo-format-badge", "color"), 4.5],
    ["favorite badge", ".photo-favorite-badge", "color", hexDeclaration(".photo-favorite-badge", "background"), 3],
  ]) {
    const color = hexDeclaration(selector, property);
    assertContrast(label, color, background, minimum);
  }

  const playBackground = compositeHex("#000", white, 0.6);
  const pauseBackground = compositeHex("#000", white, 0.52);
  assertContrast("GIF play icon", "#fff", playBackground, 3);
  assertContrast("GIF pause icon", "#fff", pauseBackground, 3);

  for (const [label, opacity] of [
    ["video badge", 0.6],
    ["GIF badge", 0.6],
    ["animated GIF badge", 0.56],
  ]) {
    assertContrast(label, "#fff", compositeHex("#000", white, opacity), 4.5);
  }

  const gifFocusSelector = ".photo-card-controls .gif-play-center-btn:focus-visible,\n.photo-card-controls .gif-pause-corner-btn:focus-visible";
  const gifFocus = cssBlock(gifFocusSelector);
  assert.match(gifFocus, /outline\s*:\s*3px solid #fff/);
  assert.match(gifFocus, /box-shadow\s*:\s*0 0 0 5px rgba\(0,\s*0,\s*0,\s*0\.82\)/);
  assert.ok(
    styles.indexOf(gifFocusSelector) > styles.indexOf(".photo-card-controls button:focus-visible"),
    "specific GIF focus styles must follow and outrank the generic control focus rule",
  );
  assertContrast("GIF focus ring", "#fff", compositeHex("#000", white, 0.82), 3);
});
