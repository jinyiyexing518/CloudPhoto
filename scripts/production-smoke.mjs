#!/usr/bin/env node

const DEFAULT_BASE_URL = "https://cloudphotos.top";
const ATTEMPTS = 8;
const RETRY_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

const baseUrl = process.env.PRODUCTION_BASE_URL ?? DEFAULT_BASE_URL;
const checks = [
  {
    name: "homepage",
    url: process.env.PRODUCTION_HOME_URL ?? new URL("/", baseUrl).href,
    validate: async (response) => {
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`expected 2xx, received ${response.status}`);
      }
      if (!response.headers.get("content-type")?.includes("text/html")) {
        throw new Error("response is not HTML");
      }
      if (!body.includes("Cloud Photo")) {
        throw new Error('response HTML does not contain "Cloud Photo"');
      }
    },
  },
  {
    name: "auth/me",
    url:
      process.env.PRODUCTION_AUTH_ME_URL ??
      new URL("/api/auth/me", baseUrl).href,
    validate: async (response) => {
      if (response.status !== 401) {
        throw new Error(`expected 401, received ${response.status}`);
      }
    },
  },
  {
    name: "changelogs",
    url:
      process.env.PRODUCTION_CHANGELOGS_URL ??
      new URL("/api/changelogs", baseUrl).href,
    validate: async (response) => {
      if (response.status !== 200) {
        throw new Error(`expected 200, received ${response.status}`);
      }

      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error("response is not valid JSON");
      }
      if (!Array.isArray(body)) {
        throw new Error("response JSON is not an array");
      }
    },
  },
];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runCheck(check) {
  const response = await fetch(check.url, {
    headers: { "User-Agent": "cloudphoto-production-smoke/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await check.validate(response);
}

let passed = false;

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const failures = [];

  for (const check of checks) {
    try {
      await runCheck(check);
      console.log(`PASS ${check.name}: ${check.url}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      failures.push(`${check.name}: ${message}`);
      console.error(`FAIL ${check.name}: ${check.url} (${message})`);
    }
  }

  if (failures.length === 0) {
    console.log(`Production smoke checks passed on attempt ${attempt}.`);
    passed = true;
    break;
  }

  if (attempt < ATTEMPTS) {
    console.log(
      `Attempt ${attempt}/${ATTEMPTS} failed; retrying in ${
        RETRY_DELAY_MS / 1000
      }s.`
    );
    await delay(RETRY_DELAY_MS);
  } else {
    console.error(
      `Production smoke checks failed after ${ATTEMPTS} attempts:\n- ${failures.join(
        "\n- "
      )}`
    );
  }
}

if (!passed) {
  process.exitCode = 1;
}
