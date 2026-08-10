import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settings = readFileSync(new URL("../components/settings/SettingsDialog.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
const photoApi = readFileSync(new URL("../services/photoApi.ts", import.meta.url), "utf8");
const headerCss = readFileSync(new URL("../authenticated.css", import.meta.url), "utf8");
const maintenanceState = readFileSync(new URL("./maintenanceTaskState.ts", import.meta.url), "utf8");

test("photo API keeps compatible signatures while forwarding abort and progress", () => {
  assert.match(photoApi, /backfillPhotoMetadata\([\s\S]*groupId = "",[\s\S]*options: PhotoMetadataBackfillOptions = \{\}/);
  assert.match(photoApi, /backfillThumbnails\([\s\S]*groupId = "",[\s\S]*options: ThumbnailBackfillOptions = \{\}/);
  assert.match(photoApi, /signal: options\.signal/);
  assert.match(photoApi, /options\.onProgress\?\.\(/);
  assert.match(photoApi, /fetchWithTimeout\([\s\S]*signal/);
  assert.match(photoApi, /getAuthGeneration/);
});

test("settings uses one controller and synchronous gate for both task kinds", () => {
  assert.match(settings, /useRef<MaintenanceTaskGate>/);
  assert.match(settings, /useRef<AbortController \| null>/);
  assert.match(settings, /beginMaintenanceTask/);
  assert.match(settings, /finishMaintenanceTask/);
  assert.match(settings, /runMaintenanceTask\("thumbnails"/);
  assert.match(settings, /runMaintenanceTask\("metadata"/);
  assert.ok((settings.match(/disabled=\{maintenanceActive\}/g) ?? []).length >= 2);
});

test("settings exposes progress, stop, protected close, unmount abort, and workspace drift", () => {
  assert.match(settings, /aria-live="polite"/);
  assert.match(settings, /role="status" aria-live="polite"/);
  assert.match(settings, /aria-busy=\{maintenanceActive && maintenanceTask\?\.kind === "thumbnails"\}/);
  assert.match(settings, /aria-busy=\{maintenanceActive && maintenanceTask\?\.kind === "metadata"\}/);
  assert.match(settings, /停止任务/);
  assert.match(settings, /controller\.abort/);
  assert.match(settings, /mountedRef/);
  assert.match(settings, /return \(\) => \{[\s\S]*mountedRef\.current = false;[\s\S]*maintenanceControllerRef\.current\?\.abort/);
  assert.match(settings, /onMaintenanceStateChangeRef\.current\?\.\(\{[\s\S]*type: "stop"/);
  assert.match(settings, /handleProtectedClose/);
  assert.match(settings, /currentGroupId[\s\S]*workspaceId/);
  assert.match(settings, /工作空间已变更/);
  assert.match(settings, /onMaintenanceStateChange\?: \(event: MaintenanceTaskEvent\) => void/);
});

test("authenticated app folds maintenance into tab, group, unload, PWA, and banner guards", () => {
  assert.match(app, /reduceMaintenanceTaskEvent/);
  assert.match(app, /onMaintenanceStateChange=\{handleMaintenanceStateChange\}/);
  assert.match(app, /const transferring =[\s\S]*isMaintenanceTaskActive\(maintenanceTask\)/);
  assert.match(app, /const switchTab = \(tab: ViewTab\) => \{[\s\S]*blockIfTransferring\(\)/);
  assert.match(app, /<GroupSwitcher[\s\S]*disabled=\{transferring\}/);
  assert.match(app, /window\.addEventListener\("beforeunload", onBeforeUnload\)/);
  assert.match(app, /activatePwaUpdate\(window as PwaUpdateBrowserWindow, \{ transferring \}\)/);
  assert.match(app, /getMaintenanceGuardMessage\(maintenanceTask\)/);
  assert.match(app, /getMaintenanceBannerText\(maintenanceTask\)/);
  assert.match(maintenanceState, /state\.processed/);
  assert.match(maintenanceState, /state\.changed/);
  assert.match(maintenanceState, /state\.failed/);
});

test("authenticated Header still has no install entry marker or CSS", () => {
  assert.doesNotMatch(app, /header-install-button|顶部安装/);
  assert.doesNotMatch(headerCss, /\.header-install-button/);
});
