#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultConfig = join(root, "packages", "client", "public", "staticwebapp.config.json");
const configPaths = process.argv.slice(2).map((configPath) => resolve(configPath));
if (configPaths.length === 0) configPaths.push(defaultConfig);

const immutableCache = "public, max-age=31536000, immutable";
const shellRoutes = ["/", "/index.html", "/sw.js", "/registerSW.js"];
const mutableRoutes = [
  "/healthz",
  "/manifest.webmanifest",
  "/changelog.json",
  "/favicon.svg",
  "/apple-touch-icon.svg",
  "/pwa-192x192.svg",
  "/pwa-512x512.svg",
  "/maskable-icon.svg",
];

function fail(configPath, message) {
  throw new Error(`${relative(process.cwd(), configPath)}: ${message}`);
}

function cacheControl(rule) {
  return rule?.headers?.["Cache-Control"] ?? "";
}

function requireRoute(configPath, routes, route) {
  const rule = routes.find((candidate) => candidate.route === route);
  if (!rule) fail(configPath, `missing route rule for ${route}`);
  return rule;
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function checkHashedAssets(configPath) {
  if (basename(dirname(configPath)) !== "dist") return;

  let sourceConfig;
  let distConfig;
  try {
    sourceConfig = readFileSync(defaultConfig, "utf8");
    distConfig = readFileSync(configPath, "utf8");
  } catch (error) {
    fail(configPath, `cannot compare source and built config: ${error.message}`);
  }
  if (sourceConfig !== distConfig) {
    fail(configPath, "built config must be an exact copy of the public source config");
  }

  const assetsDir = join(dirname(configPath), "assets");
  let assets;
  try {
    assets = listFiles(assetsDir);
  } catch (error) {
    fail(configPath, `cannot inspect built assets: ${error.message}`);
  }

  if (assets.length === 0) fail(configPath, "built assets directory is empty");
  for (const asset of assets) {
    if (!/-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(basename(asset)) || !statSync(asset).isFile()) {
      fail(configPath, `asset is not content-hashed: ${relative(dirname(configPath), asset)}`);
    }
  }
}

for (const configPath of configPaths) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(configPath, `invalid JSON or unreadable file: ${error.message}`);
  }

  if (!Array.isArray(config.routes)) fail(configPath, "routes must be an array");

  const assetsRule = requireRoute(configPath, config.routes, "/assets/*");
  if (config.routes[0] !== assetsRule) {
    fail(configPath, "/assets/* must be the first route so no broader rule can shadow it");
  }
  if (cacheControl(assetsRule) !== immutableCache) {
    fail(configPath, `/assets/* must use "${immutableCache}"`);
  }

  const globalCache = config.globalHeaders?.["Cache-Control"] ?? "";
  if (!/\bno-cache\b/i.test(globalCache) || /\bimmutable\b/i.test(globalCache)) {
    fail(configPath, "global Cache-Control must require revalidation and must not be immutable");
  }
  if (config.mimeTypes?.[".webmanifest"] !== "application/manifest+json") {
    fail(configPath, ".webmanifest must use application/manifest+json");
  }

  for (const route of shellRoutes) {
    const value = cacheControl(requireRoute(configPath, config.routes, route));
    if (!/\b(no-cache|no-store)\b/i.test(value) || /\bimmutable\b/i.test(value)) {
      fail(configPath, `${route} must disable caching or require revalidation`);
    }
  }

  for (const route of mutableRoutes) {
    const value = cacheControl(requireRoute(configPath, config.routes, route));
    if (!value || /\bimmutable\b/i.test(value)) {
      fail(configPath, `${route} must have an explicit non-immutable cache policy`);
    }

    const healthRoute = requireRoute(configPath, config.routes, "/healthz");
    if (healthRoute.rewrite !== "/healthz.json") {
      fail(configPath, "/healthz must rewrite to the static JSON fallback");
    }
    if (cacheControl(healthRoute) !== "no-store") {
      fail(configPath, "/healthz must never be cached");
    }
    if (!healthRoute.headers?.["Content-Type"]?.includes("application/json")) {
      fail(configPath, "/healthz must be served as JSON");
    }
  }

  for (const rule of config.routes) {
    if (rule.route !== "/assets/*" && /\bimmutable\b/i.test(cacheControl(rule))) {
      fail(configPath, `${rule.route} must not be immutable`);
    }
  }

  const fallback = config.navigationFallback;
  if (fallback?.rewrite !== "/index.html" || !fallback.exclude?.includes("/assets/*")) {
    fail(configPath, "navigationFallback must rewrite to /index.html and exclude /assets/*");
  }

  checkHashedAssets(configPath);
  console.log(`Static cache contract passed: ${relative(process.cwd(), configPath)}`);
}
