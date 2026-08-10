import test from "node:test";
import assert from "node:assert/strict";
import { waitForCondition } from "./auth-layout-wait.mjs";

const noDelay = async () => {};
const fixedClock = () => 0;

test("retries one fresh page load after a render timeout", async () => {
  let checks = 0;
  let reloads = 0;
  const found = await waitForCondition(
    async () => {
      checks += 1;
      return checks === 2;
    },
    {
      attemptTimeoutMs: 0,
      now: fixedClock,
      onRetry: async () => {
        reloads += 1;
      },
      sleep: noDelay,
    },
  );

  assert.equal(found, true);
  assert.equal(checks, 2);
  assert.equal(reloads, 1);
});

test("fails after the bounded retry when rendering stays broken", async () => {
  let reloads = 0;
  const found = await waitForCondition(
    async () => false,
    {
      attemptTimeoutMs: 0,
      now: fixedClock,
      onRetry: async () => {
        reloads += 1;
      },
      sleep: noDelay,
    },
  );

  assert.equal(found, false);
  assert.equal(reloads, 1);
});
