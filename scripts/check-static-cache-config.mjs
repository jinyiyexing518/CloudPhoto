#!/usr/bin/env node

import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { inspectPng } from "./png-contract.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultConfig = join(root, "packages", "client", "public", "staticwebapp.config.json");
const viteConfig = join(root, "packages", "client", "vite.config.mts");
const legacyViteConfig = join(root, "packages", "client", "vite.config.ts");
const entryCssPath = join(root, "packages", "client", "src", "index.css");
const authenticatedCssPath = join(root, "packages", "client", "src", "authenticated.css");
const authenticatedAppPath = join(root, "packages", "client", "src", "AuthenticatedApp.tsx");
const authPagePath = join(root, "packages", "client", "src", "components", "auth", "AuthPage.tsx");
const missingResponsePath = join(root, "packages", "client", "public", "404.json");
const retentionPolicyPath = join(root, "packages", "client", "deployment-retention.json");
const configPaths = process.argv.slice(2).map((configPath) => resolve(configPath));
if (configPaths.length === 0) configPaths.push(defaultConfig);

const immutableCache = "public, max-age=31536000, immutable";
const frontendSecurityHeaders = {
  "Content-Security-Policy": "frame-ancestors 'self'",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
};
const shellRoutes = ["/", "/index.html", "/sw.js", "/registerSW.js"];
const mutableRoutes = [
  "/healthz",
  "/manifest.webmanifest",
  "/changelog.json",
  "/deployment-assets.json",
  "/404.json",
  "/favicon.svg",
  "/apple-touch-icon.svg",
  "/pwa-192x192.svg",
  "/pwa-512x512.svg",
  "/maskable-icon.svg",
  "/apple-touch-icon.png",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/maskable-icon.png",
];

const installIcons = [
  { name: "apple-touch-icon.png", width: 180, height: 180 },
  { name: "pwa-192x192.png", width: 192, height: 192 },
  { name: "pwa-512x512.png", width: 512, height: 512 },
  { name: "maskable-icon.png", width: 512, height: 512 },
];

function fail(configPath, message) {
  throw new Error(`${relative(process.cwd(), configPath)}: ${message}`);
}

function cacheControl(rule) {
  return rule?.headers?.["Cache-Control"] ?? "";
}

function checkViteConfigModule() {
  if (!existsSync(viteConfig)) {
    fail(viteConfig, "missing ESM Vite config");
  }
  if (existsSync(legacyViteConfig)) {
    fail(legacyViteConfig, "legacy .ts config loads Vite's deprecated CJS Node API");
  }

  const source = readFileSync(viteConfig, "utf8");
  if (!source.includes("import.meta.url") || /\b__dirname\b/.test(source)) {
    fail(viteConfig, "ESM config must resolve paths from import.meta.url");
  }
  if (
    !source.includes('registerType: "prompt"')
    || !source.includes("skipWaiting: false")
    || !source.includes("clientsClaim: false")
  ) {
    fail(viteConfig, "PWA updates must wait for the shared transfer-safe activation path");
  }
}

function checkAuthenticatedStyleBoundary() {
  if (!existsSync(authenticatedCssPath)) {
    fail(authenticatedCssPath, "missing deferred authenticated workspace stylesheet");
  }

  const entryCss = readFileSync(entryCssPath, "utf8");
  const authenticatedCss = readFileSync(authenticatedCssPath, "utf8");
  const authenticatedApp = readFileSync(authenticatedAppPath, "utf8");
  const authPage = readFileSync(authPagePath, "utf8");
  const authStart = "/* ===== Auth Page ===== */";
  const entryAuthEnd = "/* ===== End Auth Page ===== */";
  const workspaceAuthEnd = "/* ============================================================";
  const extractAuthStyles = (source, endMarker, path) => {
    const start = source.indexOf(authStart);
    const end = source.indexOf(endMarker, start + authStart.length);
    if (start < 0 || end < 0) fail(path, "cannot locate the complete auth style section");
    return source.slice(start, end).replace(/\s+/g, " ").trim();
  };
  if (!authenticatedApp.includes('import "./authenticated.css";')) {
    fail(authenticatedAppPath, "authenticated workspace must import its deferred stylesheet");
  }
  if (entryCss.includes("authenticated.css")) {
    fail(entryCssPath, "login entry must not import authenticated workspace styles");
  }
  if (
    !authPage.includes('import("../../pwa/PwaInstallEntry")')
    || !authPage.includes("<PwaInstallEntry />")
  ) {
    fail(authPagePath, "signed-out shell must keep its deferred PWA install entry");
  }
  if (Buffer.byteLength(entryCss) > 20_000) {
    fail(entryCssPath, "login entry stylesheet must stay below 20 kB before minification");
  }
  for (const selector of [".auth-page", ".app-splash", ".error-boundary-card"]) {
    if (!entryCss.includes(selector)) fail(entryCssPath, `missing login-shell selector ${selector}`);
  }
  if (
    extractAuthStyles(entryCss, entryAuthEnd, entryCssPath)
    !== extractAuthStyles(authenticatedCss, workspaceAuthEnd, authenticatedCssPath)
  ) {
    fail(entryCssPath, "auth styles must remain identical before and after workspace CSS loads");
  }
  for (const selector of [".app-header", ".photo-grid", ".workspace-sidebar"]) {
    if (entryCss.includes(selector)) fail(entryCssPath, `workspace selector ${selector} leaked into login CSS`);
    if (!authenticatedCss.includes(selector)) {
      fail(authenticatedCssPath, `missing preserved workspace selector ${selector}`);
    }
    if (
      authenticatedApp.includes("header-install-button")
      || authenticatedCss.includes(".header-install-button")
    ) {
      fail(authenticatedAppPath, "authenticated header must not restore the permanent install entry");
    }
  }
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

function pngDimensions(configPath, path) {
  try {
    return inspectPng(readFileSync(path));
  } catch (error) {
    fail(configPath, `cannot decode ${basename(path)}: ${error.message}`);
  }
}

function checkInstallMetadata(configPath) {
  if (basename(dirname(configPath)) !== "dist") return;

  const distDir = dirname(configPath);
  let manifest;
  let indexHtml;
  try {
    manifest = JSON.parse(readFileSync(join(distDir, "manifest.webmanifest"), "utf8"));
    indexHtml = readFileSync(join(distDir, "index.html"), "utf8");
  } catch (error) {
    fail(configPath, `cannot inspect built install metadata: ${error.message}`);
  }

  if (manifest.id !== "/" || manifest.lang !== "zh-CN") {
    fail(configPath, "built manifest must use the stable root id and zh-CN language");
  }
  if (
    manifest.name !== "Cloud Photo"
    || manifest.short_name !== "CloudPhoto"
    || manifest.start_url !== "/"
    || manifest.scope !== "/"
    || manifest.display !== "standalone"
    || manifest.theme_color !== "#0078d4"
    || manifest.background_color !== "#f0f2f5"
  ) {
    fail(configPath, "built manifest is missing the required app identity, scope, display, or theme metadata");
  }

  const requiredManifestIcons = [
    { name: "pwa-192x192.png", size: "192x192", purpose: "any" },
    { name: "pwa-512x512.png", size: "512x512", purpose: "any" },
    { name: "maskable-icon.png", size: "512x512", purpose: "maskable" },
  ];
  for (const required of requiredManifestIcons) {
    const icon = manifest.icons?.find((candidate) => candidate.src === required.name);
    if (
      icon?.type !== "image/png"
      || !icon.sizes?.split(/\s+/).includes(required.size)
      || !icon.purpose?.split(/\s+/).includes(required.purpose)
    ) {
      fail(configPath, `built manifest is missing ${required.purpose} ${required.size} PNG`);
    }
  }

  if (
    !/<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']\/apple-touch-icon\.png["']/i
      .test(indexHtml)
  ) {
    fail(configPath, "built HTML must link the PNG Apple Touch icon");
  }

  for (const icon of installIcons) {
    const dimensions = pngDimensions(configPath, join(distDir, icon.name));
    if (dimensions.width !== icon.width || dimensions.height !== icon.height) {
      fail(
        configPath,
        `${icon.name} must be ${icon.width}x${icon.height}, received ${dimensions.width}x${dimensions.height}`
      );
    }
  }
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
  const deploymentManifestPath = join(dirname(configPath), "deployment-assets.json");
  let deploymentManifest;
  let retentionPolicy;
  try {
    deploymentManifest = JSON.parse(readFileSync(deploymentManifestPath, "utf8"));
    retentionPolicy = JSON.parse(readFileSync(retentionPolicyPath, "utf8"));
  } catch (error) {
    fail(configPath, `cannot inspect bounded deployment assets: ${error.message}`);
  }
  if (
    deploymentManifest.version !== 1
    || !Array.isArray(deploymentManifest.generations)
    || deploymentManifest.generations.length < 1
    || deploymentManifest.generations.length > retentionPolicy.maxGenerations
  ) {
    fail(configPath, "deployment asset generations exceed or violate the retention policy");
  }
  if (
    !Array.isArray(retentionPolicy.bootstrapGenerationRefs)
    || !retentionPolicy.bootstrapGenerationAssets
    || typeof retentionPolicy.bootstrapGenerationAssets !== "object"
    || Array.isArray(retentionPolicy.bootstrapGenerationAssets)
    || retentionPolicy.bootstrapSourceManifest?.status !== 200
    || retentionPolicy.bootstrapSourceManifest?.contentType !== "text/html"
    || retentionPolicy.bootstrapSourceManifest?.captureHashedAssets !== true
    || !Number.isSafeInteger(retentionPolicy.bootstrapSourceManifest?.maxAssets)
    || retentionPolicy.bootstrapSourceManifest.maxAssets < 1
    || retentionPolicy.bootstrapSourceManifest.maxAssets > 2048
    || !/^[a-f0-9]{64}$/.test(
      retentionPolicy.bootstrapSourceManifest?.normalizedSha256 ?? ""
    )
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(
      retentionPolicy.bootstrapSourceManifest?.expiresAt ?? ""
    )
  ) {
    fail(configPath, "deployment bootstrap generations must declare exact migration assets");
  }
  for (const ref of retentionPolicy.bootstrapGenerationRefs) {
    const requiredAssets = retentionPolicy.bootstrapGenerationAssets[ref];
    if (
      !Array.isArray(requiredAssets)
      || requiredAssets.length === 0
      || requiredAssets.some((asset) => (
        !/^assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/.test(asset)
      ))
    ) {
      fail(configPath, `deployment bootstrap generation ${ref} has invalid migration assets`);
    }
  }
  const retainedAssets = new Map();
  const retainedGenerations = new Map();
  for (const generation of deploymentManifest.generations) {
    if (retentionPolicy.revokedGenerationIds.includes(generation.id)) {
      fail(configPath, `revoked deployment generation remains published: ${generation.id}`);
    }
    if (!Array.isArray(generation.assets) || generation.assets.length === 0) {
      fail(configPath, `deployment generation has no assets: ${generation.id}`);
    }
    retainedGenerations.set(generation.id, generation);
    for (const retained of generation.assets) {
      if (
        !/^assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/.test(retained.path)
        || retained.path.endsWith(".map")
      ) {
        fail(configPath, `invalid retained deployment asset: ${retained.path}`);
      }
      const known = retainedAssets.get(retained.path);
      if (
        known
        && (known.sha256 !== retained.sha256 || known.bytes !== retained.bytes)
      ) {
        fail(configPath, `retained deployment asset collision: ${retained.path}`);
      }
      retainedAssets.set(retained.path, retained);
    }
  }
  for (const ref of retentionPolicy.bootstrapGenerationRefs) {
    const generation = retainedGenerations.get(ref);
    if (!generation) continue;
    const generationPaths = new Set(generation.assets.map((asset) => asset.path));
    for (const requiredAsset of retentionPolicy.bootstrapGenerationAssets[ref]) {
      if (!generationPaths.has(requiredAsset)) {
        fail(configPath, `bootstrap generation ${ref} is missing ${requiredAsset}`);
      }
    }
  }
  const retainedBytes = [...retainedAssets.values()]
    .reduce((sum, asset) => sum + asset.bytes, 0);
  if (
    retainedBytes !== deploymentManifest.totalBytes
    || retainedBytes > retentionPolicy.maxBytes
  ) {
    fail(configPath, "deployment asset byte total exceeds or disagrees with the retention policy");
  }
  for (const [assetPath, retained] of retainedAssets) {
    const content = readFileSync(join(dirname(configPath), ...assetPath.split("/")));
    const actualDigest = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== retained.bytes || actualDigest !== retained.sha256) {
      fail(configPath, `retained deployment asset integrity mismatch: ${assetPath}`);
    }
  }
  const builtCodePaths = new Set(
    assets
      .filter((asset) => /\.(?:css|js)$/.test(asset))
      .map((asset) => relative(dirname(configPath), asset).replaceAll("\\", "/"))
  );
  if (
    builtCodePaths.size !== retainedAssets.size
    || [...builtCodePaths].some((path) => !retainedAssets.has(path))
  ) {
    fail(configPath, "dist JavaScript/CSS must exactly match the bounded deployment manifest");
  }
  const currentAssetPaths = new Set(
    deploymentManifest.generations[0].assets.map((asset) => asset.path)
  );
  const currentAssets = assets.filter((asset) =>
    currentAssetPaths.has(relative(dirname(configPath), asset).replaceAll("\\", "/"))
  );
  const galleryChunks = currentAssets.filter((asset) =>
    /^PhotoGallery-[A-Za-z0-9_-]{8,}\.js$/.test(basename(asset))
  );
  if (galleryChunks.length !== 1) {
    fail(configPath, "built assets must contain one deferred PhotoGallery chunk");
  }
  const authenticatedAppChunks = currentAssets.filter((asset) =>
    /^AuthenticatedApp-[A-Za-z0-9_-]{8,}\.js$/.test(basename(asset))
  );
  if (authenticatedAppChunks.length !== 1) {
    fail(configPath, "built assets must contain one deferred AuthenticatedApp chunk");
  }
  const registerFormChunks = currentAssets.filter((asset) =>
    /^RegisterForm-[A-Za-z0-9_-]{8,}\.js$/.test(basename(asset))
  );
  if (registerFormChunks.length !== 1) {
    fail(configPath, "built assets must contain one deferred RegisterForm chunk");
  }
  const whatsNewPopupChunks = currentAssets.filter((asset) =>
    /^WhatsNewPopup-[A-Za-z0-9_-]{8,}\.js$/.test(basename(asset))
  );
  if (whatsNewPopupChunks.length !== 1) {
    fail(configPath, "built assets must contain one deferred WhatsNewPopup chunk");
  }
  const pwaInstallEntryChunks = currentAssets.filter((asset) =>
    /^PwaInstallEntry-[A-Za-z0-9_-]{8,}\.js$/.test(basename(asset))
  );
  if (pwaInstallEntryChunks.length !== 1) {
    fail(configPath, "built assets must contain one deferred PWA install entry chunk");
  }
  const privateMetadataChunks = currentAssets.filter((asset) =>
    /^privateCachePurge-[A-Za-z0-9_-]{8,}\.js$/.test(basename(asset))
  );
  if (privateMetadataChunks.length !== 1) {
    fail(configPath, "built assets must contain one deferred private metadata cleanup chunk");
  }
  const entryStylesheets = currentAssets.filter((asset) =>
    /^index-[A-Za-z0-9_-]{8,}\.css$/.test(basename(asset))
  );
  if (entryStylesheets.length !== 1) {
    fail(configPath, "built assets must contain one login entry stylesheet");
  }
  const authenticatedStylesheets = currentAssets.filter((asset) =>
    /^AuthenticatedApp-[A-Za-z0-9_-]{8,}\.css$/.test(basename(asset))
  );
  if (authenticatedStylesheets.length !== 1) {
    fail(configPath, "built assets must contain one deferred AuthenticatedApp stylesheet");
  }
  const entryScripts = currentAssets.filter((asset) =>
    /^index-[A-Za-z0-9_-]{8,}\.js$/.test(basename(asset))
  );
  if (entryScripts.length !== 1) {
    fail(configPath, "built assets must contain one login entry script");
  }
  const entryStyles = readFileSync(entryStylesheets[0], "utf8");
  const authenticatedStyles = readFileSync(authenticatedStylesheets[0], "utf8");
  const entryScript = readFileSync(entryScripts[0], "utf8");
  const pwaInstallEntryScript = readFileSync(pwaInstallEntryChunks[0], "utf8");
  const builtJavaScript = currentAssets
    .filter((asset) => asset.endsWith(".js"))
    .map((asset) => readFileSync(asset, "utf8"))
    .join("\n");
  if (statSync(entryStylesheets[0]).size > 12_000) {
    fail(configPath, "built login entry stylesheet must stay below 12 kB");
  }
  if (statSync(entryScripts[0]).size > 36_000) {
    fail(configPath, "built login entry script must stay below 36 kB");
  }
  if (!pwaInstallEntryScript.includes("安装应用")) {
    fail(configPath, "deferred signed-out entry must expose the install application action");
  }
  if (authenticatedStyles.includes(".header-install-button")) {
    fail(configPath, "built authenticated CSS must not restore the permanent header install entry");
  }
  for (const marker of [
    "cloudphoto-photo-workspace-resolved-v1",
    "cloudphoto-grid-derivative-only-v1",
  ]) {
    if (!builtJavaScript.includes(marker)) {
      fail(configPath, `built workspace assets are missing media policy marker: ${marker}`);
    }
    if (
      !entryScript.includes("vite:preloadError")
      || !entryScript.includes("cf_deployment_recovery_v1")
    ) {
      fail(configPath, "login entry must carry pre-React stale chunk recovery");
    }
  }
  for (const workspaceMarker of [
    "Media route timed out",
    "No media candidate available",
    "Media preload failed",
    "/__cloudphoto-cache__/photo-lists/",
    "读取照片列表缓存失败:",
    "写入照片列表缓存失败:",
    ":group:",
    "正在创建账号…",
  ]) {
    if (entryScript.includes(workspaceMarker)) {
      fail(configPath, `workspace implementation leaked into login JavaScript: ${workspaceMarker}`);
    }
  }
  for (const selector of [".auth-page", ".app-splash", ".error-boundary-card"]) {
    if (!entryStyles.includes(selector)) fail(configPath, `built login CSS is missing ${selector}`);
  }
  for (const selector of [".app-header", ".photo-grid", ".workspace-sidebar"]) {
    if (entryStyles.includes(selector)) fail(configPath, `built login CSS contains ${selector}`);
    if (!authenticatedStyles.includes(selector)) {
      fail(configPath, `built authenticated CSS is missing ${selector}`);
    }
  }
  const serviceWorkerPath = join(dirname(configPath), "sw.js");
  let serviceWorker;
  try {
    serviceWorker = readFileSync(serviceWorkerPath, "utf8");
  } catch (error) {
    fail(configPath, `cannot inspect built service worker: ${error.message}`);
  }
  if (serviceWorker.includes(`assets/${basename(galleryChunks[0])}`)) {
    fail(configPath, "deferred PhotoGallery chunk must not be downloaded by the precache");
  }
  if (serviceWorker.includes(`assets/${basename(authenticatedAppChunks[0])}`)) {
    fail(configPath, "deferred AuthenticatedApp chunk must not be downloaded by the precache");
  }
  if (serviceWorker.includes(`assets/${basename(registerFormChunks[0])}`)) {
    fail(configPath, "deferred RegisterForm chunk must not be downloaded by the precache");
  }
  if (serviceWorker.includes(`assets/${basename(whatsNewPopupChunks[0])}`)) {
    fail(configPath, "deferred WhatsNewPopup chunk must not be downloaded by the precache");
  }
  if (serviceWorker.includes(`assets/${basename(pwaInstallEntryChunks[0])}`)) {
    fail(configPath, "PWA install entry must stay out of the app-shell precache");
  }
  if (serviceWorker.includes(`assets/${basename(authenticatedStylesheets[0])}`)) {
    fail(configPath, "deferred AuthenticatedApp styles must not be downloaded by the precache");
  }
  if (serviceWorker.includes(`assets/${basename(privateMetadataChunks[0])}`)) {
    fail(configPath, "private metadata cleanup must stay out of the app-shell precache");
  }
  if (!serviceWorker.includes("app-code-v1")) {
    fail(configPath, "service worker must cache deferred app chunks after first use");
  }
  if (serviceWorker.includes(".clientsClaim()")) {
    fail(configPath, "service worker must not activate or claim clients outside the update gate");
  }
  if (!serviceWorker.includes("SKIP_WAITING")) {
    fail(configPath, "service worker must support explicit waiting-worker activation");
  }
}

checkViteConfigModule();
checkAuthenticatedStyleBoundary();

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
  for (const [name, expected] of Object.entries(frontendSecurityHeaders)) {
    if (config.globalHeaders?.[name] !== expected) {
      fail(configPath, `global ${name} must be ${JSON.stringify(expected)}`);
    }
  }
  if (config.mimeTypes?.[".webmanifest"] !== "application/manifest+json") {
    fail(configPath, ".webmanifest must use application/manifest+json");
  }
  if (
    config.mimeTypes?.[".css"] !== "text/css"
    || config.mimeTypes?.[".js"] !== "text/javascript"
  ) {
    fail(configPath, "hashed JavaScript and CSS must keep explicit non-HTML MIME types");
  }
  let missingResponse;
  try {
    missingResponse = JSON.parse(readFileSync(missingResponsePath, "utf8"));
  } catch (error) {
    fail(missingResponsePath, `missing asset response must be valid JSON: ${error.message}`);
  }
  if (missingResponse?.error !== "not_found") {
    fail(missingResponsePath, "missing asset response must identify a not_found error");
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
  if (
    config.responseOverrides?.["404"]?.rewrite !== "/404.json"
    || config.responseOverrides?.["404"]?.statusCode !== 404
  ) {
    fail(configPath, "404 responses must remain 404 and use the non-HTML JSON error body");
  }

  checkHashedAssets(configPath);
  checkInstallMetadata(configPath);
  console.log(`Static cache contract passed: ${relative(process.cwd(), configPath)}`);
}
