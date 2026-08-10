import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const card = read("./PhotoCard.tsx");
const gallery = read("./PhotoGallery.tsx");
const folder = read("./FolderView.tsx");
const styles = read("../../authenticated.css");
const labelSource = read("./photoCardAccessibility.ts");
const compiledLabels = ts.transpileModule(labelSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const labelModuleUrl = `data:text/javascript;base64,${Buffer.from(compiledLabels).toString("base64")}`;
const {
  getPhotoCardGroupLabel,
  getPhotoCardPrimaryLabel,
} = await import(labelModuleUrl);

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert(match, `missing CSS block for ${selector}`);
  return match[1];
}

test("shared photo cards expose one native open or select target without nested actions", () => {
  const componentStart = card.indexOf("function PhotoCard(");
  const markupStart = card.indexOf("  return (", componentStart);
  const markup = card.slice(markupStart, card.indexOf("{showConfirm", markupStart));
  const articleStart = markup.indexOf("<article");
  const articleTag = markup.slice(articleStart, markup.indexOf("onContextMenu", articleStart));
  const primaryStart = markup.indexOf('className="photo-card-primary"');
  const primaryOpen = markup.lastIndexOf("<button", primaryStart);
  const primaryEnd = markup.indexOf("</button>", primaryStart);
  const favoriteStart = markup.indexOf('className={`favorite-btn', primaryEnd);
  const deleteStart = markup.indexOf('className="delete-btn"', favoriteStart);
  const primary = markup.slice(primaryOpen, primaryEnd + "</button>".length);

  assert(articleStart >= 0);
  assert.match(articleTag, /aria-label=\{getPhotoCardGroupLabel\(displayName\)\}/);
  assert.doesNotMatch(articleTag, /onClick|onKeyDown|tabIndex/);
  assert.ok(primaryStart > articleStart && primaryEnd < favoriteStart && favoriteStart < deleteStart);
  assert.match(primary, /type="button"/);
  assert.match(primary, /aria-label=\{primaryLabel\}/);
  assert.match(primary, /aria-pressed=\{selectionMode \? Boolean\(selected\) : undefined\}/);
  assert.match(primary, /disabled=\{interactionDisabled\}/);
  assert.match(primary, /onClick=\{primaryAction\}/);
  assert.doesNotMatch(primary, /onKeyDown|onKeyUp/);
  assert.match(card, /className="photo-thumbnail"[\s\S]{0,180}data-media-policy=\{GRID_MEDIA_POLICY_MARKER\}/);
  assert.doesNotMatch(card, /className="photo-thumbnail"[\s\S]{0,180}onClick=/);
  assert.match(markup.slice(favoriteStart, deleteStart), /e\.stopPropagation\(\)/);
  assert.match(markup.slice(deleteStart), /e\.stopPropagation\(\)/);
  assert.match(markup.slice(favoriteStart, deleteStart), /aria-label=\{`\$\{photo\.favorite \? "取消收藏" : "收藏"\} \$\{displayName\}`\}/);
  assert.match(markup.slice(deleteStart), /aria-label=\{`删除照片 \$\{displayName\}`\}/);
  assert.match(cssBlock(".gif-play-center"), /z-index\s*:\s*2/);
  assert.match(cssBlock(".gif-pause-corner-btn"), /z-index\s*:\s*2[\s\S]*width\s*:\s*44px[\s\S]*height\s*:\s*44px/);
  assert.match(cssBlock(".photo-card:hover .gif-pause-corner-btn"), /opacity\s*:\s*1/);
  assert.match(cssBlock(".gif-pause-corner-btn:focus-visible"), /outline\s*:\s*3px solid #fff/);
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*?\.gif-pause-corner-btn \{[\s\S]*?opacity\s*:\s*1/);
});

test("timeline, moments, and folder surfaces share the accessible PhotoCard", () => {
  assert.ok((gallery.match(/<PhotoCard/g) ?? []).length >= 4);
  const momentsStart = gallery.indexOf("{momentCards.map(");
  const momentsEnd = gallery.indexOf("            })}", momentsStart);
  assert.ok(momentsStart >= 0 && momentsEnd > momentsStart, "moments branch must remain discoverable");
  const momentsMarkup = gallery.slice(momentsStart, momentsEnd);
  assert.match(momentsMarkup, /className="moments-card"/);
  assert.match(momentsMarkup, /<PhotoCard[\s\S]*selected=\{selectMode[\s\S]*onSelect=\{selectMode[\s\S]*interactionDisabled=\{batchMutationBusy\}/);
  assert.doesNotMatch(momentsMarkup, /className="moments-card"[\s\S]{0,160}onClick=/);
  assert.ok((folder.match(/<PhotoCard/g) ?? []).length >= 1);
  assert.match(gallery, /selected=\{selectMode \? selected\.has\(photo\.name\) : undefined\}/);
  assert.match(gallery, /onSelect=\{selectMode \?/);
  assert.match(folder, /selected=\{selectMode \? selected\.has\(photo\.name\) : undefined\}/);
  assert.match(folder, /onSelect=\{selectMode \?/);
});

test("photo favorite and delete actions keep distinct 44px targets and visible focus", () => {
  const actions = cssBlock(".move-btn,\n.favorite-btn,\n.delete-btn");
  assert.match(actions, /min-width\s*:\s*44px/);
  assert.match(actions, /min-height\s*:\s*44px/);
  assert.doesNotMatch(actions, /position\s*:\s*absolute/);
  assert.match(cssBlock(".photo-card-primary:focus-visible"), /outline\s*:\s*3px solid #005a9e/);
  assert.match(
    cssBlock(".move-btn:focus-visible,\n.favorite-btn:focus-visible,\n.delete-btn:focus-visible"),
    /outline\s*:\s*3px solid #005a9e/,
  );
});

test("photo card labels include safe metadata without media URLs", () => {
  assert.equal(getPhotoCardGroupLabel("  IMG_001.JPG  "), "照片 IMG_001.JPG");
  assert.equal(
    getPhotoCardPrimaryLabel("生日 🎂.mp4", "视频", "拍摄于 Aug 10, 2026", false, false),
    "打开视频 生日 🎂.mp4，拍摄于 Aug 10, 2026",
  );
  assert.equal(
    getPhotoCardPrimaryLabel("", "照片", null, true, false),
    "选择照片 (未命名照片)",
  );
  assert.equal(
    getPhotoCardPrimaryLabel("家庭.jpg", "照片", null, true, true),
    "取消选择照片 家庭.jpg",
  );
  assert.doesNotMatch(labelSource, /photo\.url|thumbnailUrl|previewUrl|sas/i);
});
