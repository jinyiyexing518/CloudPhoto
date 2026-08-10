import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  WORKSPACE_TAB_ORDER,
  activateWorkspaceTabWithFocus,
  getWorkspaceTabFromKey,
  isWorkspaceTab,
} from "./workspaceTabs.ts";

const appSource = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../authenticated.css", import.meta.url), "utf8");
const modalBoundarySource = readFileSync(
  new URL("../components/shared/useModalFocusBoundary.ts", import.meta.url),
  "utf8",
);
const shortcutsDialogSource = readFileSync(
  new URL("../components/auth/ShortcutsHelpDialog.tsx", import.meta.url),
  "utf8",
);
const installGuideDialogSource = readFileSync(
  new URL("../components/auth/InstallGuideDialog.tsx", import.meta.url),
  "utf8",
);

function cssBlocks(selector) {
  const blocks = [];
  for (const match of stylesSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((candidate) => candidate.trim());
    if (selectors.includes(selector)) blocks.push(match[2]);
  }
  assert(blocks.length > 0, `missing CSS block for ${selector}`);
  return blocks;
}

function declaredHex(block, property) {
  const match = block.match(new RegExp(`${property}\\s*:[^;#]*(#[0-9a-f]{6})`, "i"));
  return match?.[1] ?? null;
}

function resolvedDeclaration(selectors, property) {
  let value = null;
  for (const selector of selectors) {
    for (const block of cssBlocks(selector)) {
      const match = block.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i"));
      value = match?.[1].trim() ?? value;
    }
  }
  assert(value, `missing resolved ${property} for ${selectors.join(", ")}`);
  return value;
}

function resolvedHex(selectors, property, fallback) {
  let value = fallback;
  for (const selector of selectors) {
    for (const block of cssBlocks(selector)) {
      value = declaredHex(block, property) ?? value;
    }
  }
  assert(value, `missing resolved ${property} hex color for ${selectors.join(", ")}`);
  return value;
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

test("arrow, Home, and End navigation follows the six-tab automatic activation order", () => {
  assert.deepEqual(WORKSPACE_TAB_ORDER, [
    "timeline",
    "folder",
    "moments",
    "map",
    "capsule",
    "story",
  ]);
  assert.equal(getWorkspaceTabFromKey("timeline", "ArrowRight"), "folder");
  assert.equal(getWorkspaceTabFromKey("timeline", "ArrowLeft"), "story");
  assert.equal(getWorkspaceTabFromKey("story", "ArrowRight"), "timeline");
  assert.equal(getWorkspaceTabFromKey("folder", "Home"), "timeline");
  assert.equal(getWorkspaceTabFromKey("folder", "End"), "story");
  assert.equal(getWorkspaceTabFromKey("folder", "Enter"), null);
});

test("persisted restoration accepts every supported tab and rejects stale values", () => {
  for (const tab of WORKSPACE_TAB_ORDER) assert.equal(isWorkspaceTab(tab), true);
  assert.equal(isWorkspaceTab("trash"), false);
  assert.equal(isWorkspaceTab(null), false);
});

test("rejected activation restores focus to the selected tab", () => {
  const focused = [];
  assert.equal(
    activateWorkspaceTabWithFocus("timeline", "folder", () => false, (tab) => focused.push(tab)),
    false,
  );
  assert.deepEqual(focused, ["timeline"]);

  assert.equal(
    activateWorkspaceTabWithFocus("timeline", "folder", () => true, (tab) => focused.push(tab)),
    true,
  );
  assert.deepEqual(focused, ["timeline", "folder"]);
});

test("AuthenticatedApp exposes a labelled tablist, roving tabs, and linked tabpanels", () => {
  assert.match(appSource, /role="tablist"[\s\S]*aria-label="工作区主视图"/);
  assert.match(appSource, /role="tab"[\s\S]*aria-selected=\{activeTab === tab\}[\s\S]*tabIndex=\{activeTab === tab \? 0 : -1\}/);
  assert.match(appSource, /id=\{workspaceTabId\(tab\)\}[\s\S]*aria-controls=\{workspaceTabPanelId\(tab\)\}/);
  assert.match(appSource, /role="tabpanel"/);
  assert.equal((appSource.match(/role="tabpanel"/g) ?? []).length, 6);
  for (const tab of WORKSPACE_TAB_ORDER) {
    assert.match(appSource, new RegExp(`id=\\{workspaceTabPanelId\\("${tab}"\\)\\}`));
    assert.match(appSource, new RegExp(`aria-labelledby=\\{workspaceTabId\\("${tab}"\\)\\}`));
  }
  assert.match(appSource, /tabIndex=\{activeTab ===/);
  assert.match(appSource, /hidden=\{activeTab !==/);
  assert.match(appSource, /aria-hidden="true"[\s\S]*view-tab-count/);
});

test("tab activation stays behind modal and transfer guards and keeps mobile focus visible", () => {
  assert.match(appSource, /const activateWorkspaceTab =[\s\S]*hasOpenAriaModal\(document\)[\s\S]*activateWorkspaceTabWithFocus/);
  assert.match(appSource, /activateWorkspaceTabWithFocus\([\s\S]*switchTab[\s\S]*focusWorkspaceTab/);
  assert.match(appSource, /const switchTab = useCallback[\s\S]*activeTabRef\.current[\s\S]*blockIfTransferring\(\)[\s\S]*setActiveTab\(tab\)/);
  assert.equal((appSource.match(/setActiveTab\(/g) ?? []).length, 1);
  assert.match(appSource, /onKeyDown=\{\(event\) => handleWorkspaceTabKeyDown\(event, tab\)\}/);
  assert.match(appSource, /<ShortcutsHelpDialog[\s\S]*<InstallGuideDialog/);
  assert.match(shortcutsDialogSource, /useModalFocusBoundary\(\{/);
  assert.match(installGuideDialogSource, /useModalFocusBoundary\(\{[\s\S]*restoreFocusTo/);
  assert.match(modalBoundarySource, /event\.stopImmediatePropagation\(\)/);
  assert.match(modalBoundarySource, /previousFocusRef\.current = restoreFocusTo/);
  assert.match(appSource, /openShortcutsFromUserMenu[\s\S]*closeUserMenu\(true\)[\s\S]*setShowShortcutsHelp\(true\)/);
  assert.match(appSource, /handleInstallApp\(userAvatarButtonRef\.current\)/);
  assert.match(appSource, /closeSettingsForGuidance[\s\S]*setShowSettings\(false\)[\s\S]*setShowInstallGuide\(true\)/);
  assert.match(appSource, /result\.status === "prompted"[\s\S]*restoreFocus\(promptRestoreTarget\)/);
  assert.match(appSource, /scrollIntoView\(\{ block: "nearest", inline: "nearest"/);
  assert.doesNotMatch(appSource, /scrollTabToCenter/);
  assert.match(stylesSource, /\.view-tabs\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(stylesSource, /\.view-tab:focus-visible\s*\{[\s\S]*outline:/);
  assert.doesNotMatch(stylesSource, /(?:html|body)\s*(?:,\s*(?:html|body)\s*)?\{[^}]*overflow-x\s*:\s*(?:hidden|clip)/s);
});

test("workspace tab light palette meets text and focus contrast thresholds", () => {
  const pageBackground = "#ffffff";

  for (const [label, selectors] of [
    ["inactive tab", [".view-tab"]],
    ["hovered tab", [".view-tab", ".view-tab:hover"]],
    ["active tab", [".view-tab", ".view-tab.active"]],
    ["disabled tab", [".view-tab", ".view-tab:disabled"]],
  ]) {
    assert.ok(
      contrastRatio(
        resolvedHex(selectors, "color"),
        resolvedHex(selectors, "background", pageBackground),
      ) >= 4.5,
      `${label} text must meet 4.5:1`,
    );
  }

  for (const [label, selectors] of [
    ["inactive count", [".view-tab-count"]],
    ["active count", [".view-tab-count", ".view-tab.active .view-tab-count"]],
    ["hovered count", [".view-tab-count", ".view-tab:hover .view-tab-count"]],
    ["active hovered count", [
      ".view-tab-count",
      ".view-tab.active .view-tab-count",
      ".view-tab:hover .view-tab-count",
      ".view-tab.active:hover .view-tab-count",
    ]],
    ["disabled count", [".view-tab-count", ".view-tab:disabled .view-tab-count"]],
  ]) {
    assert.ok(
      contrastRatio(
        resolvedHex(selectors, "color"),
        resolvedHex(selectors, "background"),
      ) >= 4.5,
      `${label} text must meet 4.5:1`,
    );
  }

  const focusColor = resolvedHex([".view-tab:focus-visible"], "outline");
  assert.ok(contrastRatio(focusColor, pageBackground) >= 3, "focus ring must meet 3:1 on white");
  assert.ok(
    contrastRatio(
      focusColor,
      resolvedHex([".view-tab", ".view-tab.active"], "background"),
    ) >= 3,
    "focus ring must meet 3:1 on the active tab",
  );
  const inactiveWeight = resolvedDeclaration([".view-tab"], "font-weight");
  const activeWeight = resolvedDeclaration([".view-tab.active"], "font-weight");
  const inactiveBackground = resolvedHex([".view-tab"], "background", pageBackground);
  const activeBackground = resolvedHex([".view-tab", ".view-tab.active"], "background");
  const activeBorder = resolvedHex([".view-tab.active"], "border-bottom-color");
  assert.equal(activeWeight, "700");
  assert.notEqual(activeWeight, inactiveWeight);
  assert.notEqual(activeBackground, inactiveBackground);
  assert.ok(
    contrastRatio(activeBorder, activeBackground) >= 3,
    "active underline must meet 3:1 against the active background",
  );

  const disabled = cssBlocks(".view-tab:disabled")[0];
  assert.match(disabled, /cursor:\s*not-allowed/);
});
