import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(
  new URL("../packages/client/src/index.css", import.meta.url),
  "utf8",
);

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

function selectorPattern(selector) {
  return selector
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
}

function cssBlock(selector, source = styles) {
  const match = source.match(
    new RegExp(`${selectorPattern(selector)}\\s*\\{([^}]+)\\}`),
  );
  assert(match, `missing CSS block for ${selector}`);
  return match[1];
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

test("320px, 390px, and 500px leave document scrolling to the root", () => {
  assert.doesNotMatch(
    styles,
    /(?:html|body)\s*(?:,\s*(?:html|body)\s*)?\{[^}]*overflow-x\s*:\s*(?:hidden|clip)/s,
    "document overflow must not be globally hidden",
  );

  const mobile = conditionalBlock("@media (max-width: 720px)");
  assert.equal(
    declaration(cssBlock(".auth-page", mobile), "overflow"),
    "visible",
    "the mobile auth page must not become a nested scroll owner",
  );
  assert.match(
    cssBlock(".auth-page::before,\n.auth-page::after", mobile),
    /display\s*:\s*none/,
    "off-canvas auth decorations must not contribute to mobile scroll width",
  );
  const mobileShell = cssBlock(".auth-shell", mobile);
  assert.match(mobileShell, /width\s*:\s*100%/);
  assert.match(
    mobileShell,
    /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/,
  );
  assert.match(cssBlock(".auth-panel"), /min-width\s*:\s*0/);

  for (const viewport of [320, 390, 500]) {
    const narrow = viewport <= 380
      ? conditionalBlock("@media (max-width: 380px)")
      : mobile;
    const pagePadding = Number(
      declaration(cssBlock(".auth-page", narrow), "padding").match(
        /max\((\d+)px/,
      )?.[1],
    );
    const panelPadding = Number(
      declaration(cssBlock(".auth-panel", narrow), "padding").match(
        /^\d+px\s+(\d+)px/,
      )?.[1],
    );
    const shellBorder = px(declaration(cssBlock(".auth-shell"), "border").split(" ")[0]);
    const tabs = cssBlock(".auth-tabs");
    const tabsGap = px(declaration(tabs, "gap"));
    const tabsPadding = px(declaration(tabs, "padding"));
    const tabsBorder = px(declaration(tabs, "border").split(" ")[0]);
    const contentWidth = viewport
      - (2 * pagePadding)
      - (2 * shellBorder)
      - (2 * panelPadding);
    const minimumTabsWidth = (2 * 44)
      + tabsGap
      + (2 * tabsPadding)
      + (2 * tabsBorder);
    assert(
      contentWidth >= minimumTabsWidth,
      `${viewport}px auth panel must fit both 44px tabs without overflow`,
    );
  }
});

test("every auth control keeps at least a 44px by 44px hit target", () => {
  const controls = [
    ".auth-tab",
    ".auth-page .auth-field > input,\n.auth-page .auth-password input",
    ".auth-password-toggle",
    ".auth-submit",
    ".auth-install-button",
  ];

  for (const selector of controls) {
    const block = cssBlock(selector);
    assert(
      px(declaration(block, "min-height")) >= 44,
      `${selector} must be at least 44px high`,
    );
    assert(
      px(declaration(block, "min-width")) >= 44,
      `${selector} must be at least 44px wide`,
    );
  }
});

test("auth controls inherit the system font stack", () => {
  const controls = [
    ".auth-tab",
    ".auth-page .auth-field > input,\n.auth-page .auth-password input",
    ".auth-password-toggle",
    ".auth-submit",
    ".auth-install-button",
  ];

  for (const selector of controls) {
    assert.match(
      cssBlock(selector),
      /font(?:-family)?\s*:\s*inherit/,
      `${selector} must inherit the auth page font`,
    );
  }
});
