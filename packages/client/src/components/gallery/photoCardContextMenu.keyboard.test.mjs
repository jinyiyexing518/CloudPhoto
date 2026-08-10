import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const card = readFileSync(new URL("./PhotoCard.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../authenticated.css", import.meta.url), "utf8");
const policySource = readFileSync(new URL("./photoCardContextMenu.ts", import.meta.url), "utf8");
const compiledPolicy = ts.transpileModule(policySource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const policyModuleUrl = `data:text/javascript;base64,${Buffer.from(compiledPolicy).toString("base64")}`;
const {
  getNextPhotoContextMenuIndex,
  getPhotoContextMenuPosition,
} = await import(policyModuleUrl);

test("photo card exposes its context menu from keyboard and anchors zero-coordinate events", () => {
  assert.match(card, /event\.key === "ContextMenu"/);
  assert.match(card, /event\.shiftKey && event\.key === "F10"/);
  assert.match(policySource, /clientX === 0 && clientY === 0/);
  assert.match(card, /getBoundingClientRect\(\)/);
  assert.match(card, /if \(interactionDisabled \|\| selectionMode\) return;/);
});

test("photo context menu positioning preserves pointer intent and bounds keyboard anchors", () => {
  const anchorRect = { left: 340, top: 780, width: 44, height: 44 };
  assert.deepEqual(
    getPhotoContextMenuPosition({
      clientX: 120,
      clientY: 200,
      anchorRect,
      viewportWidth: 390,
      viewportHeight: 844,
      itemCount: 3,
    }),
    { x: 120, y: 200 },
  );
  assert.deepEqual(
    getPhotoContextMenuPosition({
      clientX: 0,
      clientY: 0,
      anchorRect,
      viewportWidth: 390,
      viewportHeight: 844,
      itemCount: 5,
    }),
    { x: 202, y: 608 },
  );
});

test("photo context menu navigation wraps and supports Home and End", () => {
  assert.equal(getNextPhotoContextMenuIndex(0, "ArrowDown", 4), 1);
  assert.equal(getNextPhotoContextMenuIndex(3, "ArrowDown", 4), 0);
  assert.equal(getNextPhotoContextMenuIndex(0, "ArrowUp", 4), 3);
  assert.equal(getNextPhotoContextMenuIndex(2, "Home", 4), 0);
  assert.equal(getNextPhotoContextMenuIndex(1, "End", 4), 3);
  assert.equal(getNextPhotoContextMenuIndex(0, "ArrowDown", 0), null);
});

test("photo context menu uses native menuitem buttons without nested interactive content", () => {
  assert.match(card, /role="menu"/);
  assert.match(card, /aria-label=\{`照片 \$\{displayName\} 操作菜单`\}/);
  assert.match(card, /<li role="none"[\s\S]*<button[\s\S]*role="menuitem"/);
  assert.doesNotMatch(card, /<li[^>]+onClick=/);
  assert.doesNotMatch(card, /className="photo-ctx-item"[\s\S]{0,120}<button/);
});

test("photo context menu owns focus, complete navigation, and connected-only restoration", () => {
  assert.match(card, /menuItemRefs\.current\[0\]\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(card, /"ArrowDown", "ArrowUp", "Home", "End"/);
  assert.match(card, /event\.key === "Escape"/);
  assert.match(card, /primaryActionRef\.current\?\.isConnected/);
  assert.match(card, /const activateContextMenuAction[\s\S]*primaryActionRef\.current\?\.isConnected[\s\S]*primaryActionRef\.current\.focus\(\{ preventScroll: true \}\);[\s\S]*setCtxMenu\(null\);[\s\S]*run\(\)/);
  assert.match(card, /key: "preview"[\s\S]*run: onClick/);
  assert.match(styles, /\.photo-ctx-item:focus-visible\s*\{[\s\S]*outline\s*:\s*3px solid #005a9e/);
});

test("selection and disabled states cannot expose disallowed context actions", () => {
  assert.match(card, /ctxMenu && !interactionDisabled && !selectionMode/);
  assert.match(card, /if \(interactionDisabled \|\| selectionMode\) return;/);
});
