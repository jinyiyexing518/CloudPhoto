import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const groupSwitcher = read("./GroupSwitcher.tsx");
const createGroupDialog = read("./CreateGroupDialog.tsx");
const groupSettings = read("./GroupSettings.tsx");
const authenticatedApp = read("../../AuthenticatedApp.tsx");
const styles = read("../../authenticated.css");
const menuKeyboard = read("../shared/menuKeyboard.ts");

test("group switcher exposes one coherent menu contract with real buttons", () => {
  assert.match(groupSwitcher, /const GROUP_SWITCHER_TRIGGER_ID = "group-switcher-trigger"/);
  assert.match(groupSwitcher, /const GROUP_SWITCHER_MENU_ID = "group-switcher-menu"/);
  assert.match(groupSwitcher, /aria-haspopup="menu"/);
  assert.match(groupSwitcher, /aria-expanded=\{open\}/);
  assert.match(groupSwitcher, /aria-controls=\{GROUP_SWITCHER_MENU_ID\}/);
  assert.match(groupSwitcher, /role="menu"/);
  assert.match(groupSwitcher, /role="menuitemradio"/);
  assert.match(groupSwitcher, /aria-checked=\{currentGroupId ===/);
  assert.match(groupSwitcher, /role="menuitem"/);
  assert.doesNotMatch(groupSwitcher, /<(?:div|span)[^>]+onClick=/);
  assert.match(groupSwitcher, /onBeforeSelect && !onBeforeSelect\(id\)[\s\S]*return false/);
});

test("group menu owns open focus, roving keys, dismissal, and guarded rejection", () => {
  assert.match(groupSwitcher, /focusMenuItem\(menuRef\.current, "selected"\)/);
  assert.match(groupSwitcher, /handleMenuKeyDown\(/);
  assert.match(menuKeyboard, /case "ArrowDown"/);
  assert.match(menuKeyboard, /case "ArrowUp"/);
  assert.match(menuKeyboard, /case "Home"/);
  assert.match(menuKeyboard, /case "End"/);
  assert.match(menuKeyboard, /event\.key === "Escape"/);
  assert.match(menuKeyboard, /event\.key === "Tab"/);
  assert.match(groupSwitcher, /triggerRef\.current\?\.focus\(\)/);
  assert.match(groupSwitcher, /if \(!select\(g\.id\)\) event\.currentTarget\.focus\(\)/);
});

test("user menu has a controlled menu role and skips disabled items", () => {
  assert.match(authenticatedApp, /const USER_MENU_TRIGGER_ID = "user-menu-trigger"/);
  assert.match(authenticatedApp, /const USER_MENU_ID = "user-menu"/);
  assert.match(authenticatedApp, /aria-haspopup="menu"/);
  assert.match(authenticatedApp, /aria-controls=\{USER_MENU_ID\}/);
  assert.match(authenticatedApp, /id=\{USER_MENU_ID\}[\s\S]*role="menu"/);
  assert.match(authenticatedApp, /role="menuitem"/);
  assert.match(authenticatedApp, /focusMenuItem\(userMenuPopupRef\.current, "first"\)/);
  assert.match(authenticatedApp, /handleMenuKeyDown\(/);
  assert.match(authenticatedApp, /userAvatarButtonRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(authenticatedApp, /header-install-button/);
});

test("group dialogs use the shared stacked modal boundary and protected close", () => {
  for (const source of [createGroupDialog, groupSettings]) {
    assert.match(source, /useModalFocusBoundary/);
    assert.match(source, /data-modal-layer/);
    assert.match(source, /role="dialog"/);
    assert.match(source, /aria-modal="true"/);
    assert.match(source, /aria-labelledby=/);
    assert.match(source, /tabIndex=\{-1\}/);
  }

  assert.match(createGroupDialog, /if \(loading\) return/);
  assert.match(groupSettings, /const mutationPending =/);
  assert.match(groupSettings, /if \(mutationPending\) return/);
});

test("group dialogs remain bounded at 320px, 390px, and 200% zoom", () => {
  assert.match(
    styles,
    /\.dialog-overlay\s*\{[^}]*overflow-y:\s*auto[^}]*\}/s,
  );
  assert.match(
    styles,
    /\.add-admin-dialog\s*\{[^}]*width:\s*min\(360px,\s*100%\)[^}]*max-height:\s*calc\(100dvh - 32px\)[^}]*overflow-y:\s*auto[^}]*\}/s,
  );
  assert.match(
    styles,
    /\.group-settings-dialog\s*\{[^}]*width:\s*min\(560px,\s*100%\)[^}]*max-height:\s*calc\(100dvh - 32px\)[^}]*overflow-y:\s*auto[^}]*\}/s,
  );
  assert.match(styles, /\.group-add-row,\s*\.group-add-form\s*\{[^}]*min-width:\s*0/s);
  assert.match(styles, /\.group-add-input\s*\{[^}]*min-width:\s*0/s);
});
