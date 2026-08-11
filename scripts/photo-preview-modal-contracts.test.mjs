import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const stylesPath = join(repoRoot, "packages/client/src/authenticated.css");
const indexStylesPath = join(repoRoot, "packages/client/src/index.css");
const styles = readFileSync(stylesPath, "utf8");
const browser = [
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
]
  .filter(Boolean)
  .find((candidate) => existsSync(candidate));

if (process.env.CI && !browser) {
  throw new Error("Chromium is required for the photo preview geometry contract");
}

function conditionalBlock(marker) {
  const start = styles.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const open = styles.indexOf("{", start);
  let depth = 1;
  for (let index = open + 1; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] === "}") depth -= 1;
    if (depth === 0) return styles.slice(open + 1, index);
  }
  assert.fail(`unterminated ${marker}`);
}

function cssBlock(selector, source = styles) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert(match, `missing CSS block for ${selector}`);
  return match[1];
}

function declaration(block, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escaped}\\s*:\\s*([^;]+)`));
  assert(match, `missing ${property} declaration`);
  return match[1].trim();
}

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

test("opened-photo preview retains the accepted desktop size and contain fit", () => {
  const mobile = conditionalBlock("@media (max-width: 680px)");
  const desktop = conditionalBlock(
    "/* Desktop modal: two-panel side-by-side layout */",
  );

  assert.equal(
    declaration(
      cssBlock(".modal-content:not(.modal-content--fullscreen)", desktop),
      "max-width",
    ),
    "min(90vw, 1080px)",
  );
  assert.equal(
    declaration(
      cssBlock(".modal-content:not(.modal-content--fullscreen)", desktop),
      "max-height",
    ),
    "88vh",
  );
  assert.equal(
    declaration(
      cssBlock(
        ".modal-content:not(.modal-content--fullscreen) .modal-image-pane",
        desktop,
      ),
      "flex",
    ),
    "0 0 58%",
  );
  assert.equal(
    declaration(
      cssBlock(
        ".modal-content:not(.modal-content--fullscreen) .modal-image",
        desktop,
      ),
      "max-height",
    ),
    "88vh",
  );
  assert.equal(
    declaration(
      cssBlock(
        ".modal-content:not(.modal-content--fullscreen) .modal-info",
        desktop,
      ),
      "max-height",
    ),
    "88vh",
  );
  assert.equal(
    declaration(cssBlock(".modal-content--fullscreen", desktop), "max-width"),
    "min(92vw, 1160px)",
  );
  assert.equal(
    declaration(
      cssBlock(".modal-content--fullscreen .modal-image-pane", desktop),
      "flex",
    ),
    "0 0 68%",
  );

  assert.equal(
    declaration(cssBlock(".modal-image-pane", mobile), "max-height"),
    "42vh",
  );
  assert.equal(
    declaration(cssBlock(".modal-image", mobile), "max-height"),
    "42vh",
  );
  assert.equal(declaration(cssBlock("\n.modal-image"), "object-fit"), "contain");
  assert.equal(
    declaration(
      cssBlock(".modal-content--fullscreen .modal-image"),
      "max-height",
    ),
    "calc(100vh - 120px)",
  );
  assert.equal(
    declaration(cssBlock(".modal-content--fullscreen"), "width"),
    "100vw",
  );
});

test(
  "opened-photo fixture stays bounded at phone, tablet, and desktop viewports",
  { skip: !browser },
  async () => {
    const evidenceDir =
      process.env.PHOTO_PREVIEW_EVIDENCE_DIR ??
      join(tmpdir(), "cloudphoto-photo-preview-contract");
    const phase = process.env.PHOTO_PREVIEW_PHASE ?? "contract";
    mkdirSync(evidenceDir, { recursive: true });
    const htmlPath = join(evidenceDir, `photo-preview-${phase}.html`);
    const metricsPath = join(evidenceDir, `photo-preview-${phase}-metrics.json`);
    const screenshotPathFor = (label) =>
      join(evidenceDir, `photo-preview-${phase}-${label}.png`);
    const profile = join(
      evidenceDir,
      `.edge-photo-preview-${phase}-${process.pid}`,
    );
    const port = await getFreePort();
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
        <rect width="1600" height="1000" fill="#1e3a8a"/>
        <rect x="80" y="80" width="1440" height="840" rx="48" fill="#bfdbfe"/>
        <circle cx="470" cy="430" r="190" fill="#f59e0b"/>
        <path d="M120 900 640 410 940 720 1190 520 1500 900Z" fill="#166534"/>
      </svg>`;
    const fixtureImage = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="${pathToFileURL(indexStylesPath).href}">
  <link rel="stylesheet" href="${pathToFileURL(stylesPath).href}">
  <style>
    body { margin: 0; }
    .audit-details { display: grid; gap: 8px; }
    .audit-details span { display: block; }
  </style>
</head>
<body>
  <div class="modal-overlay">
    <section class="modal-content" role="dialog" aria-modal="true" aria-label="照片详情：fixture.jpg">
      <button class="modal-close" type="button" aria-label="关闭照片详情">✕</button>
      <button class="modal-fullscreen-btn" type="button" aria-label="进入全屏">⛶</button>
      <span class="modal-nav-counter">4 / 12</span>
      <button class="modal-nav modal-nav--prev" type="button" aria-label="上一张">‹</button>
      <button class="modal-nav modal-nav--next" type="button" aria-label="下一张">›</button>
      <div class="modal-image-pane">
        <img class="modal-image" src="${fixtureImage}" alt="Owned preview fixture">
      </div>
      <div class="modal-info">
        <div class="modal-info-row">
          <div class="modal-filename"><strong class="modal-filename-text">fixture-landscape-photo.jpg</strong></div>
        </div>
        <div class="modal-action-strip">
          <button class="modal-action-btn" type="button">★ 收藏</button>
          <button class="modal-action-btn" type="button">⤓ 下载</button>
          <button class="modal-action-btn modal-action-btn--danger" type="button">🗑 删除</button>
        </div>
        <div class="modal-detail-grid audit-details">
          <span>尺寸：1600 × 1000</span>
          <span>拍摄时间：2026年8月11日 20:30</span>
          <span>位置：Owned fixture content</span>
          <span>主题：Preview geometry audit</span>
          <span>格式：JPEG</span>
          <span>大小：1.8 MB</span>
        </div>
      </div>
    </section>
  </div>
</body>
</html>`;
    writeFileSync(htmlPath, html);
    rmSync(profile, { recursive: true, force: true });

    const child = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        pathToFileURL(htmlPath).href,
      ],
      { stdio: "ignore" },
    );
    const wait = (ms) =>
      new Promise((resolveWait) => setTimeout(resolveWait, ms));
    let socket;
    let nextId = 1;
    const pending = new Map();
    const command = async (method, params = {}) => {
      const id = nextId++;
      const response = new Promise((resolveResponse, rejectResponse) => {
        pending.set(id, { resolveResponse, rejectResponse });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    };

    try {
      let target;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const targets = await fetch(
            `http://127.0.0.1:${port}/json`,
          ).then((response) => response.json());
          target = targets.find((candidate) => candidate.type === "page");
          if (target) break;
        } catch {
          // Edge may still be opening its debugging endpoint.
        }
        await wait(100);
      }
      assert(target, "Edge CDP page target did not become available");

      socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (!message.id || !pending.has(message.id)) return;
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.rejectResponse(new Error(message.error.message));
        else request.resolveResponse(message.result);
      };
      await new Promise((resolveOpen, rejectOpen) => {
        socket.onopen = resolveOpen;
        socket.onerror = rejectOpen;
      });
      await command("Page.enable");
      await command("Runtime.enable");

      const collectGeometry = async () => {
        const evaluation = await command("Runtime.evaluate", {
          expression: `(() => {
            const boxOf = (element) => {
              const box = element.getBoundingClientRect();
              return {
                left: box.left,
                top: box.top,
                right: box.right,
                bottom: box.bottom,
                width: box.width,
                height: box.height,
              };
            };
            const modal = document.querySelector(".modal-content");
            const pane = document.querySelector(".modal-image-pane");
            const media = document.querySelector(".modal-image");
            const info = document.querySelector(".modal-info");
            const controls = [...document.querySelectorAll(
              ".modal-close, .modal-fullscreen-btn, .modal-nav, .modal-action-btn"
            )].map((control) => ({
              className: control.className,
              bounds: boxOf(control),
            }));
            const mediaStyle = getComputedStyle(media);
            const overlay = document.querySelector(".modal-overlay");
            return {
              viewport: { width: innerWidth, height: innerHeight },
              document: {
                clientWidth: document.documentElement.clientWidth,
                scrollWidth: document.documentElement.scrollWidth,
              },
              overlay: {
                bounds: boxOf(overlay),
                clientWidth: overlay.clientWidth,
                scrollWidth: overlay.scrollWidth,
                clientHeight: overlay.clientHeight,
                scrollHeight: overlay.scrollHeight,
              },
              modal: boxOf(modal),
              pane: boxOf(pane),
              media: boxOf(media),
              info: boxOf(info),
              mediaStyle: {
                objectFit: mediaStyle.objectFit,
                objectPosition: mediaStyle.objectPosition,
                maxHeight: mediaStyle.maxHeight,
              },
              controls,
            };
          })()`,
          returnByValue: true,
        });
        return evaluation.result.value;
      };

      const metrics = [];
      for (const width of [320, 390, 500, 1440]) {
        await command("Emulation.setDeviceMetricsOverride", {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: width <= 500,
        });
        await command("Page.navigate", { url: pathToFileURL(htmlPath).href });
        await wait(500);
        await command("Runtime.evaluate", {
          expression: `document.querySelector(".modal-image").decode()`,
          awaitPromise: true,
        });
        const geometry = await collectGeometry();
        metrics.push(geometry);
        const screenshot = await command("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        });
        writeFileSync(
          screenshotPathFor(`${width}px`),
          Buffer.from(screenshot.data, "base64"),
        );
      }
      await command("Runtime.evaluate", {
        expression:
          'document.querySelector(".modal-content").classList.add("modal-content--fullscreen")',
      });
      await wait(100);
      const fullscreen = await collectGeometry();
      const fullscreenScreenshot = await command("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      writeFileSync(
        screenshotPathFor("1440px-fullscreen"),
        Buffer.from(fullscreenScreenshot.data, "base64"),
      );
      writeFileSync(
        metricsPath,
        `${JSON.stringify({ regular: metrics, fullscreen }, null, 2)}\n`,
      );

      const inside = (outer, inner, label) => {
        assert(inner.left >= outer.left - 0.5, `${label} left bound`);
        assert(inner.right <= outer.right + 0.5, `${label} right bound`);
        assert(inner.top >= outer.top - 0.5, `${label} top bound`);
        assert(inner.bottom <= outer.bottom + 0.5, `${label} bottom bound`);
      };
      const assertBoundedGeometry = (
        geometry,
        label,
        { mediaInsidePane = true } = {},
      ) => {
        const { width } = geometry.viewport;
        assert.equal(
          geometry.document.scrollWidth,
          geometry.document.clientWidth,
          `${label} document must not overflow horizontally`,
        );
        assert.equal(
          geometry.overlay.scrollWidth,
          geometry.overlay.clientWidth,
          `${label} modal overlay must not overflow horizontally`,
        );
        inside(geometry.overlay.bounds, geometry.modal, `${label} modal`);
        if (mediaInsidePane) {
          inside(geometry.pane, geometry.media, `${label} media`);
        }
        assert.equal(geometry.mediaStyle.objectFit, "contain");
        assert.equal(geometry.mediaStyle.objectPosition, "50% 50%");
        assert(
          Math.abs((geometry.media.width / geometry.media.height) - 1.6) < 0.01,
          `${label} media must preserve the owned fixture aspect ratio`,
        );
        for (const control of geometry.controls) {
          inside(geometry.modal, control.bounds, `${label} ${control.className}`);
        }
        for (const nav of geometry.controls.filter(({ className }) =>
          className.includes("modal-nav "))) {
          assert(nav.bounds.width >= 44);
          assert(nav.bounds.height >= 44);
        }
      };
      for (const geometry of metrics) {
        assertBoundedGeometry(geometry, `${geometry.viewport.width}px`);
      }
      assertBoundedGeometry(fullscreen, "1440px fullscreen", {
        mediaInsidePane: false,
      });

      const desktop = metrics.find(({ viewport }) => viewport.width === 1440);
      assert(Math.abs(desktop.modal.width - 1080) < 1);
      assert(Math.abs(desktop.pane.width - 626.4) < 1);
      assert(desktop.media.width <= 626.4 + 1);
      assert(desktop.modal.height <= 844 * 0.88 + 1);
      for (const width of [320, 390, 500]) {
        const mobile = metrics.find(({ viewport }) => viewport.width === width);
        assert(Math.abs(mobile.modal.width - (width - 12)) < 1);
        assert(mobile.media.height <= 844 * 0.42 + 1);
      }
      assert(Math.abs(fullscreen.modal.width - 1160) < 1);
      assert(Math.abs(fullscreen.pane.width - 788.8) < 1);
      assert(Math.abs(fullscreen.modal.height - 844 * 0.9) < 1);
      assert.equal(fullscreen.mediaStyle.maxHeight, "724px");
      assert(fullscreen.modal.width > desktop.modal.width);
      await command("Browser.close");
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      if (!child.killed) child.kill();
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        wait(2000),
      ]);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          rmSync(profile, { recursive: true, force: true });
          break;
        } catch (error) {
          const retryable =
            error?.code === "EPERM" || error?.code === "EBUSY";
          if (!retryable || attempt === 19) throw error;
          await wait(100);
        }
      }
    }
  },
);
