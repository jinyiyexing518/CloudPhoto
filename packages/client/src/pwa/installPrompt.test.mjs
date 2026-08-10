import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createPwaInstallController,
  getPwaInstallGuidance,
  subscribeToMediaQueryChanges,
} from "./installPrompt.ts";

class FakeDisplayModeQuery extends EventTarget {
  constructor(matches = false) {
    super();
    this.matches = matches;
  }

  setMatches(matches) {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

class FakeBeforeInstallPromptEvent extends Event {
  constructor(outcome = "accepted") {
    super("beforeinstallprompt", { cancelable: true });
    this.promptCalls = 0;
    this.userChoice = Promise.resolve({ outcome, platform: "web" });
  }

  async prompt() {
    this.promptCalls += 1;
  }
}

function createEnvironment({
  standalone = false,
  navigatorStandalone = false,
  userAgent = "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36",
  platform = "Win32",
  maxTouchPoints = 0,
} = {}) {
  const displayModeQuery = new FakeDisplayModeQuery(standalone);
  return {
    eventTarget: new EventTarget(),
    displayModeQuery,
    subscribeToDisplayModeChange: (listener) => {
      displayModeQuery.addEventListener("change", listener);
      return () => displayModeQuery.removeEventListener("change", listener);
    },
    navigatorStandalone,
    userAgent,
    platform,
    maxTouchPoints,
  };
}

test("retains an install prompt dispatched before the UI subscribes", async () => {
  const promptEvent = new FakeBeforeInstallPromptEvent("accepted");
  const environment = createEnvironment();
  environment.initialPrompt = promptEvent;
  const controller = createPwaInstallController(environment);

  assert.equal(promptEvent.defaultPrevented, true);
  assert.equal(controller.getSnapshot().mode, "native");

  let notified = 0;
  controller.subscribe(() => { notified += 1; });
  const result = await controller.requestInstall();

  assert.deepEqual(result, { status: "prompted", outcome: "accepted" });
  assert.equal(promptEvent.promptCalls, 1);
  assert.equal(controller.getSnapshot().outcome, "accepted");
  assert.ok(notified > 0);
  controller.dispose();
});

test("publishes native availability when the prompt arrives after subscription", () => {
  const environment = createEnvironment();
  const controller = createPwaInstallController(environment);
  const modes = [];
  controller.subscribe(() => modes.push(controller.getSnapshot().mode));

  environment.eventTarget.dispatchEvent(new FakeBeforeInstallPromptEvent());

  assert.deepEqual(modes, ["native"]);
  assert.equal(controller.getSnapshot().mode, "native");
  controller.dispose();
});

test("keeps a guidance action after the native prompt is dismissed", async () => {
  const environment = createEnvironment();
  const controller = createPwaInstallController(environment);
  const promptEvent = new FakeBeforeInstallPromptEvent("dismissed");
  environment.eventTarget.dispatchEvent(promptEvent);

  assert.deepEqual(
    await controller.requestInstall(),
    { status: "prompted", outcome: "dismissed" },
  );
  assert.deepEqual(controller.getSnapshot(), {
    mode: "manual",
    outcome: "dismissed",
    platform: "chromium",
  });
  assert.deepEqual(await controller.requestInstall(), { status: "guidance" });
  assert.equal(promptEvent.promptCalls, 1);
  controller.dispose();
});

test("deduplicates install clicks while the native prompt is open", async () => {
  const environment = createEnvironment();
  let resolveChoice;
  const promptEvent = new FakeBeforeInstallPromptEvent();
  promptEvent.userChoice = new Promise((resolve) => {
    resolveChoice = resolve;
  });
  const controller = createPwaInstallController(environment);
  environment.eventTarget.dispatchEvent(promptEvent);

  const firstRequest = controller.requestInstall();
  const secondRequest = controller.requestInstall();
  resolveChoice({ outcome: "accepted", platform: "web" });

  assert.deepEqual(await firstRequest, { status: "prompted", outcome: "accepted" });
  assert.deepEqual(await secondRequest, { status: "prompted", outcome: "accepted" });
  assert.equal(promptEvent.promptCalls, 1);
  controller.dispose();
});

test("updates to installed and removes the native action after appinstalled", async () => {
  const environment = createEnvironment();
  const controller = createPwaInstallController(environment);
  environment.eventTarget.dispatchEvent(new FakeBeforeInstallPromptEvent());

  environment.eventTarget.dispatchEvent(new Event("appinstalled"));

  assert.equal(controller.getSnapshot().mode, "installed");
  assert.deepEqual(await controller.requestInstall(), { status: "installed" });
  controller.dispose();
});

test("retains appinstalled when it fires before the UI controller mounts", async () => {
  const environment = createEnvironment();
  environment.initialAppInstalled = true;
  const controller = createPwaInstallController(environment);

  assert.equal(controller.getSnapshot().mode, "installed");
  assert.deepEqual(await controller.requestInstall(), { status: "installed" });
  controller.dispose();
});

test("detects browser and iOS standalone sessions immediately", () => {
  const displayModeEnvironment = createEnvironment({ standalone: true });
  const displayModeController = createPwaInstallController(displayModeEnvironment);
  assert.equal(displayModeController.getSnapshot().mode, "installed");

  const iosStandaloneEnvironment = createEnvironment({
    navigatorStandalone: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    platform: "iPhone",
    maxTouchPoints: 5,
  });
  const iosStandaloneController = createPwaInstallController(iosStandaloneEnvironment);
  assert.equal(iosStandaloneController.getSnapshot().mode, "installed");

  displayModeController.dispose();
  iosStandaloneController.dispose();
});

test("uses share to home-screen guidance for iOS without a native prompt", async () => {
  const environment = createEnvironment({
    userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1",
    platform: "iPad",
    maxTouchPoints: 5,
  });
  const controller = createPwaInstallController(environment);

  assert.equal(controller.getSnapshot().mode, "ios");
  assert.deepEqual(await controller.requestInstall(), { status: "guidance" });
  assert.match(getPwaInstallGuidance("ios").join(" "), /分享.*添加到主屏幕/);
  controller.dispose();
});

test("keeps executable desktop guidance when no prompt is available", async () => {
  const environment = createEnvironment();
  const controller = createPwaInstallController(environment);

  assert.equal(controller.getSnapshot().mode, "manual");
  assert.deepEqual(await controller.requestInstall(), { status: "guidance" });
  assert.match(getPwaInstallGuidance("chromium").join(" "), /浏览器菜单.*安装 CloudPhoto/);
  controller.dispose();
});

test("supports legacy media-query listeners used by older Safari", () => {
  let registeredListener;
  const legacyQuery = {
    matches: false,
    addListener: (listener) => {
      registeredListener = listener;
    },
    removeListener: (listener) => {
      if (registeredListener === listener) registeredListener = undefined;
    },
  };
  const unsubscribe = subscribeToMediaQueryChanges(legacyQuery, () => {});

  assert.equal(typeof registeredListener, "function");
  unsubscribe();
  assert.equal(registeredListener, undefined);
});

test("keeps install actions discoverable without occupying the authenticated header", () => {
  const authenticatedAppSource = readFileSync(
    new URL("../AuthenticatedApp.tsx", import.meta.url),
    "utf8",
  );
  const authenticatedStyles = readFileSync(
    new URL("../authenticated.css", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(authenticatedAppSource, /header-install-button/);
  assert.doesNotMatch(authenticatedStyles, /\.header-install-button/);
  assert.match(authenticatedAppSource, /closeUserMenu\(true\);[\s\S]*handleInstallApp\(userAvatarButtonRef\.current\)/);
  assert.match(authenticatedAppSource, /<SettingsDialog[\s\S]*onInstallApp=\{\(trigger\) => void handleInstallApp\(trigger, true\)\}/);
  assert.doesNotMatch(authenticatedAppSource, /Auto-dismiss install banner|10_000/);
});
