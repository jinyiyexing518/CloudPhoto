import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyGlobalFileIntent,
} from "./globalFileIntentEligibility.ts";

const appSource = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../authenticated.css", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return appSource.slice(start, end);
}

function target(selectorMatch = false) {
  return {
    closest(selector) {
      for (const required of [
        "input",
        "textarea",
        "select",
        "button",
        "a[href]",
        "contenteditable",
        'role="button"',
      ]) {
        assert.ok(selector.includes(required), `missing shared interactive selector: ${required}`);
      }
      return selectorMatch ? this : null;
    },
  };
}

const noModal = { querySelector: () => null };
const openModal = {
  querySelector(selector) {
    assert.equal(selector, '[aria-modal="true"]');
    return {};
  },
};

function classify(overrides = {}) {
  return classifyGlobalFileIntent({
    hasFileIntent: true,
    target: target(false),
    modalRoot: noModal,
    transferring: false,
    ignoreInteractiveTarget: true,
    ...overrides,
  });
}

test("pure file-intent policy distinguishes empty, editor/modal, transfer, and accept", () => {
  assert.equal(classify({ hasFileIntent: false }), "ignore-no-files");
  assert.equal(classify({ target: target(true) }), "ignore-editor-or-modal");
  assert.equal(classify({ modalRoot: openModal }), "ignore-editor-or-modal");
  assert.equal(classify({ transferring: true }), "block-transfer");
  assert.equal(classify(), "accept");
});

test("drag policy can ignore editor targets while retaining the shared modal boundary", () => {
  assert.equal(classify({
    target: target(true),
    ignoreInteractiveTarget: false,
  }), "accept");
  assert.equal(classify({
    modalRoot: openModal,
    ignoreInteractiveTarget: false,
  }), "ignore-editor-or-modal");
});

test("AuthenticatedApp paste uses latest full activity and reports only the real upload result", () => {
  const pasteSource = sourceBetween("const onPaste =", 'window.addEventListener("paste"');
  assert.match(appSource, /transferringRef\.current = transferring/);
  assert.match(appSource, /transferGuardMessageRef\.current = transferGuardMessage/);
  assert.match(pasteSource, /imageItem[\s\S]*getAsFile\(\)[\s\S]*classifyGlobalFileIntent/);
  assert.match(pasteSource, /classifyGlobalFileIntent\(\{[\s\S]*target: document\.activeElement[\s\S]*modalRoot: document[\s\S]*transferring: transferringRef\.current[\s\S]*ignoreInteractiveTarget: true/);
  assert.match(pasteSource, /pasteDecision === "ignore-editor-or-modal"[\s\S]*return/);
  assert.match(pasteSource, /pasteDecision === "block-transfer"[\s\S]*preventDefault\(\)[\s\S]*transferGuardMessageRef\.current/);
  assert.match(pasteSource, /pasteDecision !== "accept"[\s\S]*return[\s\S]*preventDefault\(\)[\s\S]*uploadToFolderRef\.current\?\.\(dt\.files, ""\)/);
  assert.equal((pasteSource.match(/uploadToFolderRef\.current\?\.\(dt\.files, ""\)/g) ?? []).length, 1);
  assert.doesNotMatch(appSource, /粘贴上传/);
  assert.doesNotMatch(pasteSource, /batchMutationActiveRef\.current/);
});

test("all transferring activities feed the synchronous global intent ref", () => {
  for (const activity of [
    /uploadProgress !== null/,
    /downloading/,
    /deleteProgress !== null/,
    /voiceTransferState !== "idle"/,
    /activeBatchMutation !== null/,
    /isTrashMutationActive\(trashMutation\)/,
    /isMaintenanceTaskActive\(maintenanceTask\)/,
  ]) {
    assert.match(appSource, new RegExp(`const transferring =[\\s\\S]*${activity.source}[\\s\\S]*transferringRef\\.current = transferring`));
  }
});

test("global file drag prevents navigation but blocks overlay and tab changes behind modal or activity", () => {
  assert.match(appSource, /const onDragOver =[\s\S]*types\.includes\("Files"\)[\s\S]*preventDefault\(\)/);
  assert.match(appSource, /const onDragEnter =[\s\S]*classifyGlobalFileIntent[\s\S]*dragDecision !== "accept"[\s\S]*stopPropagation\(\)[\s\S]*enterCount = 0[\s\S]*setIsDragOver\(false\)/);
  assert.match(appSource, /const onDragOver =[\s\S]*dragDecision !== "accept"[\s\S]*stopPropagation\(\)/);
  assert.match(appSource, /const onDrop =[\s\S]*preventDefault\(\)[\s\S]*classifyGlobalFileIntent/);
  assert.match(appSource, /dropDecision === "ignore-editor-or-modal"[\s\S]*请先关闭弹窗/);
  assert.match(appSource, /dropDecision === "block-transfer"[\s\S]*transferGuardMessageRef\.current/);
  assert.match(appSource, /dropDecision !== "accept"[\s\S]*stopPropagation\(\)[\s\S]*return[\s\S]*activeTabRef\.current !== "folder"[\s\S]*switchTab\("folder"\)/);
  assert.match(appSource, /addEventListener\("dragenter", onDragEnter, true\)/);
  assert.match(appSource, /addEventListener\("dragover", onDragOver, true\)/);
  assert.match(appSource, /addEventListener\("drop", onDrop, true\)/);
  assert.match(appSource, /const onDragLeave =[\s\S]*enterCount = Math\.max\(0, enterCount - 1\)[\s\S]*setIsDragOver\(false\)/);
  assert.match(appSource, /if \(window\.matchMedia\("\(hover: none\)"\)\.matches\) return/);
});

test("normal drag remains navigation-only and the authenticated Header install marker stays absent", () => {
  const dropSource = sourceBetween("const onDrop =", 'window.addEventListener("dragenter"');
  assert.doesNotMatch(dropSource, /uploadToFolderRef/);
  assert.match(dropSource, /已切换到文件夹视图，选择文件夹后上传/);
  assert.doesNotMatch(appSource, /header-install-button|顶部安装/);
  assert.doesNotMatch(stylesSource, /\.header-install-button/);
});
