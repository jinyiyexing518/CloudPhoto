import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const distRoot = new URL("../packages/client/dist/", import.meta.url);
const evidenceRoot = process.env.COVER_EVIDENCE_DIR
  ? process.env.COVER_EVIDENCE_DIR
  : join(tmpdir(), "cloudphoto-cover-evidence");
const PHOTO_COUNT = 8;
const COVER_DEADLINE_MS = 6_000;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAHgQCAf6Y1S0AAAAASUVORK5CYII=",
  "base64",
);

function browserCandidates() {
  return [
    process.env.BROWSER_BIN,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
}

async function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  return null;
}

class CdpClient {
  #id = 0;
  #pending = new Map();

  constructor(url) {
    this.socket = new WebSocket(url);
  }

  async connect() {
    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolve, reject) => {
        this.socket.addEventListener("open", resolve, { once: true });
        this.socket.addEventListener("error", reject, { once: true });
      });
    }
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
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

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

let fixtureClientBuild;

function buildFixtureClient() {
  if (fixtureClientBuild) return fixtureClientBuild;
  const buildEnvironment = {
    ...process.env,
    VITE_BLOB_MEDIA_BASE: "/media",
    VITE_MEDIA_PROXY_BASE: "/media",
  };
  const command = process.env.npm_execpath ? process.execPath : "yarn";
  const args = process.env.npm_execpath
    ? [process.env.npm_execpath, "workspace", "cloudphoto-client", "build"]
    : ["workspace", "cloudphoto-client", "build"];
  fixtureClientBuild = new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: buildEnvironment,
      shell: command === "yarn" && process.platform === "win32",
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Synthetic cover fixture build exited ${code}`));
    });
  });
  return fixtureClientBuild;
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for browser condition: ${String(last)}`);
}

async function launchBrowser(executable) {
  const profile = await mkdtemp(join(tmpdir(), "cloudphoto-cover-browser-"));
  const child = spawn(executable, [
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
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  const endpoint = await waitFor(async () => {
    const [port, path] = (await readFile(portFile, "utf8")).split(/\r?\n/);
    return Number(port) && path ? { port: Number(port), path } : null;
  });
  const browserClient = new CdpClient(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`);
  await browserClient.connect();
  return {
    port: endpoint.port,
    profile,
    child,
    browserClient,
    async dispose() {
      await browserClient.send("Browser.close").catch(() => undefined);
      browserClient.close();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(5_000),
      ]);
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          sleep(5_000),
        ]);
      }
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    },
  };
}

async function openPage(browser, bootstrapSource) {
  const target = await fetch(
    `http://127.0.0.1:${browser.port}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  ).then((response) => response.json());
  const page = new CdpClient(target.webSocketDebuggerUrl);
  await page.connect();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrapSource });
  return page;
}

function jwt(userId, role = "viewer") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ userId, role })}.signature`;
}

function userForToken(authorization) {
  const token = authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (typeof payload.userId !== "string") return null;
    return {
      id: payload.userId,
      username: payload.userId,
      email: `${payload.userId}@synthetic.invalid`,
      displayName: payload.userId,
      role: payload.role === "admin" ? "admin" : "viewer",
    };
  } catch {
    return null;
  }
}

function photosFor(userId) {
  return Array.from({ length: PHOTO_COUNT }, (_, index) => ({
    name: `${userId}/photo-${index + 1}.jpg`,
    originalName: `photo-${index + 1}.jpg`,
    url: `/media/${userId}/original-${index + 1}.jpg?sig=${userId}`,
    thumbnailUrl: `/media/${userId}/thumb-${index + 1}.png?sig=${userId}`,
    previewUrl: `/media/${userId}/preview-${index + 1}.png?sig=${userId}`,
    size: 1024,
    lastModified: "2026-08-12T08:00:00.000Z",
    createdAt: "2026-08-12T08:00:00.000Z",
    contentType: "image/jpeg",
  }));
}

function contentType(pathname) {
  switch (extname(pathname)) {
    case ".css": return "text/css";
    case ".html": return "text/html";
    case ".js": return "text/javascript";
    case ".json": return "application/json";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    default: return "application/octet-stream";
  }
}

async function createFixtureServer({
  fenceMode = "pending",
  initialMediaMode = "success",
} = {}) {
  let mediaMode = initialMediaMode;
  const stalledMediaResponses = new Set();
  const stats = {
    apiPhotos: 0,
    media: [],
  };
  const fenceScript = fenceMode === "pending" ? `
    (() => {
      let generation = 0;
      let enabled = false;
      let ready = false;
      let releaseFence;
      const stats = { reads: 0, writes: 0 };
      const fenceReady = new Promise((resolve) => {
        releaseFence = resolve;
      });
      const publish = () => {
        self.__cloudPhotoPrivateCacheGeneration = generation;
        self.__cloudPhotoPrivateCacheEnabled = enabled;
      };
      publish();
      self.__cloudPhotoPrivateCacheFenceReady = fenceReady;
      self.__cloudPhotoPrivateMediaCachePolicy = {
        snapshot: () => ({ generation, enabled, ready }),
        async read() {
          stats.reads += 1;
          return null;
        },
        async write() {
          stats.writes += 1;
          return false;
        },
        async cleanup() {
          return true;
        },
      };
      const reply = (event, body) => {
        try {
          event.ports[0]?.postMessage(body);
        } catch {
          // The synthetic page may have navigated after requesting the state.
        }
      };
      let commandChain = self.__cloudPhotoPrivateCacheFenceReady;
      self.addEventListener("message", (event) => {
        if (event.data?.type === "cover-fixture-control") {
          if (event.data.command === "release") {
            generation = 99;
            enabled = true;
            ready = true;
            publish();
            releaseFence();
          }
          reply(event, { generation, enabled, ready, ...stats });
          return;
        }
        if (event.data?.type !== "cloudphoto-private-cache-fence") return;
        commandChain = commandChain.then(() => {
          reply(event, { ok: false, generation });
        });
        event.waitUntil(commandChain);
      });
    })();
  ` : `
    (() => {
      const generation = 0;
      const enabled = false;
      const ready = true;
      const stats = { reads: 0, writes: 0 };
      const cacheStorage = { open: 0, match: 0, put: 0 };
      const mediaCacheName = "photo-media-v1";
      const originalOpen = CacheStorage.prototype.open;
      const originalStorageMatch = CacheStorage.prototype.match;
      const originalMatch = Cache.prototype.match;
      const originalPut = Cache.prototype.put;
      let cacheAuditArmed = false;
      let staleSeeded = false;
      const staleCacheReady = (async () => {
        const cache = await originalOpen.call(self.caches, mediaCacheName);
        const staleRequest = new Request(new URL(
          "/media/owner-a/thumb-1.png?sig=owner-a&cf_cover=1",
          self.location.origin,
        ));
        const staleBytes = Uint8Array.from(
          atob(${JSON.stringify(PNG.toString("base64"))}),
          (character) => character.charCodeAt(0),
        );
        await originalPut.call(
          cache,
          staleRequest,
          new Response(staleBytes, {
            status: 200,
            headers: {
              "content-type": "image/png",
              "x-cloudphoto-private-cache-generation": "999",
              "x-cloudphoto-private-cached-at": String(Date.now()),
            },
          }),
        );
        staleSeeded = Boolean(await originalMatch.call(cache, staleRequest));
      })();
      Object.defineProperty(CacheStorage.prototype, "open", {
        configurable: true,
        value(name) {
          if (cacheAuditArmed && name === mediaCacheName) cacheStorage.open += 1;
          return originalOpen.call(this, name);
        },
      });
      Object.defineProperty(Cache.prototype, "match", {
        configurable: true,
        value(request, options) {
          const url = new URL(
            typeof request === "string" ? request : request.url,
            self.location.origin,
          );
          if (cacheAuditArmed && url.pathname.startsWith("/media/")) {
            cacheStorage.match += 1;
          }
          return originalMatch.call(this, request, options);
        },
      });
      Object.defineProperty(CacheStorage.prototype, "match", {
        configurable: true,
        value(request, options) {
          const url = new URL(
            typeof request === "string" ? request : request.url,
            self.location.origin,
          );
          if (cacheAuditArmed && url.pathname.startsWith("/media/")) {
            cacheStorage.match += 1;
          }
          return originalStorageMatch.call(this, request, options);
        },
      });
      Object.defineProperty(Cache.prototype, "put", {
        configurable: true,
        value(request, response) {
          const url = new URL(
            typeof request === "string" ? request : request.url,
            self.location.origin,
          );
          if (cacheAuditArmed && url.pathname.startsWith("/media/")) {
            cacheStorage.put += 1;
          }
          return originalPut.call(this, request, response);
        },
      });
      self.__cloudPhotoPrivateCacheGeneration = generation;
      self.__cloudPhotoPrivateCacheEnabled = enabled;
      self.__cloudPhotoPrivateCacheFenceReady = Promise.resolve();
      self.__cloudPhotoPrivateMediaCachePolicy = {
        snapshot: () => ({ generation, enabled, ready }),
        async read() {
          stats.reads += 1;
          return null;
        },
        async write() {
          stats.writes += 1;
          return false;
        },
        async cleanup() {
          return true;
        },
      };
      self.addEventListener("message", (event) => {
        if (event.data?.type === "cover-fixture-control") {
          const respond = async () => {
            await staleCacheReady;
            if (event.data.command === "arm-cache-audit") {
              cacheStorage.open = 0;
              cacheStorage.match = 0;
              cacheStorage.put = 0;
              cacheAuditArmed = true;
            }
            try {
              event.ports[0]?.postMessage({
                generation,
                enabled,
                ready,
                staleSeeded,
                cacheStorage,
                ...stats,
              });
            } catch {
              // The synthetic page may have navigated after requesting the state.
            }
          };
          event.waitUntil(respond());
          return;
        }
        if (event.data?.type !== "cloudphoto-private-cache-fence") return;
        try {
          event.ports[0]?.postMessage({ ok: false, generation });
        } catch {
          // The synthetic page may have navigated after requesting the state.
        }
        event.waitUntil(Promise.resolve());
      });
    })();
  `;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/private-cache-fence.js") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/javascript",
      });
      response.end(fenceScript);
      return;
    }
    if (url.pathname === "/api/auth/me") {
      const user = userForToken(request.headers.authorization);
      response.writeHead(user ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(user ?? { error: "Unauthorized" }));
      return;
    }
    if (url.pathname === "/api/groups") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    if (url.pathname === "/api/photos") {
      stats.apiPhotos += 1;
      const user = userForToken(request.headers.authorization);
      response.writeHead(user ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(user ? photosFor(user.id) : { error: "Unauthorized" }));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      stats.media.push({ mode: mediaMode, path: url.pathname });
      if (
        mediaMode === "stall"
        || (mediaMode === "stall-thumbnail" && url.pathname.endsWith("/thumb-1.png"))
      ) {
        stalledMediaResponses.add(response);
        response.once("close", () => stalledMediaResponses.delete(response));
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "image/png",
        });
        response.flushHeaders();
      } else if (mediaMode === "failure") {
        response.writeHead(503, { "cache-control": "no-store" });
        response.end();
      } else {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "image/png",
        });
        response.end(PNG);
      }
      return;
    }
    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    try {
      const body = await readFile(new URL(relativePath, distRoot));
      response.writeHead(200, {
        "cache-control": relativePath === "sw.js" ? "no-store" : "no-cache",
        "content-type": contentType(relativePath),
        ...(relativePath === "sw.js" ? { "service-worker-allowed": "/" } : {}),
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stats,
    setMediaMode(next) {
      mediaMode = next;
    },
    releaseStalledMedia() {
      for (const response of stalledMediaResponses) response.destroy();
      stalledMediaResponses.clear();
    },
    async close() {
      this.releaseStalledMedia();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function bootstrapSource(token) {
  return `
    (() => {
      if (!location.origin.startsWith("http://127.0.0.1:")) return;
      const activeToken = sessionStorage.getItem("__cover_test_token")
        ?? ${JSON.stringify(token)};
      localStorage.setItem("cloudphoto_token", activeToken);
      localStorage.removeItem("cloudphoto_private_cache_owner_v1");
      localStorage.removeItem("cloudphoto_private_cleanup_v2");
      window.__coverProbe = { cacheDeletes: 0, indexedDbOpens: 0 };
      const originalDelete = CacheStorage.prototype.delete;
      CacheStorage.prototype.delete = function(name) {
        window.__coverProbe.cacheDeletes += 1;
        if (name === "photo-media-v1" || name === "cf-media-v1") {
          return Promise.reject(new Error("Synthetic private cache deletion rejection"));
        }
        return originalDelete.call(this, name);
      };
      const originalOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function(name, ...args) {
        window.__coverProbe.indexedDbOpens += 1;
        if (name === "workbox-expiration") return {};
        return originalOpen.call(this, name, ...args);
      };
    })();
  `;
}

async function setViewport(page, width, height, mobile) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
}

let navigationSequence = 0;

async function navigate(page, url) {
  const target = new URL(url);
  target.searchParams.set("cover_fixture_navigation", String(++navigationSequence));
  await page.send("Page.navigate", { url: target.href });
  await waitFor(() => page.evaluate(
    `location.href === ${JSON.stringify(target.href)} && document.readyState !== "loading"`,
  ));
}

async function waitForCards(page) {
  await waitFor(() => page.evaluate(
    `document.querySelectorAll(".photo-card .photo-thumbnail img").length >= ${PHOTO_COUNT}`,
  ), 20_000);
}

async function waitForServiceWorker(page) {
  await waitFor(() => page.evaluate(
    `navigator.serviceWorker.ready.then(() => true)`,
  ), 15_000);
}

async function ensureServiceWorkerControl(page, origin) {
  await waitForServiceWorker(page);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await page.evaluate("navigator.serviceWorker.controller !== null")) return;
    await navigate(page, origin);
  }
  throw new Error("Synthetic fixture page never became service-worker controlled");
}

async function fenceControl(page, command = "stats") {
  return page.evaluate(`new Promise((resolve, reject) => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      reject(new Error("No service-worker controller"));
      return;
    }
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error("Fence control timed out"));
    }, 2000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(data);
    };
    controller.postMessage(
      { type: "cover-fixture-control", command: ${JSON.stringify(command)} },
      [channel.port2],
    );
  })`);
}

async function coverState(page) {
  return page.evaluate(`(() => {
    const cards = [...document.querySelectorAll(".photo-card")].slice(0, ${PHOTO_COUNT});
    const images = cards.map((card) => card.querySelector(".photo-thumbnail img"));
    return {
      cardCount: cards.length,
      loading: cards.filter((card) => card.querySelector(".photo-skeleton, .img-loading")).length,
      errors: cards.filter((card) => card.querySelector(".photo-thumb-error")).length,
      loaded: images.filter((image) => image?.complete && image.naturalWidth > 0).length,
      imagePaths: images.map((image) => {
        if (!image?.src) return null;
        const url = new URL(image.src);
        return url.pathname;
      }),
      cacheCalls: window.__coverProbe ?? null,
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    };
  })()`);
}

test("pending worker readiness cannot block authorized cover network delivery", async (t) => {
  const executable = await findBrowser();
  if (!executable) {
    t.skip("No Chromium browser is installed");
    return;
  }
  await buildFixtureClient();
  await mkdir(evidenceRoot, { recursive: true });
  const fixture = await createFixtureServer();
  const browser = await launchBrowser(executable);
  const ownerAToken = jwt("owner-a");
  const ownerBToken = jwt("owner-b");
  const page = await openPage(browser, bootstrapSource(ownerAToken));
  const observations = [];
  try {
    await setViewport(page, 390, 844, true);
    await navigate(page, fixture.origin);
    await waitForCards(page);
    await ensureServiceWorkerControl(page, fixture.origin);

    const mediaBeforeControl = fixture.stats.media.length;
    await navigate(page, fixture.origin);
    await waitForCards(page);
    await sleep(COVER_DEADLINE_MS);
    const mobile = await coverState(page);
    mobile.mediaRequests = fixture.stats.media.length - mediaBeforeControl;
    observations.push({ viewport: "390x844", ...mobile });
    await page.screenshot(join(evidenceRoot, "photo-covers-mobile.png"));
    console.log(JSON.stringify({
      redPath: "pending-worker-readiness",
      mediaRequests: mobile.mediaRequests,
      state: mobile,
    }, null, 2));
    assert.equal(mobile.loading, 0, "pending worker readiness must not retain mobile skeletons");
    assert.equal(mobile.loaded, PHOTO_COUNT, "pending worker readiness must still reach mobile media");

    await setViewport(page, 1280, 900, false);
    const mediaBeforeDesktop = fixture.stats.media.length;
    await navigate(page, fixture.origin);
    await waitForCards(page);
    await sleep(COVER_DEADLINE_MS);
    const desktop = await coverState(page);
    desktop.mediaRequests = fixture.stats.media.length - mediaBeforeDesktop;
    observations.push({ viewport: "1280x900", ...desktop });
    await page.screenshot(join(evidenceRoot, "photo-covers-desktop.png"));

    fixture.setMediaMode("failure");
    await navigate(page, fixture.origin);
    await waitForCards(page);
    await sleep(COVER_DEADLINE_MS);
    const failed = await coverState(page);
    observations.push({ phase: "network-failure", ...failed });
    await page.screenshot(join(evidenceRoot, "photo-covers-network-failure.png"));

    fixture.setMediaMode("success");
    if (failed.errors > 0) {
      await page.evaluate(`document.querySelector(".photo-thumb-error")?.closest(".photo-card-primary")?.click()`);
      try {
        await waitFor(async () => (await coverState(page)).loaded > 0, 10_000);
      } catch (error) {
        console.error(JSON.stringify({
          retryState: await coverState(page),
          recentMediaRequests: fixture.stats.media.slice(-20),
        }, null, 2));
        throw error;
      }
    }
    const retried = await coverState(page);
    observations.push({ phase: "retry", ...retried });

    fixture.setMediaMode("stall");
    await navigate(page, fixture.origin);
    await waitForCards(page);
    await waitFor(async () => {
      const state = await coverState(page);
      return state.errors === PHOTO_COUNT && state.loading === 0;
    }, 20_000);
    const stalled = await coverState(page);
    observations.push({ phase: "stalled-response-body", ...stalled });

    fixture.releaseStalledMedia();
    fixture.setMediaMode("success");
    await page.evaluate(`(() => {
      const oldValue = localStorage.getItem("cloudphoto_token");
      localStorage.removeItem("cloudphoto_token");
      window.dispatchEvent(new StorageEvent("storage", {
        key: "cloudphoto_token",
        oldValue,
        newValue: null,
      }));
    })()`);
    await waitFor(() => page.evaluate(`document.querySelector(".auth-page") !== null`), 10_000);
    await page.evaluate(
      `sessionStorage.setItem("__cover_test_token", ${JSON.stringify(ownerBToken)})`,
    );
    await navigate(page, fixture.origin);
    await waitForCards(page);
    await sleep(COVER_DEADLINE_MS);
    const switched = await coverState(page);
    observations.push({ phase: "logout-login-scope-switch", ...switched });
    const beforeLateFence = await fenceControl(page);
    const afterLateFence = await fenceControl(page, "release");
    await sleep(250);
    const settledLateFence = await fenceControl(page);
    observations.push({
      phase: "late-fence-settlement",
      before: beforeLateFence,
      released: afterLateFence,
      settled: settledLateFence,
    });

    console.log(JSON.stringify({
      apiPhotoRequests: fixture.stats.apiPhotos,
      mediaRequests: fixture.stats.media,
      observations,
    }, null, 2));

    for (const observation of observations.filter((item) => item.viewport)) {
      assert.equal(observation.cardCount, PHOTO_COUNT);
      assert.equal(observation.loading, 0, `${observation.viewport} covers exceeded the wall-clock loading bound`);
      assert.equal(observation.errors, 0, `${observation.viewport} successful network covers must not fail`);
      assert.equal(observation.loaded, PHOTO_COUNT, `${observation.viewport} network covers must render`);
      assert.ok(observation.mediaRequests >= PHOTO_COUNT, `${observation.viewport} must reach the media network`);
    }
    assert.equal(failed.loading, 0, "failed media requests must leave the loading state");
    assert.equal(failed.errors, PHOTO_COUNT, "failed media requests must expose a terminal retry state");
    assert.ok(retried.loaded > 0, "retrying a terminal cover error must issue a fresh successful request");
    assert.equal(stalled.loading, 0, "stalled media response bodies must leave loading within the request deadline");
    assert.equal(stalled.errors, PHOTO_COUNT, "stalled media response bodies must expose the retry state");
    assert.equal(switched.loading, 0, "logout/login scope changes must not revive the old loading state");
    assert.equal(switched.errors, 0, "the replacement scope must render its successful covers");
    assert.equal(switched.cardCount, PHOTO_COUNT, "the replacement scope must publish its photo cards");
    assert.ok(
      switched.imagePaths.every((source) => source?.includes("/media/owner-b/")),
      "the replacement scope must never reuse owner-a cover URLs",
    );
    assert.equal(
      settledLateFence.writes,
      beforeLateFence.writes,
      "late fence settlement must not authorize writes for expired requests",
    );
  } finally {
    page.close();
    await browser.dispose();
    await fixture.close();
  }
});

test("disabled cache plus a stalled authorized source advances then terminates", async (t) => {
  const executable = await findBrowser();
  if (!executable) {
    t.skip("No Chromium browser is installed");
    return;
  }
  await buildFixtureClient();
  await mkdir(evidenceRoot, { recursive: true });
  const fixture = await createFixtureServer({
    fenceMode: "disabled",
    initialMediaMode: "success",
  });
  const browser = await launchBrowser(executable);
  const page = await openPage(browser, bootstrapSource(jwt("owner-a")));
  try {
    await setViewport(page, 390, 844, true);
    await navigate(page, fixture.origin);
    await waitForCards(page);
    await ensureServiceWorkerControl(page, fixture.origin);
    const cacheAudit = await fenceControl(page, "arm-cache-audit");
    assert.equal(cacheAudit.staleSeeded, true, "the degraded path must be tested with stale private bytes");
    fixture.setMediaMode("stall-thumbnail");
    const mediaBeforeFallback = fixture.stats.media.length;
    await navigate(page, fixture.origin);
    try {
      await waitFor(() => page.evaluate(
        `document.querySelectorAll(".photo-card").length >= ${PHOTO_COUNT}`,
      ), 12_000);
      await waitFor(async () => {
        const state = await coverState(page);
        return state.loaded === PHOTO_COUNT && state.loading === 0 && state.errors === 0;
      }, 12_000);
    } catch (error) {
      const cacheStats = await fenceControl(page).catch((controlError) => ({
        controlError: controlError.message,
      }));
      console.error(JSON.stringify({
        redPath: "disabled-cache-stalled-authorized-source",
        state: await coverState(page),
        mediaRequests: fixture.stats.media.slice(mediaBeforeFallback),
        cacheStats,
      }, null, 2));
      throw error;
    }
    const fallback = await coverState(page);
    fallback.mediaRequests = fixture.stats.media.length - mediaBeforeFallback;
    await page.screenshot(join(evidenceRoot, "photo-covers-source-fallback.png"));
    assert.equal(fallback.loaded, PHOTO_COUNT);
    assert.equal(fallback.errors, 0);
    assert.equal(fallback.mediaRequests, 9, "disabled cache mode must reach all authorized media requests");
    assert.ok(
      fixture.stats.media.slice(mediaBeforeFallback).some(
        ({ path }) => path.includes("/preview-"),
      ),
      "a stalled thumbnail must advance to an existing authorized preview",
    );

    fixture.setMediaMode("stall");
    await setViewport(page, 1280, 900, false);
    await navigate(page, fixture.origin);
    await waitForCards(page);
    await waitFor(async () => {
      const state = await coverState(page);
      return state.errors === PHOTO_COUNT && state.loading === 0;
    }, 12_000);
    const terminal = await coverState(page);
    await page.screenshot(join(evidenceRoot, "photo-covers-source-terminal.png"));
    const cacheStats = await fenceControl(page);
    console.log(JSON.stringify({
      redPath: "disabled-cache-stalled-authorized-source",
      fallback,
      terminal,
      cacheStats,
    }, null, 2));
    assert.equal(terminal.errors, PHOTO_COUNT);
    assert.equal(terminal.loading, 0);
    assert.equal(cacheStats.reads, 0, "disabled cache mode must bypass private cache reads");
    assert.equal(cacheStats.writes, 0, "disabled cache mode must bypass private cache writes");
    assert.deepEqual(
      cacheStats.cacheStorage,
      { open: 0, match: 0, put: 0 },
      "disabled cache mode must bypass photo-media-v1 CacheStorage completely",
    );
  } finally {
    fixture.releaseStalledMedia();
    page.close();
    await browser.dispose();
    await fixture.close();
  }
});
