import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  activatePwaUpdate,
  isPwaUpdateReady,
  markPwaUpdateReady,
  preparePwaUpdateForRefresh,
  PWA_UPDATE_READY_EVENT,
} from "./updatePolicy.ts";
import { setDangerousOperationActivity } from "./dangerousOperationGate.ts";

class FakePwaWindow extends EventTarget {}

test("persists update-ready state even when the event fired before listeners mounted", () => {
  const fakeWindow = new FakePwaWindow();

  markPwaUpdateReady(fakeWindow);

  assert.equal(isPwaUpdateReady(fakeWindow), true);
});

test("activates service worker only on explicit user path", async () => {
  const fakeWindow = new FakePwaWindow();
  const calls = [];
  fakeWindow.__CF_SW_REGISTRATION__ = {
    update: async () => {
      calls.push("update");
    },
    installing: null,
    waiting: null,
  };
  fakeWindow.__CF_HARD_REFRESH__ = () => {
    calls.push("refresh");
  };

  setDangerousOperationActivity("test", true, "uploading");
  assert.equal(await activatePwaUpdate(fakeWindow), "blocked-transferring");
  assert.deepEqual(calls, []);

  setDangerousOperationActivity("test", false, "");
  assert.equal(await activatePwaUpdate(fakeWindow), "updated");
  assert.deepEqual(calls, ["update", "refresh"]);
});

test("returns missing-updater when updater is unavailable", async () => {
  const fakeWindow = new FakePwaWindow();
  assert.equal(await activatePwaUpdate(fakeWindow), "missing-updater");
});

test("a stalled updater reports timeout without refreshing the stale client", async () => {
  const fakeWindow = new FakePwaWindow();
  let refreshes = 0;
  fakeWindow.__CF_SW_REGISTRATION__ = {
    update: async () => new Promise(() => {}),
    installing: null,
    waiting: null,
  };
  fakeWindow.__CF_HARD_REFRESH__ = () => {
    refreshes += 1;
  };

  assert.equal(await activatePwaUpdate(fakeWindow), "timed-out");
  assert.equal(refreshes, 0);
});

test("updates and explicitly activates a waiting worker before refresh", async () => {
  const fakeWindow = new FakePwaWindow();
  const serviceWorkerContainer = new EventTarget();
  const messages = [];
  const waitingWorker = {
    postMessage(message) {
      messages.push(message);
      queueMicrotask(() => {
        serviceWorkerContainer.dispatchEvent(new Event("controllerchange"));
      });
    },
  };
  fakeWindow.__CF_SW_CONTAINER__ = serviceWorkerContainer;
  fakeWindow.__CF_SW_REGISTRATION__ = {
    update: async () => fakeWindow.__CF_SW_REGISTRATION__,
    installing: null,
    waiting: waitingWorker,
  };

  assert.equal(await preparePwaUpdateForRefresh(fakeWindow), "ready");
  assert.deepEqual(messages, [{ type: "SKIP_WAITING" }]);
});

test("broadcasts update-ready event", () => {
  const fakeWindow = new FakePwaWindow();
  let notified = 0;
  fakeWindow.addEventListener(PWA_UPDATE_READY_EVENT, () => {
    notified += 1;
  });

  markPwaUpdateReady(fakeWindow);

  assert.equal(notified, 1);
});

test("main.tsx onNeedRefresh contract: no immediate activation or reload", () => {
  const source = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  assert.match(source, /onNeedRefresh\(\)\s*\{[\s\S]*__CF_PWA_UPDATE_READY__\s*=\s*true/);
  assert.match(source, /onNeedRefresh\(\)\s*\{[\s\S]*dispatchEvent\(new Event\(PWA_UPDATE_READY_EVENT\)\)/);
  assert.doesNotMatch(source, /onNeedRefresh\(\)\s*\{[\s\S]*updateSW\(true\)/);
  assert.doesNotMatch(source, /onNeedRefresh\(\)\s*\{[\s\S]*location\.reload/);
  assert.match(source, /onNeedReload\(\)\s*\{[\s\S]*__CF_PWA_UPDATE_READY__\s*=\s*true/);
});

test("authenticated update action contract: no fallback reload", () => {
  const source = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
  assert.match(source, /activatePwaUpdate\(/);
  assert.match(source, /setDangerousOperationActivity\(/);
  assert.match(source, /disabled=\{transferring\}/);
  assert.match(source, /传输完成后更新/);
  assert.match(source, /result === "timed-out"[\s\S]*更新超时[\s\S]*return;[\s\S]*setUpdateReady\(false\)/);
  assert.doesNotMatch(source, /handleRefreshToUpdate[\s\S]*window\.location\.reload/);
});

test("logged-out install entry exposes the existing explicit update path", () => {
  const source = readFileSync(new URL("./PwaInstallEntry.tsx", import.meta.url), "utf8");
  assert.match(source, /isPwaUpdateReady\(window as PwaUpdateBrowserWindow\)/);
  assert.match(
    source,
    /addEventListener\(PWA_UPDATE_READY_EVENT[\s\S]*isPwaUpdateReady\(window as PwaUpdateBrowserWindow\)[\s\S]*setUpdateReady\(true\)/,
  );
  assert.match(source, /removeEventListener\(PWA_UPDATE_READY_EVENT/);
  assert.match(source, /activatePwaUpdate\(window as PwaUpdateBrowserWindow\)/);
  assert.match(source, /立即更新/);
  assert.match(source, /更新服务暂不可用/);
  assert.match(source, /更新超时/);
  assert.match(source, /更新失败/);
  assert.match(source, /安装应用/);
  assert.doesNotMatch(source, /window\.location\.reload/);
});
