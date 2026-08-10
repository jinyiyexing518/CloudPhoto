import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const trash = readFileSync(new URL("../components/gallery/TrashView.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../components/settings/SettingsDialog.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
const photoApi = readFileSync(new URL("../services/photoApi.ts", import.meta.url), "utf8");
const headerCss = readFileSync(new URL("../authenticated.css", import.meta.url), "utf8");

test("trash photo APIs remain compatible and forward optional AbortSignal", () => {
  assert.match(photoApi, /restorePhoto\(name: string, signal\?: AbortSignal\)/);
  assert.match(photoApi, /permanentlyDeletePhoto\(name: string, signal\?: AbortSignal\)/);
  assert.ok((photoApi.match(/signal \}/g) ?? []).length >= 2);
});

test("TrashView routes every mutation through one gate and abortable runner", () => {
  assert.match(trash, /useRef<TrashMutationGate>/);
  assert.match(trash, /runTrashMutationBoundary/);
  assert.match(trash, /useRef<AbortController \| null>/);
  for (const kind of [
    "item-restore",
    "item-delete",
    "restore-all",
    "empty-trash",
    "restore-folder",
    "delete-folder",
  ]) {
    assert.match(trash, new RegExp(`"${kind}"`));
  }
  assert.match(trash, /const snapshot = \[\.\.\./);
  assert.match(trash, /controller\.signal/);
  assert.match(trash, /mountedRef/);
  assert.match(trash, /workspaceId/);
  assert.match(trash, /工作空间已变更/);
  assert.match(trash, /beforeFinish: async/);
  assert.match(trash, /result\.stopped \|\| result\.done > result\.failed/);
});

test("desktop, folder, card, and sticky mutation controls are truly disabled", () => {
  for (const className of [
    "trash-restore-all-btn",
    "trash-empty-all-btn",
    "trash-folder-restore-btn",
    "trash-folder-delete-btn",
    "trash-restore-btn",
    "trash-delete-btn",
  ]) {
    const button = new RegExp(`<button[\\s\\S]{0,180}className="${className}"[\\s\\S]{0,240}disabled=\\{mutationActive\\}`);
    assert.match(trash, button);
  }
  assert.ok((trash.match(/className="trash-restore-all-btn"[\s\S]{0,180}disabled=\{mutationActive\}/g) ?? []).length >= 2);
  assert.ok((trash.match(/className="trash-empty-all-btn"[\s\S]{0,180}disabled=\{mutationActive\}/g) ?? []).length >= 2);
});

test("TrashView exposes live progress and a semantic stop button", () => {
  assert.match(trash, /role="status" aria-live="polite"/);
  assert.match(trash, /停止任务/);
  assert.match(trash, /type="button"/);
  assert.match(trash, /disabled=\{trashMutation\?\.phase === "stopping"\}/);
});

test("Settings composes trash activity with maintenance close and task guards", () => {
  assert.match(settings, /onTrashMutationStateChange\?: \(event: TrashMutationEvent\) => void/);
  assert.match(settings, /onMutationStateChange=\{handleTrashMutationStateChange\}/);
  assert.match(settings, /const settingsActivityActive = maintenanceActive \|\| trashMutationActive/);
  assert.match(settings, /if \(isTrashMutationActive\(trashMutationRef\.current\)\)[\s\S]*请先点击“停止任务”/);
  assert.ok((settings.match(/disabled=\{settingsActivityActive\}/g) ?? []).length >= 6);
  assert.match(settings, /blocked=\{maintenanceActive\}/);
});

test("authenticated shell protects navigation, unload, group switch, PWA, and prioritizes trash banner", () => {
  assert.match(app, /reduceTrashMutationEvent/);
  assert.match(app, /onTrashMutationStateChange=\{handleTrashMutationStateChange\}/);
  assert.match(app, /const transferring =[\s\S]*isTrashMutationActive\(trashMutation\)/);
  assert.match(app, /const transferGuardMessage = isTrashMutationActive\(trashMutation\)/);
  assert.match(app, /const switchTab = useCallback\(\(tab: ViewTab\) => \{[\s\S]*blockIfTransferring\(\)/);
  assert.match(app, /<GroupSwitcher[\s\S]*disabled=\{transferring\}/);
  assert.match(app, /window\.addEventListener\("beforeunload", onBeforeUnload\)/);
  assert.match(app, /setDangerousOperationActivity\(\s*"authenticated-app",\s*transferring/);
  assert.match(app, /activatePwaUpdate\(window as PwaUpdateBrowserWindow\)/);
  assert.match(app, /isTrashMutationActive\(trashMutation\) && trashMutation \? \(/);
  assert.match(app, /getTrashMutationBannerText\(trashMutation\)/);
  assert.match(app, /getTrashMutationPercent\(trashMutation\)/);
});

test("authenticated Header install marker and CSS remain absent", () => {
  assert.doesNotMatch(app, /header-install-button|顶部安装/);
  assert.doesNotMatch(headerCss, /\.header-install-button/);
});
