import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyDeploymentChunkFailure,
  consumeDeploymentRecoveryIntent,
  createDeploymentRecoveryCoordinator,
} from "./deploymentRecovery.ts";
import { preparePwaUpdateForRefresh } from "./updatePolicy.ts";

const OLD_FOLDER_CHUNK = "https://cloudphotos.top/assets/FolderView-5-M83veG.js";

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  values() {
    return [...this.#values.entries()];
  }
}

class FakePreloadErrorEvent extends Event {
  constructor(payload) {
    super("vite:preloadError", { cancelable: true });
    this.payload = payload;
  }
}

function createDangerousOperationGate(initialActive = false) {
  let snapshot = {
    active: initialActive,
    message: initialActive ? "上传进行中，请勿关闭页面" : "",
  };
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setActive(active) {
      snapshot = {
        active,
        message: active ? "上传进行中，请勿关闭页面" : "",
      };
      for (const listener of listeners) listener(snapshot);
    },
  };
}

function createFixture({
  active = false,
  buildId = "1397991e",
  online = true,
  storage = new MemoryStorage(),
  updater = true,
  onPrepare,
} = {}) {
  const target = new EventTarget();
  const gate = createDangerousOperationGate(active);
  const calls = {
    hardRefresh: 0,
    prepareUpdate: 0,
    intents: [],
  };
  let currentlyOnline = online;
  const coordinator = createDeploymentRecoveryCoordinator({
    target,
    storage,
    buildId,
    origin: "https://cloudphotos.top",
    isOnline: () => currentlyOnline,
    getDangerousOperationSnapshot: gate.getSnapshot,
    subscribeDangerousOperation: gate.subscribe,
    prepareUpdate: updater
      ? async () => {
        calls.prepareUpdate += 1;
        return await onPrepare?.();
      }
      : undefined,
    hardRefresh: () => {
      calls.hardRefresh += 1;
    },
    getNavigationIntent: () => ({ activeTab: "folder" }),
    saveNavigationIntent: (intent) => {
      calls.intents.push(intent);
    },
  });
  return {
    calls,
    coordinator,
    gate,
    storage,
    target,
    goOnline() {
      currentlyOnline = true;
      target.dispatchEvent(new Event("online"));
    },
  };
}

async function flushRecovery() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("classifies only same-origin content-hashed JS/CSS deployment chunks", () => {
  assert.deepEqual(
    classifyDeploymentChunkFailure(
      new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
      "https://cloudphotos.top",
    )?.kind,
    "js",
  );
  assert.deepEqual(
    classifyDeploymentChunkFailure(
      new Error("Unable to preload CSS for /assets/AuthenticatedApp-DPp4qXy9.css"),
      "https://cloudphotos.top",
    )?.kind,
    "css",
  );

  for (const error of [
    new Error("render failed"),
    new Error("Failed to fetch https://cloudphotos.top/api/photos"),
    new Error("GET https://cloudphotos.top/api/photos 500"),
    new Error("Failed to fetch dynamically imported module: https://evil.example/assets/FolderView-5-M83veG.js"),
    new Error("Failed to fetch dynamically imported module: https://cloudphotos.top/assets/FolderView.js"),
  ]) {
    assert.equal(
      classifyDeploymentChunkFailure(error, "https://cloudphotos.top"),
      null,
    );
  }
  assert.equal(
    classifyDeploymentChunkFailure(
      new TypeError("Importing a module script failed."),
      "https://cloudphotos.top",
    ),
    null,
    "URL-less Safari errors need trusted Vite event provenance",
  );
});

test("trusted Vite preload event recovers URL-less Safari module failures", async () => {
  const fixture = createFixture();
  const event = new FakePreloadErrorEvent(
    new TypeError("Importing a module script failed."),
  );

  fixture.target.dispatchEvent(event);
  await flushRecovery();

  assert.equal(event.defaultPrevented, true);
  assert.equal(fixture.calls.hardRefresh, 1);
});

test("old FolderView hash 404 performs one update-aware hard refresh", async () => {
  const fixture = createFixture();
  const first = new FakePreloadErrorEvent(
    new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
  );
  const duplicate = new FakePreloadErrorEvent(
    new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
  );

  fixture.target.dispatchEvent(first);
  fixture.target.dispatchEvent(duplicate);
  await flushRecovery();

  assert.equal(first.defaultPrevented, true);
  assert.equal(duplicate.defaultPrevented, true);
  assert.equal(fixture.calls.prepareUpdate, 1);
  assert.equal(fixture.calls.hardRefresh, 1);
  assert.deepEqual(fixture.calls.intents, [{ activeTab: "folder" }]);
  assert.equal(
    JSON.stringify(fixture.storage.values()).includes("FolderView"),
    false,
    "sessionStorage must not contain internal chunk names",
  );
  assert.equal(
    JSON.stringify(fixture.storage.values()).includes("cloudphotos.top"),
    false,
    "sessionStorage must not contain URLs",
  );
});

test("a timed-out worker preparation leaves stale-chunk recovery actionable without refreshing", async () => {
  const pwaWindow = new EventTarget();
  pwaWindow.__CF_SW_REGISTRATION__ = {
    update: async () => new Promise(() => {}),
    installing: null,
    waiting: null,
  };
  const fixture = createFixture({
    onPrepare: () => preparePwaUpdateForRefresh(pwaWindow),
  });

  fixture.target.dispatchEvent(new FakePreloadErrorEvent(
    new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
  ));
  await new Promise((resolve) => setTimeout(resolve, 1_650));

  assert.equal(fixture.calls.prepareUpdate, 1);
  assert.equal(fixture.calls.hardRefresh, 0);
  assert.equal(fixture.coordinator.getState().status, "exhausted");
  assert.equal(fixture.coordinator.getState().primaryActionLabel, "刷新新版");
});

test("missing updater still permits bounded stale-chunk hard refresh recovery", async () => {
  const fixture = createFixture({
    onPrepare: async () => "missing-updater",
  });

  fixture.target.dispatchEvent(new FakePreloadErrorEvent(
    new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
  ));
  await flushRecovery();

  assert.equal(fixture.calls.prepareUpdate, 1);
  assert.equal(fixture.calls.hardRefresh, 1);
});

test("active transfer blocks reload and resumes after the shared gate clears", async () => {
  const fixture = createFixture({ active: true });
  const event = new FakePreloadErrorEvent(
    new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
  );

  fixture.target.dispatchEvent(event);
  await flushRecovery();

  assert.equal(event.defaultPrevented, true);
  assert.equal(fixture.calls.hardRefresh, 0);
  assert.equal(fixture.coordinator.getState().status, "blocked-operation");
  assert.equal(
    fixture.coordinator.getState().message,
    "新版资源已发布，当前操作完成后刷新",
  );

  fixture.gate.setActive(false);
  await flushRecovery();

  assert.equal(fixture.calls.hardRefresh, 1);
});

test("a transfer that starts during worker activation blocks the final navigation", async () => {
  let blockOnce = true;
  let fixture;
  fixture = createFixture({
    onPrepare: () => {
      if (!blockOnce) return;
      blockOnce = false;
      fixture.gate.setActive(true);
    },
  });
  fixture.target.dispatchEvent(new FakePreloadErrorEvent(
    new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
  ));
  await flushRecovery();

  assert.equal(fixture.calls.hardRefresh, 0);
  assert.equal(fixture.coordinator.getState().status, "blocked-operation");

  fixture.gate.setActive(false);
  await flushRecovery();
  assert.equal(fixture.calls.hardRefresh, 1);
});

test("offline recovery waits for online and updater absence still allows a hard refresh", async () => {
  const fixture = createFixture({ online: false, updater: false });
  fixture.target.dispatchEvent(new FakePreloadErrorEvent(
    new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
  ));
  await flushRecovery();

  assert.equal(fixture.calls.hardRefresh, 0);
  assert.equal(fixture.coordinator.getState().status, "blocked-offline");

  fixture.goOnline();
  await flushRecovery();

  assert.equal(fixture.calls.prepareUpdate, 0);
  assert.equal(fixture.calls.hardRefresh, 1);
});

test("same chunk/build cannot auto-reload twice and leaves an actionable state", async () => {
  const storage = new MemoryStorage();
  const first = createFixture({ storage });
  first.target.dispatchEvent(new FakePreloadErrorEvent(
    new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
  ));
  await flushRecovery();
  assert.equal(first.calls.hardRefresh, 1);
  first.coordinator.dispose();

  const second = createFixture({ storage });
  second.target.dispatchEvent(new FakePreloadErrorEvent(
    new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
  ));
  await flushRecovery();

  assert.equal(second.calls.hardRefresh, 0);
  assert.equal(second.coordinator.getState().status, "exhausted");
  assert.equal(second.coordinator.getState().primaryActionLabel, "刷新新版");
  assert.equal(second.coordinator.getState().secondaryActionLabel, "稍后重试");
});

test("URL-less Safari failures get one recovery for each distinct build", async () => {
  const storage = new MemoryStorage();
  const first = createFixture({ buildId: "build-a", storage });
  first.target.dispatchEvent(new FakePreloadErrorEvent(
    new TypeError("Importing a module script failed."),
  ));
  await flushRecovery();
  assert.equal(first.calls.hardRefresh, 1);
  first.coordinator.dispose();

  const second = createFixture({ buildId: "build-b", storage });
  second.target.dispatchEvent(new FakePreloadErrorEvent(
    new TypeError("Importing a module script failed."),
  ));
  await flushRecovery();
  assert.equal(second.calls.hardRefresh, 1);
});

test("blocked session storage never permits an unbounded automatic refresh", async () => {
  const storage = new MemoryStorage();
  storage.setItem = () => {
    throw new DOMException("Storage blocked", "SecurityError");
  };
  const fixture = createFixture({ storage });

  fixture.target.dispatchEvent(new FakePreloadErrorEvent(
    new TypeError(`Failed to fetch dynamically imported module: ${OLD_FOLDER_CHUNK}`),
  ));
  await flushRecovery();

  assert.equal(fixture.calls.hardRefresh, 0);
  assert.equal(fixture.coordinator.getState().status, "exhausted");
  assert.equal(fixture.coordinator.getState().primaryActionLabel, "刷新新版");
});

test("blocked sessionStorage getter fails closed before React startup", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new DOMException("Storage blocked", "SecurityError");
    },
  });
  try {
    assert.doesNotThrow(() => consumeDeploymentRecoveryIntent());
    assert.equal(consumeDeploymentRecoveryIntent(), null);
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete globalThis.sessionStorage;
  }
});

test("blocked storage removal cannot escape recovery intent consumption", () => {
  const blocked = {
    getItem() {
      throw new DOMException("Storage blocked", "SecurityError");
    },
    removeItem() {
      throw new DOMException("Storage blocked", "SecurityError");
    },
  };
  assert.doesNotThrow(() => consumeDeploymentRecoveryIntent(blocked));
  assert.equal(consumeDeploymentRecoveryIntent(blocked), null);
});

test("recovery intent restores only an allowlisted tab and never stores workspace or tokens", () => {
  const storage = new MemoryStorage();
  storage.setItem("cf_deployment_recovery_intent_v1", JSON.stringify({
    activeTab: "timeline",
    workspaceId: "private-group-id",
    sas: "sig=secret",
  }));

  assert.deepEqual(consumeDeploymentRecoveryIntent(storage), { activeTab: "timeline" });
  assert.equal(storage.getItem("cf_deployment_recovery_intent_v1"), null);

  storage.setItem("cf_deployment_recovery_intent_v1", JSON.stringify({
    activeTab: "https://cloudphotos.top/assets/FolderView-5-M83veG.js",
  }));
  assert.equal(consumeDeploymentRecoveryIntent(storage), null);
});

test("untrusted business and API failures are not prevented or reloaded", async () => {
  const fixture = createFixture();
  for (const payload of [
    new Error("组件渲染失败"),
    new Error("GET https://cloudphotos.top/api/photos 500"),
    new TypeError("Failed to fetch"),
  ]) {
    const event = new FakePreloadErrorEvent(payload);
    fixture.target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  await flushRecovery();
  assert.equal(fixture.calls.hardRefresh, 0);
});

test("startup and panel contracts install recovery before React and isolate lazy tabs", () => {
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const authenticated = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
  const boundary = readFileSync(new URL("../components/shared/ErrorBoundary.tsx", import.meta.url), "utf8");

  assert.ok(
    main.indexOf("installDeploymentRecovery(") < main.indexOf("ReactDOM.createRoot("),
    "Vite preload recovery must be installed before React starts",
  );
  assert.match(app, /reportLazyBoundaryFailure/);
  assert.match(app, /label="照片空间"[\s\S]*recovery/);
  assert.match(app, /label="登录与注册"[\s\S]*recovery/);
  assert.match(authenticated, /key=\{`timeline:/);
  assert.match(authenticated, /key=\{`folder:/);
  assert.match(authenticated, /key=\{`map:/);
  for (const panel of ["timeline", "moments", "folder"]) {
    assert.match(
      authenticated,
      new RegExp(
        `workspaceTabPanelId\\("${panel}"\\)[\\s\\S]*?hidden=\\{activeTab !== "${panel}"\\}[\\s\\S]*?<ErrorBoundary[\\s\\S]*?key=\\{\\\`${panel}:`,
      ),
      `${panel} visibility wrapper must also hide its boundary fallback`,
    );
  }
  for (const label of ["管理员设置", "设置", "邀请", "版本更新"]) {
    assert.match(
      authenticated,
      new RegExp(`<AuxiliaryLazyBoundary label="${label}">[\\s\\S]*?<Suspense`),
      `${label} lazy failure must not unmount the authenticated shell`,
    );
  }
  assert.doesNotMatch(authenticated, /<ErrorBoundary label="main">/);
  for (const activity of [
    "uploadProgress !== null",
    "downloading",
    "deleteProgress !== null",
    'voiceTransferState !== "idle"',
    "activeBatchMutation !== null",
    "isTrashMutationActive(trashMutation)",
    "isMaintenanceTaskActive(maintenanceTask)",
    "folderRenameOperation !== null",
  ]) {
    assert.ok(authenticated.includes(activity), `shared dangerous-operation fact must include ${activity}`);
  }
  assert.doesNotMatch(boundary, /\{error\.message\s*\|\|/);
  assert.match(boundary, /aria-live=/);
  assert.match(boundary, /刷新新版/);
});
