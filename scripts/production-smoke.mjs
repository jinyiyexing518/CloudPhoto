#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPng } from "./png-contract.mjs";

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

async function validateManifest(response) {
  if (response.status !== 200) {
    throw new Error(`expected 200, received ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/manifest+json")) {
    throw new Error("response is not a web app manifest");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("response is not valid JSON");
  }
  const hasInstallMetadata = (
    typeof body?.name === "string"
    && body.name.length > 0
    && typeof body?.start_url === "string"
    && body.start_url.length > 0
    && Array.isArray(body?.icons)
    && body.icons.some((icon) => (
      typeof icon?.src === "string"
      && icon.src.length > 0
      && typeof icon?.sizes === "string"
      && icon.sizes.length > 0
      && typeof icon?.type === "string"
      && icon.type.length > 0
    ))
  );
  if (!hasInstallMetadata) {
    throw new Error("manifest is missing required install metadata");
  }

  if (body.id !== "/" || body.lang !== "zh-CN") {
    throw new Error("manifest must use the stable root id and zh-CN language");
  }

  const hasPngIcon = (source, size, purpose) => body.icons.some((icon) => (
    typeof icon?.src === "string"
    && (icon.src === source || icon.src === `/${source}`)
    && icon.type === "image/png"
    && icon.sizes?.split(/\s+/).includes(size)
    && icon.purpose?.split(/\s+/).includes(purpose)
  ));
  if (
    !hasPngIcon("pwa-192x192.png", "192x192", "any")
    || !hasPngIcon("pwa-512x512.png", "512x512", "any")
    || !hasPngIcon("maskable-icon.png", "512x512", "maskable")
  ) {
    throw new Error("manifest is missing compatible PNG install icons");
  }
}

function validatePngIcon(expectedWidth, expectedHeight) {
  return async (response) => {
    if (response.status !== 200) {
      throw new Error(`expected 200, received ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("image/png")) {
      throw new Error("response is not a PNG image");
    }

    let dimensions;
    try {
      dimensions = inspectPng(await response.arrayBuffer());
    } catch (error) {
      throw new Error(`response body is not a valid PNG: ${error.message}`);
    }
    const { width, height } = dimensions;
    if (width !== expectedWidth || height !== expectedHeight) {
      throw new Error(
        `expected ${expectedWidth}x${expectedHeight}, received ${width}x${height}`
      );
    }
  };
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

async function validateProxyHealth(response) {
  if (response.status !== 200) {
    throw new Error(`expected 200, received ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("response is not JSON");
  }
  const body = await response.json();
  const knownRoutes = new Set(["cloudphoto-proxy", "cloudphoto-frontend"]);
  if (body?.status !== "ok" || !knownRoutes.has(body?.route)) {
    throw new Error("response does not identify a CloudPhoto entry route");
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
      target: "primary",
      name: "healthz",
      url: env.PRODUCTION_HEALTH_URL ?? new URL("/healthz", primaryBaseUrl).href,
      validate: validateProxyHealth,
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
      name: "manifest",
      url:
        env.PRODUCTION_MANIFEST_URL ??
        new URL("/manifest.webmanifest", primaryBaseUrl).href,
      validate: validateManifest,
    },
    {
      target: "azure",
      name: "manifest",
      url:
        env.PRODUCTION_AZURE_MANIFEST_URL ??
        new URL("/manifest.webmanifest", azureFrontendUrl).href,
      validate: validateManifest,
    },
    {
      target: "primary",
      name: "apple-touch-icon",
      url:
        env.PRODUCTION_APPLE_TOUCH_ICON_URL ??
        new URL("/apple-touch-icon.png", primaryBaseUrl).href,
      validate: validatePngIcon(180, 180),
    },
    {
      target: "azure",
      name: "apple-touch-icon",
      url:
        env.PRODUCTION_AZURE_APPLE_TOUCH_ICON_URL ??
        new URL("/apple-touch-icon.png", azureFrontendUrl).href,
      validate: validatePngIcon(180, 180),
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
