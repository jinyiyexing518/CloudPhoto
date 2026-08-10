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

test("320px auth layout fixes overflow at the decorative source", () => {
  assert.doesNotMatch(
    styles,
    /(?:html|body)\s*(?:,\s*(?:html|body)\s*)?\{[^}]*overflow-x\s*:\s*(?:hidden|clip)/s,
    "document overflow must not be globally hidden",
  );

  const mobile = conditionalBlock("@media (max-width: 720px)");
  assert.match(
    cssBlock(".auth-page::before,\n.auth-page::after", mobile),
    /display\s*:\s*none/,
    "off-canvas auth decorations must not contribute to mobile scroll width",
  );
  assert.match(cssBlock(".auth-shell", mobile), /width\s*:\s*100%/);
});

test("every auth control keeps at least a 44px hit target", () => {
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
  }

  assert(
    px(declaration(cssBlock(".auth-password-toggle"), "min-width")) >= 44,
    "password visibility toggle must be at least 44px wide",
  );
});
