import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const authenticatedApp = read("../../AuthenticatedApp.tsx");
const addAdminDialog = read("./AddAdminDialog.tsx");
const shortcutsHelpDialog = read("./ShortcutsHelpDialog.tsx");
const installGuideDialog = read("./InstallGuideDialog.tsx");

test("user-menu dialogs restore through the connected avatar trigger", () => {
  assert.match(authenticatedApp, /import ShortcutsHelpDialog from "\.\/components\/auth\/ShortcutsHelpDialog"/);
  assert.match(authenticatedApp, /import InstallGuideDialog from "\.\/components\/auth\/InstallGuideDialog"/);
  assert.match(
    authenticatedApp,
    /closeUserMenu\(true\);[\s\S]*?setShowShortcutsHelp\(true\)/,
  );
  assert.match(
    authenticatedApp,
    /closeUserMenu\(true\);[\s\S]*?setShowAddAdmin\(true\)/,
  );
  assert.match(authenticatedApp, /<ShortcutsHelpDialog[\s\S]*onClose=/);
  assert.match(authenticatedApp, /<InstallGuideDialog[\s\S]*onClose=/);
  assert.doesNotMatch(
    authenticatedApp,
    /showShortcutsHelp && \(\s*<div className="dialog-overlay"/,
  );
  assert.doesNotMatch(
    authenticatedApp,
    /showInstallGuide && \(\s*<div className="dialog-overlay"/,
  );
  assert.match(
    authenticatedApp,
    /closeUserMenu\(true\);\s*void handleInstallApp\(userAvatarButtonRef\.current\)/,
  );
  assert.match(authenticatedApp, /<InstallGuideDialog[\s\S]*restoreFocusTo=\{installGuideRestoreFocusRef\.current\}/);
});

test("add-admin uses the shared stacked boundary with protected dismissal", () => {
  assert.match(addAdminDialog, /createPortal\(/);
  assert.match(addAdminDialog, /useModalFocusBoundary/);
  assert.match(addAdminDialog, /data-modal-layer/);
  assert.match(addAdminDialog, /role="dialog"/);
  assert.match(addAdminDialog, /aria-modal="true"/);
  assert.match(addAdminDialog, /aria-labelledby="add-admin-dialog-title"/);
  assert.match(addAdminDialog, /aria-describedby="add-admin-dialog-description"/);
  assert.match(addAdminDialog, /initialFocusRef: usernameInputRef/);
  assert.match(addAdminDialog, /if \(loading\) return/);
  assert.match(addAdminDialog, /if \(loading\) return false/);
  assert.match(addAdminDialog, /role="alert"[\s\S]*tabIndex=\{-1\}/);
  assert.match(addAdminDialog, /errorRef\.current\?\.focus\(\)/);
});

test("shortcut help is a body-level stacked modal layer", () => {
  assert.match(shortcutsHelpDialog, /createPortal\(/);
  assert.match(shortcutsHelpDialog, /useModalFocusBoundary/);
  assert.match(shortcutsHelpDialog, /role="dialog"/);
  assert.match(shortcutsHelpDialog, /aria-labelledby="shortcuts-help-title"/);
  assert.match(shortcutsHelpDialog, /aria-describedby="shortcuts-help-description"/);
});

test("install guidance is a body-level stacked modal without changing login guidance", () => {
  assert.match(installGuideDialog, /createPortal\(/);
  assert.match(installGuideDialog, /useModalFocusBoundary/);
  assert.match(installGuideDialog, /role="dialog"/);
  assert.match(installGuideDialog, /aria-labelledby="install-guide-dialog-title"/);
  assert.match(
    installGuideDialog,
    /aria-describedby="install-guide-dialog-description install-guide-dialog-note"/,
  );
  assert.doesNotMatch(authenticatedApp, /header-install-button/);
});
