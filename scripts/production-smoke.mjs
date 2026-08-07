#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://cloudphotos.top";
const DEFAULT_AZURE_FRONTEND_URL =
  "https://brave-sand-053b07a00.7.azurestaticapps.net";
const DEFAULT_AZURE_API_BASE_URL =
  "https://cloudphoto-api.azurewebsites.net/api";
const ATTEMPTS = 8;
const RETRY_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function validateHomepage(response) {
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
}

async function validateAuthMe(response) {
  const status = response.status;
  await response.arrayBuffer();
  if (status !== 401) {
    throw new Error(`expected 401, received ${status}`);
  }
}

async function validateChangelogs(response) {
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
}

export function createChecks(env = process.env) {
  const primaryBaseUrl = env.PRODUCTION_BASE_URL ?? DEFAULT_BASE_URL;
  const azureFrontendUrl =
    env.PRODUCTION_AZURE_FRONTEND_URL ?? DEFAULT_AZURE_FRONTEND_URL;
  const azureApiBaseUrl =
    env.PRODUCTION_AZURE_API_BASE_URL ?? DEFAULT_AZURE_API_BASE_URL;

  return [
    {
      target: "primary",
      name: "homepage",
      url: env.PRODUCTION_HOME_URL ?? new URL("/", primaryBaseUrl).href,
      validate: validateHomepage,
    },
    {
      target: "azure",
      name: "homepage",
      url:
        env.PRODUCTION_AZURE_HOME_URL ??
        new URL("/", azureFrontendUrl).href,
      validate: validateHomepage,
    },
    {
      target: "primary",
      name: "auth/me",
      url:
        env.PRODUCTION_AUTH_ME_URL ??
        joinUrl(primaryBaseUrl, "/api/auth/me"),
      validate: validateAuthMe,
    },
    {
      target: "azure",
      name: "auth/me",
      url:
        env.PRODUCTION_AZURE_AUTH_ME_URL ??
        joinUrl(azureApiBaseUrl, "/auth/me"),
      validate: validateAuthMe,
    },
    {
      target: "primary",
      name: "changelogs",
      url:
        env.PRODUCTION_CHANGELOGS_URL ??
        joinUrl(primaryBaseUrl, "/api/changelogs"),
      validate: validateChangelogs,
    },
    {
      target: "azure",
      name: "changelogs",
      url:
        env.PRODUCTION_AZURE_CHANGELOGS_URL ??
        joinUrl(azureApiBaseUrl, "/changelogs"),
      validate: validateChangelogs,
    },
  ];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runCheck(check, fetchImpl, requestTimeoutMs) {
  const response = await fetchImpl(check.url, {
    headers: { "User-Agent": "cloudphoto-production-smoke/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  await check.validate(response);
}

export async function runSmoke({
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  attempts = ATTEMPTS,
  retryDelayMs = RETRY_DELAY_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const checks = createChecks(env);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const results = await Promise.all(
      checks.map(async (check) => {
        const startedAt = performance.now();
        try {
          await runCheck(check, fetchImpl, requestTimeoutMs);
          return {
            check,
            elapsedMs: Math.round(performance.now() - startedAt),
            passed: true,
          };
        } catch (error) {
          return {
            check,
            elapsedMs: Math.round(performance.now() - startedAt),
            passed: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    const failures = [];
    for (const result of results) {
      const { check, elapsedMs } = result;
      if (result.passed) {
        logger.log(
          `PASS ${check.target} ${check.name}: ${check.url} (${elapsedMs}ms)`
        );
      } else {
        failures.push(`${check.target} ${check.name}: ${result.message}`);
        logger.error(
          `FAIL ${check.target} ${check.name}: ${check.url} (${elapsedMs}ms; ${result.message})`
        );
      }
    }

    if (failures.length === 0) {
      logger.log(`Production smoke checks passed on attempt ${attempt}.`);
      return true;
    }

    if (attempt < attempts) {
      logger.log(
        `Attempt ${attempt}/${attempts} failed; retrying in ${
          retryDelayMs / 1000
        }s.`
      );
      await delay(retryDelayMs);
    } else {
      logger.error(
        `Production smoke checks failed after ${attempts} attempts:\n- ${failures.join(
          "\n- "
        )}`
      );
    }
  }

  return false;
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly && !(await runSmoke())) {
  process.exitCode = 1;
}
