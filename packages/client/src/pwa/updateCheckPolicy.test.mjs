import assert from "node:assert/strict";
import test from "node:test";
import {
  getPwaUpdateIntervalMs,
  installPwaUpdateChecks,
  PWA_BROWSER_UPDATE_INTERVAL_MS,
  PWA_STANDALONE_UPDATE_INTERVAL_MS,
  PWA_UPDATE_MIN_GAP_MS,
} from "./updateCheckPolicy.ts";

class FakeWindow extends EventTarget {
  intervals = new Map();
  nextIntervalId = 0;

  setInterval(callback, delay) {
    const id = ++this.nextIntervalId;
    this.intervals.set(id, { callback, delay });
    return id;
  }

  clearInterval(id) {
    this.intervals.delete(id);
  }
}

class FakeDocument extends EventTarget {
  visibilityState = "visible";
}

test("uses lower-frequency visible polling for installed and browser sessions", () => {
  assert.equal(getPwaUpdateIntervalMs(true), PWA_STANDALONE_UPDATE_INTERVAL_MS);
  assert.equal(getPwaUpdateIntervalMs(false), PWA_BROWSER_UPDATE_INTERVAL_MS);
  assert.equal(PWA_STANDALONE_UPDATE_INTERVAL_MS, 5 * 60 * 1000);
  assert.equal(PWA_BROWSER_UPDATE_INTERVAL_MS, 15 * 60 * 1000);
});

test("detects installed display mode inside the deferred policy chunk", () => {
  const target = new FakeWindow();
  target.matchMedia = () => ({ matches: true });
  const pageDocument = new FakeDocument();
  const dispose = installPwaUpdateChecks(
    { update: () => Promise.resolve() },
    {
      target,
      document: pageDocument,
      navigator: { onLine: true },
    },
  );

  assert.equal(
    [...target.intervals.values()][0].delay,
    PWA_STANDALONE_UPDATE_INTERVAL_MS,
  );
  dispose();

  const iosTarget = new FakeWindow();
  iosTarget.matchMedia = () => ({ matches: false });
  const disposeIos = installPwaUpdateChecks(
    { update: () => Promise.resolve() },
    {
      target: iosTarget,
      document: pageDocument,
      navigator: { onLine: true, standalone: true },
    },
  );
  assert.equal(
    [...iosTarget.intervals.values()][0].delay,
    PWA_STANDALONE_UPDATE_INTERVAL_MS,
  );
  disposeIos();
});

test("defers the first explicit update and coalesces foreground triggers", async () => {
  const target = new FakeWindow();
  const pageDocument = new FakeDocument();
  const connection = { onLine: true };
  const updates = [];
  const errors = [];
  let now = 1_000;
  let settleUpdate;
  const registration = {
    update() {
      updates.push(now);
      return new Promise((resolve) => {
        settleUpdate = resolve;
      });
    },
  };

  const dispose = installPwaUpdateChecks(registration, {
    standalone: false,
    target,
    document: pageDocument,
    navigator: connection,
    now: () => now,
    onError: (error) => errors.push(error),
  });

  assert.equal(updates.length, 0, "registration must remain the only startup update check");
  assert.equal(target.intervals.size, 1);
  assert.equal([...target.intervals.values()][0].delay, PWA_BROWSER_UPDATE_INTERVAL_MS);

  target.dispatchEvent(new Event("focus"));
  assert.equal(updates.length, 0, "focus inside the minimum gap must not duplicate registration");

  now += PWA_UPDATE_MIN_GAP_MS;
  target.dispatchEvent(new Event("focus"));
  target.dispatchEvent(new Event("focus"));
  assert.deepEqual(updates, [now], "concurrent focus events must share one update");

  settleUpdate();
  await Promise.resolve();
  await Promise.resolve();

  pageDocument.visibilityState = "hidden";
  now += PWA_BROWSER_UPDATE_INTERVAL_MS;
  [...target.intervals.values()][0].callback();
  assert.equal(updates.length, 1, "hidden pages must not poll");

  pageDocument.visibilityState = "visible";
  connection.onLine = false;
  pageDocument.dispatchEvent(new Event("visibilitychange"));
  assert.equal(updates.length, 1, "offline pages must not poll");

  connection.onLine = true;
  target.dispatchEvent(new Event("online"));
  assert.deepEqual(updates, [1_000 + PWA_UPDATE_MIN_GAP_MS, now]);
  settleUpdate();
  await Promise.resolve();
  await Promise.resolve();

  dispose();
  assert.equal(target.intervals.size, 0);
  now += PWA_BROWSER_UPDATE_INTERVAL_MS;
  target.dispatchEvent(new Event("focus"));
  pageDocument.dispatchEvent(new Event("visibilitychange"));
  assert.equal(updates.length, 2, "disposed schedules must remove foreground listeners");
  assert.deepEqual(errors, []);
});

test("reports update failures and allows a later retry", async () => {
  const target = new FakeWindow();
  const pageDocument = new FakeDocument();
  const connection = { onLine: true };
  const failure = new Error("network unavailable");
  const errors = [];
  let now = 10_000;
  let attempts = 0;
  const registration = {
    async update() {
      attempts += 1;
      if (attempts === 1) throw failure;
      return registration;
    },
  };

  const dispose = installPwaUpdateChecks(registration, {
    standalone: true,
    target,
    document: pageDocument,
    navigator: connection,
    now: () => now,
    onError: (error) => errors.push(error),
  });

  now += PWA_UPDATE_MIN_GAP_MS;
  target.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(errors, [failure]);

  now += PWA_UPDATE_MIN_GAP_MS;
  target.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  assert.equal(attempts, 2);
  dispose();
});

test("releases the in-flight guard after a synchronous update failure", () => {
  const target = new FakeWindow();
  const pageDocument = new FakeDocument();
  const failure = new Error("registration removed");
  const errors = [];
  let now = 20_000;
  let attempts = 0;
  const registration = {
    update() {
      attempts += 1;
      if (attempts === 1) throw failure;
      return Promise.resolve(registration);
    },
  };

  const dispose = installPwaUpdateChecks(registration, {
    standalone: false,
    target,
    document: pageDocument,
    navigator: { onLine: true },
    now: () => now,
    onError: (error) => errors.push(error),
  });

  now += PWA_UPDATE_MIN_GAP_MS;
  target.dispatchEvent(new Event("focus"));
  assert.deepEqual(errors, [failure]);

  now += PWA_UPDATE_MIN_GAP_MS;
  target.dispatchEvent(new Event("focus"));
  assert.equal(attempts, 2);
  dispose();
});
