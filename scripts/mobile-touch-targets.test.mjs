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
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const stylesPath = join(repoRoot, "packages/client/src/authenticated.css");
const indexStylesPath = join(repoRoot, "packages/client/src/index.css");
const styles = readFileSync(stylesPath, "utf8");
const edge =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function mobileBlock() {
  const marker = "@media (max-width: 680px)";
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

function overlapArea(a, b) {
  return (
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  );
}

test("mobile CSS expands only photo actions and the avatar", () => {
  const mobile = mobileBlock();
  const photoActions = cssBlock(".move-btn,\n.favorite-btn,\n.delete-btn");
  assert.equal(declaration(photoActions, "min-width"), "44px");
  assert.equal(declaration(photoActions, "min-height"), "44px");
  assert.equal(declaration(photoActions, "padding"), "0");

  const avatar = cssBlock(".user-avatar-btn", mobile);
  assert.equal(declaration(avatar, "width"), "44px");
  assert.equal(declaration(avatar, "height"), "44px");

  assert.doesNotMatch(
    mobile,
    /(?:favorite-btn|delete-btn)\s*\{[^}]*(?:min-)?(?:width|height)\s*:/s,
    "mobile photo actions must inherit the shared target instead of overriding it",
  );
  assert.doesNotMatch(
    photoActions,
    /font-size\s*:/,
    "the icon may stay visually compact inside the larger hit box",
  );
  assert.doesNotMatch(
    mobile,
    /(?:group-switcher-btn|workspace-tab|filter-toggle-btn|folder-card-(?:rename|delete)-btn|memory-map)[^}]*?(?:min-)?(?:width|height)\s*:\s*44px/s,
    "intentional dense controls must not be blanket-enlarged",
  );
});

test("mobile action and avatar focus rings are visible", () => {
  const mobile = mobileBlock();
  const focus = cssBlock(
    ".favorite-btn:focus-visible,\n  .delete-btn:focus-visible,\n  .user-avatar-btn:focus-visible",
    mobile,
  );
  assert.notEqual(declaration(focus, "outline"), "none");
  assert.match(declaration(focus, "outline"), /(?:2|3)px/);
  assert.match(declaration(focus, "outline-offset"), /^\d+px$/);
});

test(
  "320px through 430px gallery geometry keeps two bounded columns and 44px actions",
  { skip: !existsSync(edge) },
  async () => {
    const evidenceDir =
      process.env.MOBILE_TOUCH_EVIDENCE_DIR ??
      join(tmpdir(), "cloudphoto-mobile-touch-contract");
    const phase = process.env.MOBILE_TOUCH_PHASE ?? "contract";
    mkdirSync(evidenceDir, { recursive: true });
    const htmlPath = join(evidenceDir, `mobile-touch-${phase}.html`);
    const screenshotPathFor = (width) => join(
      evidenceDir,
      `mobile-gallery-${phase}-${width}px.png`,
    );
    const metricsPath = join(
      evidenceDir,
      `mobile-touch-${phase}-metrics.json`,
    );
    const profile = join(
      evidenceDir,
      `.edge-mobile-touch-${phase}-${process.pid}`,
    );
    const port = await getFreePort();
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="${pathToFileURL(indexStylesPath).href}">
  <link rel="stylesheet" href="${pathToFileURL(stylesPath).href}">
  <style>
    body { margin: 0; background: #f5f7fb; }
    .app-header { position: static; }
    .app-main { padding-top: 16px; }
    .audit-gallery + .audit-gallery { margin-top: 16px; }
    .audit-gallery h2 { margin: 0 0 8px; font: 700 14px/1.4 system-ui; color: #334155; }
    .photo-card { width: 100%; margin: 0 auto; }
    .photo-thumbnail { background: linear-gradient(135deg,#bfdbfe,#e0e7ff); }
    .audit-caption { padding: 12px; color: #475569; font: 13px/1.4 system-ui; }
  </style>
</head>
<body>
  <header class="app-header">
    <h1>CloudPhoto</h1>
    <button class="group-switcher-btn" type="button">个人空间</button>
    <div class="user-avatar-wrap"><button class="user-avatar-btn" type="button" aria-label="用户菜单">张</button></div>
  </header>
  <main class="app-main">
    <div class="audit-caption">390 × 844 · surgical touch-target audit</div>
    <section class="audit-gallery">
      <h2>Timeline</h2>
      <div class="photo-grid" data-audit-grid="timeline">
        <article class="photo-card photo-card--selected">
          <span class="photo-select-badge photo-select-badge--on">✓</span>
          <button class="photo-card-primary" type="button">
            <span class="photo-thumbnail"><span class="photo-format-badge">HEIC</span></span>
            <span class="photo-info"><span class="photo-name">家庭相册 2026 Family archive with a long label</span></span>
            <span class="photo-meta"><span class="photo-subject-tag">家庭旅行 Family trip</span><span class="photo-meta-by">👤 timeline-owner@example.com</span><span class="photo-meta-taken">📷 2026年8月10日</span></span>
          </button>
          <div class="photo-card-controls">
            <button class="move-btn" type="button" aria-label="移动时间线照片">→</button>
            <button class="favorite-btn" type="button" aria-label="收藏时间线照片">★</button>
            <button class="delete-btn" type="button" aria-label="删除时间线照片">🗑</button>
          </div>
        </article>
        <article class="photo-card">
          <button class="photo-card-primary" type="button">
            <span class="photo-thumbnail"><span class="photo-favorite-badge">★</span><span class="photo-video-badge">▶</span></span>
            <span class="photo-info"><span class="photo-name">第二张时间线照片 Timeline item</span></span>
            <span class="photo-meta"><span class="photo-meta-by">👤 timeline-owner@example.com</span><span class="photo-meta-date">2026年8月9日</span></span>
          </button>
          <div class="photo-card-controls">
            <button class="move-btn" type="button" aria-label="移动第二张时间线照片">→</button>
            <button class="favorite-btn" type="button" aria-label="收藏第二张时间线照片">★</button>
            <button class="delete-btn" type="button" aria-label="删除第二张时间线照片">🗑</button>
          </div>
        </article>
      </div>
    </section>
    <section class="audit-gallery">
      <h2>Folder</h2>
      <div class="photo-grid folder-section-grid" data-audit-grid="folder">
        <article class="photo-card photo-card--selected">
          <span class="photo-select-badge photo-select-badge--on">✓</span>
          <button class="photo-card-primary" type="button">
            <span class="photo-thumbnail"><span class="photo-format-badge">PNG</span></span>
            <span class="photo-info"><span class="photo-name">文件夹照片 Folder archive with a long label</span></span>
            <span class="photo-meta"><span class="photo-subject-tag">归档文件 Archive</span><span class="photo-meta-date">2026年8月8日</span></span>
          </button>
          <div class="photo-card-controls">
            <button class="move-btn" type="button" aria-label="移动文件夹照片">→</button>
            <button class="favorite-btn" type="button" aria-label="收藏文件夹照片">★</button>
            <button class="delete-btn" type="button" aria-label="删除文件夹照片">🗑</button>
          </div>
        </article>
        <article class="photo-card">
          <button class="photo-card-primary" type="button">
            <span class="photo-thumbnail"><span class="photo-favorite-badge">★</span><span class="photo-video-badge">▶</span></span>
            <span class="photo-info"><span class="photo-name">第二张文件夹照片 Folder item</span></span>
            <span class="photo-meta"><span class="photo-meta-by">👤 folder-owner@example.com</span><span class="photo-meta-taken">📷 2026年8月7日</span></span>
          </button>
          <div class="photo-card-controls">
            <button class="move-btn" type="button" aria-label="移动第二张文件夹照片">→</button>
            <button class="favorite-btn" type="button" aria-label="收藏第二张文件夹照片">★</button>
            <button class="delete-btn" type="button" aria-label="删除第二张文件夹照片">🗑</button>
          </div>
        </article>
      </div>
    </section>
  </main>
  <aside class="workspace-sidebar workspace-sidebar--open" data-audit-sidebar style="pointer-events:none">
    <div class="workspace-sidebar-shell">
      <div class="workspace-sidebar-topbar"><div><span class="workspace-sidebar-kicker">Timeline</span><h2>侧边工具栏</h2></div><button class="workspace-sidebar-close">✕</button></div>
      <div class="workspace-sidebar-content">
        <section class="workspace-sidebar-section">
          <div class="filter-bar filter-bar--sidebar auth-native-control-scope">
            <div class="filter-main-row">
              <div class="filter-search-row">
                <div class="search-input-wrap"><input class="search-input" value="跨语言家庭相册 very long search name"><button class="search-clear">✕</button></div>
                <button class="filter-clear-btn">清空全部</button>
              </div>
              <div class="filter-quick-controls">
                <button class="filter-toggle-btn active">★ 仅收藏 Favorite photos only</button>
                <button class="filter-toggle-btn active">🏷 缺少主题 Missing subject metadata</button>
                <button class="filter-toggle-btn active">📂 未分类 Uncategorized collection</button>
                <button class="filter-toggle-btn active">📍 缺少 GPS / Missing geolocation</button>
                <span class="search-count">128 / 2,048</span>
                <div class="grid-size-toggle"><button class="grid-size-btn">⊞</button><button class="grid-size-btn active">⊟</button><button class="grid-size-btn">▣</button></div>
              </div>
            </div>
            <div class="filter-chips"><span class="filter-chip"><span class="filter-chip-label">主题: 超长中英文 Family summer celebration archive</span><button class="filter-chip-remove">✕</button></span></div>
            <div class="filter-panel">
              <label class="filter-field"><span>主题</span><input value="跨语言主题 Family archive"></label>
              <label class="filter-field"><span>上传者</span><select><option>extremely-long-uploader@example.com</option></select></label>
              <label class="filter-field"><span>开始日期</span><input type="date" value="2026-08-04"></label>
              <label class="filter-field"><span>截止日期</span><input type="date" value="2026-08-10"></label>
            </div>
          </div>
        </section>
      </div>
    </div>
  </aside>
  <div class="workspace-fab-rail" style="left:170px;top:500px;right:unset;bottom:unset">
    <div id="workspace-fab-actions" class="workspace-fab-actions">
      <button class="workspace-fab-pill"><span class="workspace-fab-icon">⚙</span><span class="workspace-fab-copy"><strong>筛选与整理</strong><em>打开时间线侧栏</em></span></button>
      <div class="workspace-fab-chip-group"><button class="workspace-fab-chip">最近上传</button><button class="workspace-fab-chip">去整理</button></div>
    </div>
    <button class="workspace-fab-compact-toggle" aria-expanded="false" aria-controls="workspace-fab-actions"><span>⋮</span></button>
  </div>
</body>
</html>`;
    writeFileSync(htmlPath, html);
    rmSync(profile, { recursive: true, force: true });

    const child = spawn(
      edge,
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
      await command("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await command("Page.navigate", { url: pathToFileURL(htmlPath).href });
      await wait(500);

      const collectGeometry = async () => {
        const evaluation = await command("Runtime.evaluate", {
        expression: `(() => {
          const boxOf = (element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
          };
          const rect = (selector) => boxOf(document.querySelector(selector));
          const overlapArea = (a, b) =>
            Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          const hitAtCenter = (selector, box) => {
            const target = document.querySelector(selector);
            const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
            return hit === target || target.contains(hit);
          };
          const favorite = rect(".favorite-btn");
          const remove = rect(".delete-btn");
          const avatar = rect(".user-avatar-btn");
          const card = rect(".photo-card");
          const move = rect(".move-btn");
          const gridGeometry = Object.fromEntries(
            [...document.querySelectorAll("[data-audit-grid]")].map((grid) => [
              grid.dataset.auditGrid,
              {
                templateColumns: getComputedStyle(grid).gridTemplateColumns,
                bounds: boxOf(grid),
                clientWidth: grid.clientWidth,
                scrollWidth: grid.scrollWidth,
                cards: [...grid.querySelectorAll(":scope > .photo-card")].map((card) => {
                  const thumbnail = card.querySelector(".photo-thumbnail");
                  const info = card.querySelector(".photo-info");
                  const meta = card.querySelector(".photo-meta");
                  const controls = card.querySelector(".photo-card-controls");
                  return {
                    bounds: boxOf(card),
                    primary: boxOf(card.querySelector(".photo-card-primary")),
                    thumbnail: boxOf(thumbnail),
                    info: boxOf(info),
                    meta: boxOf(meta),
                    metaClientWidth: meta.clientWidth,
                    metaScrollWidth: meta.scrollWidth,
                    metaChildren: [...meta.children].map(boxOf),
                    controls: boxOf(controls),
                    badges: [...card.querySelectorAll(".photo-format-badge, .photo-favorite-badge, .photo-video-badge, .photo-select-badge")].map(boxOf),
                    actions: [...controls.querySelectorAll("button")].map(boxOf),
                  };
                }),
              },
            ]),
          );
          const sidebar = document.querySelector("[data-audit-sidebar]");
          const sidebarContent = sidebar.querySelector(".workspace-sidebar-content");
          const filterBar = sidebar.querySelector(".filter-bar");
          const filterMainRow = sidebar.querySelector(".filter-main-row");
          const sidebarRect = sidebar.getBoundingClientRect();
          const sidebarContentRect = sidebarContent.getBoundingClientRect();
          const visibleFilterControls = [...filterBar.querySelectorAll("button,input,select")].filter((element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return style.display !== "none" && box.width > 0 && box.height > 0;
          });
          const filterOutOfBounds = visibleFilterControls.filter((element) => {
            const box = element.getBoundingClientRect();
            return box.left < sidebarContentRect.left - 0.5 || box.right > sidebarContentRect.right + 0.5;
          }).map((element) => element.getAttribute("aria-label") || element.textContent.trim() || element.tagName);
          const sidebarDate = sidebar.querySelector('input[type="date"]');
          const sidebarDateStyle = getComputedStyle(sidebarDate);
          const sidebarDateIndicator = getComputedStyle(sidebarDate, "::-webkit-calendar-picker-indicator");
          const railElement = document.querySelector(".workspace-fab-rail");
          railElement.classList.remove("workspace-fab-rail--expanded");
          const rail = rect(".workspace-fab-rail");
          const toggle = rect(".workspace-fab-compact-toggle");
          const collapsedActionsDisplay = getComputedStyle(document.querySelector(".workspace-fab-actions")).display;
          railElement.classList.add("workspace-fab-rail--expanded");
          const expandedActions = rect(".workspace-fab-actions");
          const expandedActionsDisplay = getComputedStyle(document.querySelector(".workspace-fab-actions")).display;
          const expandedDocument = {
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
          };
          railElement.classList.remove("workspace-fab-rail--expanded");
          const favoriteElement = document.querySelector(".favorite-btn");
          favoriteElement.focus();
          const focus = getComputedStyle(favoriteElement);
          return {
            viewport: { width: innerWidth, height: innerHeight },
            document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
            favorite,
            remove,
            avatar,
            card,
            move,
            grids: gridGeometry,
            overlapArea: overlapArea(favorite, remove),
            centerHits: {
              favorite: hitAtCenter(".favorite-btn", favorite),
              remove: hitAtCenter(".delete-btn", remove),
              avatar: hitAtCenter(".user-avatar-btn", avatar),
            },
            focus: {
              outlineStyle: focus.outlineStyle,
              outlineWidth: focus.outlineWidth,
              outlineOffset: focus.outlineOffset,
            },
            fab: {
              rail,
              toggle,
              collapsedActionsDisplay,
              expandedActions,
              expandedActionsDisplay,
              expandedDocument,
              inlinePosition: {
                left: railElement.style.left,
                top: railElement.style.top,
              },
            },
            sidebar: {
              width: sidebarRect.width,
              contentClientWidth: sidebarContent.clientWidth,
              contentScrollWidth: sidebarContent.scrollWidth,
              rowClientWidth: filterMainRow.clientWidth,
              rowScrollWidth: filterMainRow.scrollWidth,
              filterOutOfBounds,
              date: {
                type: sidebarDate.type,
                value: sidebarDate.value,
                fontFamily: sidebarDateStyle.fontFamily,
                fontSize: sidebarDateStyle.fontSize,
                lineHeight: sidebarDateStyle.lineHeight,
                minHeight: sidebarDateStyle.minHeight,
                height: sidebarDate.getBoundingClientRect().height,
                indicatorDisplay: sidebarDateIndicator.display,
                indicatorVisibility: sidebarDateIndicator.visibility,
              },
            },
          };
        })()`,
        returnByValue: true,
      });
        return evaluation.result.value;
      };

      const widths = [320, 360, 390, 430, 480];
      const fabGeometry = [];
      for (const width of widths) {
        await command("Emulation.setDeviceMetricsOverride", {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
        });
        await wait(100);
        const geometry = { width, ...(await collectGeometry()) };
        fabGeometry.push(geometry);
        const screenshot = await command("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        });
        writeFileSync(
          screenshotPathFor(width),
          Buffer.from(screenshot.data, "base64"),
        );
      }
      const reflowGeometry = [];
      await command("Runtime.evaluate", {
        expression: `(() => {
          for (const selector of [".app-header", "[data-audit-sidebar]", ".workspace-fab-rail"]) {
            document.querySelector(selector).style.display = "none";
          }
        })()`,
      });
      for (const width of [160, 180, 195, 215, 240]) {
        await command("Emulation.setDeviceMetricsOverride", {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
        });
        await wait(100);
        const { document, grids } = await collectGeometry();
        reflowGeometry.push({ width, document, grids });
      }
      await command("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await wait(100);
      const metrics = fabGeometry.find(({ width }) => width === 390);
      metrics.fabGeometry = fabGeometry.map(({ width, document, fab, sidebar, card, move, favorite, remove, grids }) => ({
        width,
        document,
        fab,
        sidebar,
        grids,
        folderCard: {
          card,
          move,
          favorite,
          remove,
        },
      }));
      metrics.reflowGeometry = reflowGeometry;
      writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);

      assert.equal(metrics.viewport.width, 390);
      assert.equal(metrics.viewport.height, 844);
      assert.equal(metrics.document.scrollWidth, metrics.document.clientWidth);
      for (const [name, box] of Object.entries({
        favorite: metrics.favorite,
        remove: metrics.remove,
        avatar: metrics.avatar,
      })) {
        assert(box.width >= 44, `${name} width must be at least 44px`);
        assert(box.height >= 44, `${name} height must be at least 44px`);
      }
      assert.equal(metrics.overlapArea, 0);
      assert.deepEqual(metrics.centerHits, {
        favorite: true,
        remove: true,
        avatar: true,
      });
      assert.notEqual(metrics.focus.outlineStyle, "none");
      assert(Number.parseFloat(metrics.focus.outlineWidth) >= 2);
      const assertInside = (outer, inner, label) => {
        assert(inner.left >= outer.left - 0.5, `${label} must stay inside the left bound`);
        assert(inner.right <= outer.right + 0.5, `${label} must stay inside the right bound`);
        assert(inner.top >= outer.top - 0.5, `${label} must stay inside the top bound`);
        assert(inner.bottom <= outer.bottom + 0.5, `${label} must stay inside the bottom bound`);
      };
      const assertGalleryGeometry = (geometry, expectedTracks) => {
        for (const [galleryName, grid] of Object.entries(geometry.grids)) {
          assert.equal(
            grid.templateColumns.trim().split(/\s+/).length,
            expectedTracks,
            `${geometry.width}px ${galleryName} gallery must have exactly ${expectedTracks} computed track(s)`,
          );
          assert.equal(
            grid.scrollWidth,
            grid.clientWidth,
            `${geometry.width}px ${galleryName} gallery must not overflow`,
          );
          assert.equal(grid.cards.length, 2);
          if (expectedTracks === 2) {
            assert(Math.abs(grid.cards[0].bounds.top - grid.cards[1].bounds.top) < 1);
          } else {
            assert(grid.cards[1].bounds.top >= grid.cards[0].bounds.bottom);
          }
          for (const [cardIndex, galleryCard] of grid.cards.entries()) {
            const cardLabel = `${geometry.width}px ${galleryName} card ${cardIndex + 1}`;
            assertInside(grid.bounds, galleryCard.bounds, cardLabel);
            assertInside(galleryCard.bounds, galleryCard.primary, `${cardLabel} primary`);
            assertInside(galleryCard.bounds, galleryCard.thumbnail, `${cardLabel} thumbnail`);
            assertInside(galleryCard.bounds, galleryCard.info, `${cardLabel} labels`);
            assertInside(galleryCard.bounds, galleryCard.meta, `${cardLabel} metadata`);
            assertInside(galleryCard.bounds, galleryCard.controls, `${cardLabel} controls`);
            assert.equal(overlapArea(galleryCard.thumbnail, galleryCard.info), 0);
            assert.equal(overlapArea(galleryCard.thumbnail, galleryCard.meta), 0);
            assert.equal(overlapArea(galleryCard.thumbnail, galleryCard.controls), 0);
            assert.equal(overlapArea(galleryCard.info, galleryCard.meta), 0);
            assert.equal(overlapArea(galleryCard.info, galleryCard.controls), 0);
            assert.equal(overlapArea(galleryCard.meta, galleryCard.controls), 0);
            assert.equal(
              galleryCard.metaScrollWidth,
              galleryCard.metaClientWidth,
              `${cardLabel} metadata must not be clipped by the card`,
            );
            for (const [metaIndex, metaChild] of galleryCard.metaChildren.entries()) {
              assertInside(
                galleryCard.meta,
                metaChild,
                `${cardLabel} metadata item ${metaIndex + 1}`,
              );
            }
            for (const [badgeIndex, badge] of galleryCard.badges.entries()) {
              assertInside(
                galleryCard.thumbnail,
                badge,
                `${cardLabel} badge ${badgeIndex + 1}`,
              );
              assert.equal(overlapArea(badge, galleryCard.info), 0);
              assert.equal(overlapArea(badge, galleryCard.controls), 0);
            }
            for (const [actionIndex, action] of galleryCard.actions.entries()) {
              assert(action.width >= 44, `${cardLabel} action ${actionIndex + 1} width`);
              assert(action.height >= 44, `${cardLabel} action ${actionIndex + 1} height`);
              assertInside(
                galleryCard.controls,
                action,
                `${cardLabel} action ${actionIndex + 1}`,
              );
              for (const otherAction of galleryCard.actions.slice(actionIndex + 1)) {
                assert.equal(overlapArea(action, otherAction), 0);
              }
            }
          }
        }
      };
      for (const geometry of metrics.fabGeometry) {
        assert.equal(
          geometry.document.scrollWidth,
          geometry.document.clientWidth,
          `${geometry.width}px collapsed document must not overflow`,
        );
        assert.equal(
          geometry.fab.expandedDocument.scrollWidth,
          geometry.fab.expandedDocument.clientWidth,
          `${geometry.width}px expanded document must not overflow`,
        );
        assert.equal(geometry.fab.rail.width, 48);
        assert.equal(geometry.fab.toggle.width, 48);
        assert(geometry.fab.toggle.height >= 48);
        assert.equal(geometry.fab.collapsedActionsDisplay, "none");
        assert.equal(geometry.fab.expandedActionsDisplay, "flex");
        assert(geometry.fab.expandedActions.left >= 0);
        assert(geometry.fab.expandedActions.right <= geometry.width);
        assert(geometry.fab.expandedActions.top >= 0);
        assert(geometry.fab.expandedActions.bottom <= 844);
        assert.equal(geometry.fab.inlinePosition.left, "170px");
        assert.equal(geometry.fab.inlinePosition.top, "500px");
        assert(
          geometry.fab.rail.left > geometry.width - 80,
          `${geometry.width}px compact CSS must override saved left/top`,
        );
        assert.equal(
          geometry.sidebar.contentScrollWidth,
          geometry.sidebar.contentClientWidth,
          `${geometry.width}px sidebar content must not overflow`,
        );
        assert.equal(
          geometry.sidebar.rowScrollWidth,
          geometry.sidebar.rowClientWidth,
          `${geometry.width}px filter row must not overflow`,
        );
        assert.deepEqual(
          geometry.sidebar.filterOutOfBounds,
          [],
          `${geometry.width}px filter controls must stay within sidebar content`,
        );
        const { card, move, favorite, remove } = geometry.folderCard;
        for (const [name, box] of Object.entries({ move, favorite, remove })) {
          assert(
            box.left >= card.left && box.right <= card.right,
            `${geometry.width}px folder ${name} action must stay inside its card`,
          );
        }
        assert.equal(overlapArea(move, favorite), 0);
        assert.equal(overlapArea(move, remove), 0);
        assert.equal(overlapArea(favorite, remove), 0);
        if (geometry.width <= 430) {
          assertGalleryGeometry(geometry, 2);
        }
      }
      for (const geometry of metrics.reflowGeometry) {
        assert.equal(
          geometry.document.scrollWidth,
          geometry.document.clientWidth,
          `${geometry.width}px reflow document must not overflow`,
        );
        assertGalleryGeometry(geometry, 1);
      }
      const sidebar320 = metrics.fabGeometry.find(({ width }) => width === 320).sidebar;
      assert.equal(Math.round(sidebar320.width), 262);
      assert.match(sidebar320.date.fontFamily, /Segoe UI/);
      assert.doesNotMatch(sidebar320.date.fontFamily, /monospace/i);
      assert.notEqual(sidebar320.date.lineHeight, "normal");
      assert(sidebar320.date.height >= 44);
      assert.equal(sidebar320.date.type, "date");
      assert.equal(sidebar320.date.value, "2026-08-04");
      assert.equal(sidebar320.date.indicatorDisplay, "block");
      assert.equal(sidebar320.date.indicatorVisibility, "visible");
      await command("Browser.close");
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      if (!child.killed) child.kill();
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        wait(2_000),
      ]);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          rmSync(profile, { recursive: true, force: true });
          break;
        } catch {
          await wait(300);
        }
      }
    }
  },
);
