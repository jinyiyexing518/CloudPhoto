#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPng } from "./png-contract.mjs";

const DEFAULT_BASE_URL = "https://cloudphotos.top";
const DEFAULT_WWW_BASE_URL = "https://www.cloudphotos.top";
const DEFAULT_AZURE_FRONTEND_URL =
  "https://brave-sand-053b07a00.7.azurestaticapps.net";
const DEFAULT_AZURE_API_BASE_URL =
  "https://cloudphoto-api.azurewebsites.net/api";
const ATTEMPTS = 8;
const RETRY_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CANONICAL_HSTS = "max-age=31536000; includeSubDomains; preload";
const LEGACY_VM_HSTS = "max-age=31536000; includeSubDomains";
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function headerValues(response, name) {
  return (response.headers.get(name) ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

async function validateHomepage(response, { allowTrailingHstsDrift = false } = {}) {
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
  if (!headerValues(response, "x-content-type-options").includes("nosniff")) {
    throw new Error("homepage is missing X-Content-Type-Options: nosniff");
  }
  if (!headerValues(response, "x-frame-options").includes("sameorigin")) {
    throw new Error("homepage is missing X-Frame-Options: SAMEORIGIN");
  }
  const frameAncestors = headerValues(response, "content-security-policy")
    .flatMap((policy) => policy.split(";"))
    .map((directive) => directive.trim());
  if (!frameAncestors.includes("frame-ancestors 'self'")) {
    throw new Error("homepage CSP must restrict frame-ancestors to 'self'");
  }
  if (!headerValues(response, "referrer-policy").includes("same-origin")) {
    throw new Error("homepage is missing Referrer-Policy: same-origin");
  }
  const hstsValues = (response.headers.get("strict-transport-security") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    hstsValues.length === 0
    || hstsValues[0] !== CANONICAL_HSTS
    || (allowTrailingHstsDrift
      ? hstsValues.slice(1).some(
        (value) => value !== CANONICAL_HSTS && value !== LEGACY_VM_HSTS
      )
      : (
      hstsValues.length !== 1 || hstsValues.some((value) => value !== CANONICAL_HSTS)
      ))
  ) {
    throw new Error(
      `homepage first effective Strict-Transport-Security must be "${CANONICAL_HSTS}"`
    );
  }
  if (!/<meta name=["']mobile-web-app-capable["'] content=["']yes["']\s*\/?>/i.test(body)) {
    throw new Error("homepage is missing mobile-web-app-capable: yes");
  }

  if (!/<meta name=["']apple-mobile-web-app-capable["'] content=["']yes["']\s*\/?>/i.test(body)) {
    throw new Error("homepage is missing apple-mobile-web-app-capable: yes");
  }
}

function validateProxyHomepage(response) {
  return validateHomepage(response, { allowTrailingHstsDrift: true });
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
    body?.name === "Cloud Photo"
    && body.short_name === "CloudPhoto"
    && typeof body?.start_url === "string"
    && body.start_url === "/"
    && body.scope === "/"
    && body.display === "standalone"
    && body.theme_color === "#0078d4"
    && body.background_color === "#f0f2f5"
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

async function validateMissingAsset(response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = await response.text();
  if (response.status !== 404) {
    throw new Error(`expected 404, received ${response.status}`);
  }
  if (!contentType.includes("application/json") || contentType.includes("text/html")) {
    throw new Error(`missing asset response has unsafe MIME ${contentType || "(missing)"}`);
  }
  if (/<(?:!doctype\s+html|html)\b/i.test(body)) {
    throw new Error("missing asset response fell through to an HTML document");
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

function validateAuthError(expectedStatuses) {
  return async (response) => {
    if (!expectedStatuses.has(response.status)) {
      throw new Error(
        `expected ${[...expectedStatuses].join(" or ")}, received ${response.status}`
      );
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new Error("auth response is not JSON");
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("auth response is not valid JSON");
    }
    if (typeof body?.error !== "string" || body.error.trim().length === 0) {
      throw new Error("auth response is missing an error");
    }
  };
}

function validateCorsPreflight(expectedOrigin) {
  return async (response) => {
    const status = response.status;
    await response.arrayBuffer();
    if (status !== 200 && status !== 204) {
      throw new Error(`expected 200 or 204, received ${status}`);
    }
    if (response.headers.get("access-control-allow-origin") !== expectedOrigin) {
      throw new Error(`CORS does not allow ${expectedOrigin}`);
    }
    const allowedHeaders = (response.headers.get("access-control-allow-headers") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (!allowedHeaders.includes("content-type")) {
      throw new Error("CORS preflight does not allow Content-Type");
    }
  };
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

function deploymentUrl(override, defaultUrl, expectedSha) {
  const url = new URL(override ?? defaultUrl);
  url.searchParams.set("sha", expectedSha);
  return url.href;
}

function validateDeployment(expectedSha) {
  return async (response) => {
    if (response.status !== 200) {
      throw new Error(`expected 200, received ${response.status}`);
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new Error("deployment marker is not JSON");
    }
    const cacheControl = headerValues(response, "cache-control");
    if (cacheControl.length !== 1 || cacheControl[0] !== "no-store") {
      throw new Error("deployment marker must use only Cache-Control: no-store");
    }

    let body;
    let serialized;
    try {
      serialized = await response.text();
      body = JSON.parse(serialized);
    } catch {
      throw new Error("deployment marker is not valid JSON");
    }
    const canonical = JSON.stringify({ sha: expectedSha });
    if (
      body?.sha !== expectedSha
      || Object.keys(body ?? {}).length !== 1
      || (serialized !== canonical && serialized !== `${canonical}\n`)
    ) {
      throw new Error(`deployment marker does not match expected SHA ${expectedSha}`);
    }
  };
}

export function createChecks(env = process.env) {
  const primaryBaseUrl = env.PRODUCTION_BASE_URL ?? DEFAULT_BASE_URL;
  const wwwBaseUrl = env.PRODUCTION_WWW_BASE_URL ?? DEFAULT_WWW_BASE_URL;
  const azureFrontendUrl =
    env.PRODUCTION_AZURE_FRONTEND_URL ?? DEFAULT_AZURE_FRONTEND_URL;
  const azureApiBaseUrl =
    env.PRODUCTION_AZURE_API_BASE_URL ?? DEFAULT_AZURE_API_BASE_URL;
  const wwwOrigin =
    env.PRODUCTION_WWW_ORIGIN ?? new URL(wwwBaseUrl).origin;
  const azureFrontendOrigin =
    env.PRODUCTION_AZURE_FRONTEND_ORIGIN ?? new URL(azureFrontendUrl).origin;
  const expectedDeployedSha = env.PRODUCTION_DEPLOYED_SHA?.toLowerCase() ?? "";
  const expectedBackendDeployedSha =
    env.PRODUCTION_BACKEND_DEPLOYED_SHA?.toLowerCase() ?? "";
  const scope = env.PRODUCTION_SMOKE_SCOPE ?? "full";
  if (
    scope !== "full"
    && scope !== "deployment"
    && scope !== "backend-deployment"
  ) {
    throw new Error(
      "PRODUCTION_SMOKE_SCOPE must be full, deployment, or backend-deployment"
    );
  }
  if (scope === "deployment" && !expectedDeployedSha) {
    throw new Error("deployment scope requires PRODUCTION_DEPLOYED_SHA");
  }
  if (scope === "backend-deployment" && !expectedBackendDeployedSha) {
    throw new Error(
      "backend-deployment scope requires PRODUCTION_BACKEND_DEPLOYED_SHA"
    );
  }
  if (expectedDeployedSha && !COMMIT_SHA_PATTERN.test(expectedDeployedSha)) {
    throw new Error("PRODUCTION_DEPLOYED_SHA must be a 40-character commit SHA");
  }
  if (
    expectedBackendDeployedSha
    && !COMMIT_SHA_PATTERN.test(expectedBackendDeployedSha)
  ) {
    throw new Error(
      "PRODUCTION_BACKEND_DEPLOYED_SHA must be a 40-character commit SHA"
    );
  }

  const checks = [
    {
      target: "primary",
      name: "homepage",
      url: env.PRODUCTION_HOME_URL ?? new URL("/", primaryBaseUrl).href,
      validate: validateProxyHomepage,
    },
    {
      target: "primary",
      name: "healthz",
      url: env.PRODUCTION_HEALTH_URL ?? new URL("/healthz", primaryBaseUrl).href,
      validate: validateProxyHealth,
    },
    {
      target: "www",
      name: "homepage",
      url: env.PRODUCTION_WWW_HOME_URL ?? new URL("/", wwwBaseUrl).href,
      validate: validateProxyHomepage,
    },
    {
      target: "www",
      name: "healthz",
      url:
        env.PRODUCTION_WWW_HEALTH_URL ??
        new URL("/healthz", wwwBaseUrl).href,
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
      name: "missing-js-asset",
      url:
        env.PRODUCTION_MISSING_JS_URL
        ?? new URL("/assets/__cloudphoto_missing_asset__-deadbeef.js", primaryBaseUrl).href,
      validate: validateMissingAsset,
    },
    {
      target: "primary",
      name: "missing-css-asset",
      url:
        env.PRODUCTION_MISSING_CSS_URL
        ?? new URL("/assets/__cloudphoto_missing_asset__-deadbeef.css", primaryBaseUrl).href,
      validate: validateMissingAsset,
    },
    {
      target: "azure",
      name: "missing-js-asset",
      url:
        env.PRODUCTION_AZURE_MISSING_JS_URL
        ?? new URL("/assets/__cloudphoto_missing_asset__-deadbeef.js", azureFrontendUrl).href,
      validate: validateMissingAsset,
    },
    {
      target: "azure",
      name: "missing-css-asset",
      url:
        env.PRODUCTION_AZURE_MISSING_CSS_URL
        ?? new URL("/assets/__cloudphoto_missing_asset__-deadbeef.css", azureFrontendUrl).href,
      validate: validateMissingAsset,
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
      target: "www",
      name: "auth/me",
      url:
        env.PRODUCTION_WWW_AUTH_ME_URL ??
        joinUrl(wwwBaseUrl, "/api/auth/me"),
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
      name: "auth/login",
      url:
        env.PRODUCTION_AUTH_LOGIN_URL ??
        joinUrl(primaryBaseUrl, "/api/auth/login"),
      request: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "__cloudphoto_production_health_missing_account__",
          password: "__cloudphoto_production_health_invalid_password__",
        }),
      },
      validate: validateAuthError(new Set([401, 404])),
    },
    {
      target: "primary",
      name: "auth/register",
      url:
        env.PRODUCTION_AUTH_REGISTER_URL ??
        joinUrl(primaryBaseUrl, "/api/auth/register"),
      request: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      validate: validateAuthError(new Set([400])),
    },
    {
      target: "www",
      name: "auth/login-preflight",
      url:
        env.PRODUCTION_WWW_AUTH_PREFLIGHT_URL ??
        joinUrl(azureApiBaseUrl, "/auth/login"),
      request: {
        method: "OPTIONS",
        headers: {
          Origin: wwwOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      validate: validateCorsPreflight(wwwOrigin),
    },
    {
      target: "azure",
      name: "auth/register-preflight",
      url:
        env.PRODUCTION_AZURE_REGISTER_PREFLIGHT_URL ??
        joinUrl(primaryBaseUrl, "/api/auth/register"),
      request: {
        method: "OPTIONS",
        headers: {
          Origin: azureFrontendOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      },
      validate: validateCorsPreflight(azureFrontendOrigin),
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
      target: "www",
      name: "changelogs",
      url:
        env.PRODUCTION_WWW_CHANGELOGS_URL ??
        joinUrl(wwwBaseUrl, "/api/changelogs"),
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

  const deploymentChecks = [];
  if (expectedDeployedSha) {
    deploymentChecks.push(
      {
        target: "primary",
        name: "deployment",
        url: deploymentUrl(
          env.PRODUCTION_DEPLOYMENT_URL,
          new URL("/deployment.json", primaryBaseUrl).href,
          expectedDeployedSha,
        ),
        validate: validateDeployment(expectedDeployedSha),
      },
      {
        target: "www",
        name: "deployment",
        url: deploymentUrl(
          env.PRODUCTION_WWW_DEPLOYMENT_URL,
          new URL("/deployment.json", wwwBaseUrl).href,
          expectedDeployedSha,
        ),
        validate: validateDeployment(expectedDeployedSha),
      },
      {
        target: "azure",
        name: "deployment",
        url: deploymentUrl(
          env.PRODUCTION_AZURE_DEPLOYMENT_URL,
          new URL("/deployment.json", azureFrontendUrl).href,
          expectedDeployedSha,
        ),
        validate: validateDeployment(expectedDeployedSha),
      },
    );
  }
  if (expectedBackendDeployedSha) {
    deploymentChecks.push(
      {
        target: "primary",
        name: "backend-deployment",
        url: deploymentUrl(
          env.PRODUCTION_BACKEND_DEPLOYMENT_URL,
          joinUrl(primaryBaseUrl, "/api/deployment"),
          expectedBackendDeployedSha,
        ),
        validate: validateDeployment(expectedBackendDeployedSha),
      },
      {
        target: "www",
        name: "backend-deployment",
        url: deploymentUrl(
          env.PRODUCTION_WWW_BACKEND_DEPLOYMENT_URL,
          joinUrl(wwwBaseUrl, "/api/deployment"),
          expectedBackendDeployedSha,
        ),
        validate: validateDeployment(expectedBackendDeployedSha),
      },
      {
        target: "azure",
        name: "backend-deployment",
        url: deploymentUrl(
          env.PRODUCTION_AZURE_BACKEND_DEPLOYMENT_URL,
          joinUrl(azureApiBaseUrl, "/deployment"),
          expectedBackendDeployedSha,
        ),
        validate: validateDeployment(expectedBackendDeployedSha),
      },
    );
  }
  if (deploymentChecks.length > 0) {
    checks.splice(5, 0, ...deploymentChecks);
  }

  if (scope === "deployment") {
    return checks.filter(({ name }) => name === "deployment");
  }
  if (scope === "backend-deployment") {
    return checks.filter(({ name }) => name === "backend-deployment");
  }
  return checks;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runCheck(check, fetchImpl, requestTimeoutMs) {
  const headers = new Headers(check.request?.headers);
  headers.set("User-Agent", "cloudphoto-production-smoke/1.0");
  const response = await fetchImpl(check.url, {
    ...check.request,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("redirects are not allowed for independent production targets");
  }
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
