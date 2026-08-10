import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const OLD_JS = "assets/AuthenticatedApp-oldbuild1.js";
const OLD_CSS = "assets/AuthenticatedApp-oldbuild1.css";

function browserCandidates() {
  return [
    process.env.BROWSER_BIN,
    process.platform === "win32"
      ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      : null,
    process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : null,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
}

async function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next known browser.
    }
  }
  return null;
}

class CdpClient {
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  constructor(url) {
    this.socket = new WebSocket(url);
  }

  async connect() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const listeners = this.#listeners.get(method) ?? new Set();
      this.#listeners.set(method, listeners);
      const timeout = setTimeout(() => {
        listeners.delete(onEvent);
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const onEvent = (params) => {
        clearTimeout(timeout);
        listeners.delete(onEvent);
        resolve(params);
      };
      listeners.add(onEvent);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async screenshot(path) {
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(path, Buffer.from(data, "base64"));
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      if (error instanceof BrowserLaunchError) throw error;
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for browser condition: ${String(last)}`);
}

class BrowserLaunchError extends Error {}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.pid === undefined) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function removeBrowserProfile(profile) {
  const transient = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!transient.has(error.code) || attempt === 19) throw error;
      await sleep(100 * (attempt + 1));
    }
  }
}

async function disposeBrowserProcess(child, browserClient, profile) {
  if (browserClient) {
    await Promise.race([
      browserClient.send("Browser.close").catch(() => {}),
      sleep(2_000),
    ]);
    browserClient.close();
  }
  if (!await waitForProcessExit(child, 5_000)) {
    child.kill();
    await waitForProcessExit(child, 5_000);
  }
  child.unref();
  await removeBrowserProfile(profile);
}

async function openPage(debugPort, url) {
  const target = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  ).then((response) => response.json());
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  return client;
}

export async function launchBrowser(executableOverride, profileParent = tmpdir()) {
  const executable = executableOverride ?? await findBrowser();
  if (!executable) return null;
  const profile = await mkdtemp(join(profileParent, "cloudphoto-browser-"));
  let child;
  let browserClient;
  try {
    child = spawn(executable, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-crash-reporter",
      "--disable-sync",
      "--disable-gpu",
      "--window-size=390,844",
      "about:blank",
    ], { stdio: "ignore" });
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
    });
    const portFile = join(profile, "DevToolsActivePort");
    const endpoint = await waitFor(async () => {
      if (spawnError) {
        throw new BrowserLaunchError(
          `Browser failed to start: ${spawnError.message}`,
          { cause: spawnError },
        );
      }
      try {
        const [port, path] = (await readFile(portFile, "utf8")).split(/\r?\n/);
        return Number(port) && path ? { debugPort: Number(port), path } : null;
      } catch {
        if (child.exitCode !== null) {
          throw new BrowserLaunchError(`Browser exited with ${child.exitCode}`);
        }
        return 0;
      }
    });
    browserClient = new CdpClient(
      `ws://127.0.0.1:${endpoint.debugPort}${endpoint.path}`,
    );
    await browserClient.connect();
    return {
      debugPort: endpoint.debugPort,
      profile,
      async dispose() {
        await disposeBrowserProcess(child, browserClient, profile);
      },
    };
  } catch (error) {
    if (child) await disposeBrowserProcess(child, browserClient, profile);
    else await removeBrowserProfile(profile);
    throw error;
  }
}

async function writeFixtureDist(root, kind) {
  const dist = join(root, kind);
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "404.json"), '{"error":"not_found"}');
  const old = kind === "old";
  const entryName = old ? "index-oldbuild1.js" : "index-newbuild1.js";
  await writeFile(join(dist, "index.html"), [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<script type="module" src="/assets/${entryName}"></script>`,
    "</head><body data-status=\"booting\">booting</body></html>",
  ].join(""));
  await writeFile(join(dist, "assets", entryName), old ? `
    document.body.dataset.status = "signed-out";
    document.body.textContent = "OLD_SHELL";
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    if (localStorage.getItem("authenticated") === "1") {
      document.body.dataset.status = "loading";
      const stylesheet = new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/${OLD_CSS}";
        link.onload = resolve;
        link.onerror = () => reject(new Error("old css failed"));
        document.head.append(link);
      });
      try {
        const [, workspace] = await Promise.all([
          stylesheet,
          import("/${OLD_JS}"),
        ]);
        document.body.dataset.status = "ready";
        document.body.textContent = workspace.label;
      } catch {
        document.body.dataset.status = "failed";
        document.body.textContent = "照片空间加载失败 / 刷新重试";
      }
    }
  ` : `
    document.body.dataset.status = "new";
    document.body.textContent = "NEW_SHELL";
    await navigator.serviceWorker.register("/sw.js");
  `);
  if (old) {
    await writeFile(join(dist, ...OLD_JS.split("/")), 'export const label = "OLD_LAZY_READY";');
    await writeFile(join(dist, ...OLD_CSS.split("/")), "body{background:rgb(224,255,224)}");
  }
  return dist;
}

function serviceWorker(version) {
  if (version === "new") {
    return `
      self.addEventListener("install", () => {});
      self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));
    `;
  }
  return `
    const CACHE = "old-app-shell-v1";
    self.addEventListener("install", (event) => {
      event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([
        "/index.html",
        "/assets/index-oldbuild1.js"
      ])));
      self.skipWaiting();
    });
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
    self.addEventListener("fetch", (event) => {
      const url = new URL(event.request.url);
      if (event.request.mode === "navigate") {
        event.respondWith(caches.match("/index.html"));
        return;
      }
      if (url.pathname.startsWith("/assets/")) {
        event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
      }
    });
  `;
}

async function createServer(oldDist, newDist) {
  let deployment = "old";
  const config = JSON.parse(await readFile(
    new URL("../packages/client/public/staticwebapp.config.json", import.meta.url),
    "utf8",
  ));
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const dist = deployment === "old" ? oldDist : newDist;
    if (url.pathname === "/sw.js") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/javascript",
      });
      response.end(serviceWorker(deployment));
      return;
    }
    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    try {
      const body = await readFile(join(dist, ...relativePath.split("/")));
      const contentType = relativePath.endsWith(".css")
        ? "text/css"
        : relativePath.endsWith(".js")
          ? "text/javascript"
          : relativePath.endsWith(".json")
            ? "application/json"
            : "text/html";
      response.writeHead(200, { "cache-control": "no-cache", "content-type": contentType });
      response.end(body);
    } catch {
      const rewrite = config.responseOverrides?.["404"]?.rewrite;
      if (rewrite) {
        const body = await readFile(join(dist, rewrite.replace(/^\//, "")));
        response.writeHead(404, { "content-type": "application/json" });
        response.end(body);
        return;
      }
      response.writeHead(404, { "content-type": "text/html" });
      response.end("<!doctype html><title>Not Found</title>");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    deployNew() {
      deployment = "new";
    },
    async dispose() {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    },
  };
}

async function runScenario({ retain, evidenceName, emulateStandalone = false }) {
  const browser = await launchBrowser();
  if (!browser) return { skipped: true };
  const root = await mkdtemp(join(tmpdir(), "cloudphoto-stale-deploy-"));
  let firstPage;
  let secondPage;
  let server;
  try {
    const oldDist = await writeFixtureDist(root, "old");
    const newDist = await writeFixtureDist(root, "new");
    if (retain) {
      const { mergeDeploymentAssets, manifestFromDist } =
        await import("./deployment-assets.mjs");
      const previousManifest = await manifestFromDist({
        distDir: oldDist,
        generationId: "old-generation",
      });
      await mergeDeploymentAssets({
        distDir: newDist,
        generationId: "new-generation",
        previousManifest,
        fetchAsset: async (asset) => readFile(join(oldDist, ...asset.path.split("/"))),
        config: {
          maxGenerations: 24,
          maxBytes: 64 * 1024 * 1024,
          revokedGenerationIds: [],
        },
      });
    }
    server = await createServer(oldDist, newDist);
    firstPage = await openPage(browser.debugPort, server.origin);
    if (emulateStandalone) {
      await firstPage.send("Page.addScriptToEvaluateOnNewDocument", {
        source: 'Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });',
      });
    }
    await waitFor(() => firstPage.evaluate(
      "navigator.serviceWorker.ready.then(() => true)",
    ));
    const loaded = firstPage.waitFor("Page.loadEventFired");
    await firstPage.send("Page.navigate", { url: `${server.origin}/` });
    await loaded;
    await waitFor(() => firstPage.evaluate("Boolean(navigator.serviceWorker.controller)"));
    await firstPage.evaluate('localStorage.setItem("authenticated", "1")');
    if (emulateStandalone) {
      assert.equal(
        await firstPage.evaluate("navigator.standalone === true"),
        true,
      );
    }

    server.deployNew();
    secondPage = await openPage(browser.debugPort, `${server.origin}/`);
    if (emulateStandalone) {
      await secondPage.send("Page.addScriptToEvaluateOnNewDocument", {
        source: 'Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });',
      });
      const loadedStandalone = secondPage.waitFor("Page.loadEventFired");
      await secondPage.send("Page.reload", { ignoreCache: false });
      await loadedStandalone;
    }
    const status = await waitFor(async () => {
      const value = await secondPage.evaluate("document.body.dataset.status");
      return ["ready", "failed"].includes(value) ? value : "";
    });
    const evidenceDir = process.env.STALE_DEPLOYMENT_EVIDENCE_DIR;
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await secondPage.screenshot(join(evidenceDir, `${evidenceName}.png`));
    }
    const firstStatus = await firstPage.evaluate("document.body.dataset.status");
    const waiting = await waitFor(() => secondPage.evaluate(`
      navigator.serviceWorker.getRegistration().then((registration) =>
        registration?.waiting?.state === "installed"
      )
    `));
    const missingResponses = await secondPage.evaluate(`
      Promise.all(["js", "css"].map((extension) =>
        fetch("/assets/never-existed1." + extension).then(async (response) => ({
          extension,
          status: response.status,
          type: response.headers.get("content-type"),
          text: await response.text()
        }))
      ))
    `);
    return {
      firstStatus,
      missingResponses,
      skipped: false,
      status,
      waiting,
    };
  } finally {
    firstPage?.close();
    secondPage?.close();
    await server?.dispose();
    await browser.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("browser launch failure removes its isolated profile", async () => {
  const profileParent = await mkdtemp(join(tmpdir(), "cloudphoto-browser-launch-test-"));
  try {
    await assert.rejects(
      launchBrowser(process.execPath, profileParent),
      /Browser exited/,
    );
    assert.deepEqual(await readdir(profileParent), []);
  } finally {
    await rm(profileParent, { recursive: true, force: true });
  }
});

test("browser spawn error removes its isolated profile", async () => {
  const profileParent = await mkdtemp(join(tmpdir(), "cloudphoto-browser-spawn-test-"));
  try {
    await assert.rejects(
      launchBrowser(join(profileParent, "missing-browser"), profileParent),
      /Browser (?:failed to start|exited)/,
    );
    assert.deepEqual(await readdir(profileParent), []);
  } finally {
    await rm(profileParent, { recursive: true, force: true });
  }
});

test("RED: old active app-shell fails when the new deployment deletes lazy CSS/JS", async (t) => {
  const result = await runScenario({
    retain: false,
    evidenceName: "before-stale-deployment",
  });
  if (result.skipped) {
    t.skip("Chrome or Edge is unavailable");
    return;
  }
  assert.equal(result.status, "failed");
  assert.equal(result.firstStatus, "signed-out");
  assert.equal(result.waiting, true);
  assert.deepEqual(
    result.missingResponses.map(({ extension }) => extension),
    ["js", "css"],
  );
  for (const response of result.missingResponses) {
    assert.match(response.type, /application\/json/);
  }
});

test("retained assets recover an idle new tab without activating the waiting worker", async (t) => {
  const result = await runScenario({
    retain: true,
    evidenceName: "after-stale-deployment",
  });
  if (result.skipped) {
    t.skip("Chrome or Edge is unavailable");
    return;
  }
  assert.equal(result.status, "ready");
  assert.equal(result.firstStatus, "signed-out");
  assert.equal(result.waiting, true);
  for (const response of result.missingResponses) {
    assert.equal(response.status, 404);
    assert.match(response.type, /application\/json/);
    assert.doesNotMatch(response.text, /<!doctype html>/i);
  }
});

test("standalone display mode uses the same retained lazy-asset recovery", async (t) => {
  const result = await runScenario({
    retain: true,
    evidenceName: "after-stale-deployment-standalone",
    emulateStandalone: true,
  });
  if (result.skipped) {
    t.skip("Chrome or Edge is unavailable");
    return;
  }
  assert.equal(result.status, "ready");
  assert.equal(result.waiting, true);
});
