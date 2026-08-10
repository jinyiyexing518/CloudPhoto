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

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert(match, `missing CSS block for ${selector}`);
  return match[1];
}

function hexDeclaration(block, property) {
  const match = block.match(new RegExp(`${property}\\s*:[^;#]*(#[0-9a-f]{6})`, "i"));
  assert(match, `missing ${property} hex color`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((index) => (
    Number.parseInt(hex.slice(index, index + 2), 16) / 255
  )).map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

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

test("header auto-hide reveals focused triggers and respects menu and dialog locks", () => {
  assert.match(authenticatedApp, /const revealHeader = useCallback\(\(\) => setHeaderHidden\(false\), \[\]\)/);
  assert.match(
    authenticatedApp,
    /<header className="app-header" ref=\{headerRef\} onFocusCapture=\{revealHeader\}>/,
  );
  assert.match(authenticatedApp, /headerRef\.current\?\.contains\(document\.activeElement\)/);
  assert.match(authenticatedApp, /headerMenuOpen:\s*userMenuOpen \|\| groupMenuOpen/);
  assert.match(authenticatedApp, /headerDialogActive:\s*userMenuDialogActive \|\| groupDialogOpen/);
  assert.match(authenticatedApp, /onMenuOpenChange=\{setGroupMenuOpen\}/);
  assert.match(authenticatedApp, /onDialogOpenChange=\{setGroupDialogOpen\}/);
  assert.match(groupSwitcher, /onMenuOpenChange\?\.\(open\)/);
  assert.match(groupSwitcher, /onDialogOpenChange\?\.\(showCreate \|\| settingsGroupId !== null\)/);
  assert.match(styles, /\.header-pinned \.app-header[\s\S]*transition-duration:\s*0s/);
  assert.match(styles, /\.app-header:focus-within[\s\S]*transition-duration:\s*0s/);
});

test("user-menu dialogs remain pinned through shared focus restoration", () => {
  assert.match(
    authenticatedApp,
    /closeUserMenu\(true\);\s*lockHeaderForUserMenuDialog\(\);\s*setShowShortcutsHelp\(true\)/,
  );
  assert.match(
    authenticatedApp,
    /closeUserMenu\(true\);\s*lockHeaderForUserMenuDialog\(\);\s*setShowAddAdmin\(true\)/,
  );
  assert.match(
    authenticatedApp,
    /settingsRestoreFocusRef\.current = userAvatarButtonRef\.current;[\s\S]*lockHeaderForUserMenuDialog\(\)/,
  );
  assert.match(authenticatedApp, /releaseUserMenuDialogLock/);
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

test("group menu text, icons, and focus indicators meet contrast thresholds", () => {
  const trigger = cssBlock(".group-switcher-btn");
  assert.ok(
    contrastRatio(
      hexDeclaration(trigger, "color"),
      hexDeclaration(trigger, "background"),
    ) >= 4.5,
    "group trigger text must meet 4.5:1",
  );

  const activeItem = cssBlock(".group-dropdown-item.active");
  const activeBackground = hexDeclaration(activeItem, "background");
  assert.ok(
    contrastRatio(hexDeclaration(activeItem, "color"), activeBackground) >= 4.5,
    "selected workspace text must meet 4.5:1",
  );

  assert.ok(
    contrastRatio(
      hexDeclaration(cssBlock(".group-settings-btn"), "color"),
      activeBackground,
    ) >= 3,
    "settings icon must meet 3:1 against the active row",
  );

  assert.ok(
    contrastRatio(
      hexDeclaration(cssBlock(".group-dropdown-loading"), "color"),
      "#ffffff",
    ) >= 4.5,
    "loading text must meet 4.5:1",
  );

  const focusBlock = styles.match(
    /\.group-dropdown-item:focus-visible,[\s\S]*?\.group-dropdown-error:focus-visible\s*\{([^}]+)\}/,
  )?.[1];
  assert(focusBlock, "missing group menu focus-visible block");
  assert.ok(
    contrastRatio(
      hexDeclaration(focusBlock, "outline"),
      hexDeclaration(focusBlock, "background"),
    ) >= 3,
    "focus indicator must meet 3:1",
  );
});
