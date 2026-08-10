import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  activatePwaUpdate,
  isPwaUpdateReady,
  markPwaUpdateReady,
  PWA_UPDATE_READY_EVENT,
} from "./updatePolicy.ts";

class FakePwaWindow extends EventTarget {}

test("persists update-ready state even when the event fired before listeners mounted", () => {
  const fakeWindow = new FakePwaWindow();

  markPwaUpdateReady(fakeWindow);

  assert.equal(isPwaUpdateReady(fakeWindow), true);
});

test("activates service worker only on explicit user path", async () => {
  const fakeWindow = new FakePwaWindow();
  const calls = [];
  fakeWindow.__CF_UPDATE_SW__ = async (reloadPage) => {
    calls.push(reloadPage);
  };

  assert.equal(
    await activatePwaUpdate(fakeWindow, { transferring: true }),
    "blocked-transferring",
  );
  assert.deepEqual(calls, []);

  assert.equal(
    await activatePwaUpdate(fakeWindow, { transferring: false }),
    "updated",
  );
  assert.deepEqual(calls, [true]);
});

test("returns missing-updater when updater is unavailable", async () => {
  const fakeWindow = new FakePwaWindow();
  assert.equal(
    await activatePwaUpdate(fakeWindow, { transferring: false }),
    "missing-updater",
  );
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
});

test("authenticated update action contract: no fallback reload", () => {
  const source = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
  assert.match(source, /activatePwaUpdate\(/);
  assert.match(source, /disabled=\{transferring\}/);
  assert.match(source, /传输完成后更新/);
  assert.doesNotMatch(source, /handleRefreshToUpdate[\s\S]*window\.location\.reload/);
});
