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
  getPhotoActionLabel,
  getPhotoCardGroupLabel,
  getPhotoDisplayName,
  getPhotoMediaKind,
  getPhotoPrimaryActionLabel,
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
  const cardClass = markup.indexOf("className={`photo-card");
  const groupStart = markup.lastIndexOf("<div", cardClass);
  const groupTag = markup.slice(groupStart, markup.indexOf("onContextMenu", groupStart));
  const primaryStart = markup.indexOf('className="photo-card-primary"');
  const primaryOpen = markup.lastIndexOf("<button", primaryStart);
  const primaryEnd = markup.indexOf("</button>", primaryStart);
  const controlsStart = markup.indexOf('className="photo-card-controls"', primaryEnd);
  const favoriteStart = markup.indexOf('className={`favorite-btn', primaryEnd);
  const deleteStart = markup.indexOf('className="delete-btn"', favoriteStart);
  const primary = markup.slice(primaryOpen, primaryEnd + "</button>".length);

  assert(groupStart >= 0);
  assert.match(groupTag, /role="group"/);
  assert.match(groupTag, /aria-label=\{groupLabel\}/);
  assert.doesNotMatch(groupTag, /onClick|onKeyDown|tabIndex/);
  assert.ok(primaryStart > groupStart && primaryEnd < controlsStart && controlsStart < favoriteStart && favoriteStart < deleteStart);
  assert.match(primary, /type="button"/);
  assert.match(primary, /aria-label=\{primaryActionLabel\}/);
  assert.match(primary, /aria-describedby=\{primaryDescriptionIds \|\| undefined\}/);
  assert.match(primary, /aria-pressed=\{selectionMode \? !!selected : undefined\}/);
  assert.match(primary, /disabled=\{interactionDisabled\}/);
  assert.match(primary, /onClick=\{handlePrimaryAction\}/);
  assert.doesNotMatch(primary, /onKeyDown|onKeyUp/);
  assert.doesNotMatch(primary.slice(primary.indexOf(">") + 1), /<button/);
  assert.match(card, /className="photo-thumbnail"[\s\S]{0,180}data-media-policy=\{GRID_MEDIA_POLICY_MARKER\}/);
  assert.doesNotMatch(card, /className="photo-thumbnail"[\s\S]{0,180}onClick=/);
  assert.match(markup.slice(favoriteStart, deleteStart), /e\.stopPropagation\(\)/);
  assert.match(markup.slice(deleteStart), /e\.stopPropagation\(\)/);
  assert.match(markup.slice(favoriteStart, deleteStart), /getPhotoActionLabel\(photo\.favorite \? "unfavorite" : "favorite", displayName\)/);
  assert.match(markup.slice(deleteStart), /getPhotoActionLabel\("delete", displayName\)/);
  assert.match(card, /className="photo-card-status" role="status"/);
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
  const controls = cssBlock(".photo-card-controls");
  assert.match(actions, /min-width\s*:\s*44px/);
  assert.match(actions, /min-height\s*:\s*44px/);
  assert.doesNotMatch(actions, /position\s*:\s*absolute/);
  assert.match(controls, /display\s*:\s*flex/);
  assert.match(controls, /flex-wrap\s*:\s*wrap/);
  assert.match(cssBlock(".photo-card-primary:focus-visible"), /outline\s*:\s*3px solid #005a9e/);
  assert.match(cssBlock(".photo-card-controls button:focus-visible"), /outline\s*:\s*3px solid #005a9e/);
  assert.match(cssBlock(".photo-select-badge"), /pointer-events\s*:\s*none/);
});

test("photo card labels include safe metadata without media URLs", () => {
  const labelInput = {
    displayName: "生日 🎂.mp4",
    isVideo: true,
    favorite: true,
    takenDate: "Aug 10, 2026",
    uploadDate: "Aug 11, 2026",
  };
  assert.equal(getPhotoCardGroupLabel(labelInput), "视频 生日 🎂.mp4，已收藏");
  assert.equal(
    getPhotoPrimaryActionLabel(labelInput),
    "打开视频 生日 🎂.mp4，拍摄日期 Aug 10, 2026，上传日期 Aug 11, 2026，已收藏",
  );
  assert.equal(
    getPhotoPrimaryActionLabel({ ...labelInput, displayName: "", isVideo: false, favorite: false, selectionMode: true, selected: false }),
    "选择照片 (未命名照片)，拍摄日期 Aug 10, 2026，上传日期 Aug 11, 2026，未收藏",
  );
  assert.equal(
    getPhotoPrimaryActionLabel({ ...labelInput, selectionMode: true, selected: true }),
    "取消选择视频 生日 🎂.mp4，拍摄日期 Aug 10, 2026，上传日期 Aug 11, 2026，已收藏",
  );
  assert.doesNotMatch(labelSource, /photo\.url|thumbnailUrl|previewUrl|sas/i);
});

test("animated photo labels expose the visible media subtype", () => {
  assert.equal(getPhotoMediaKind({ contentType: "image/gif" }), "GIF");
  assert.equal(getPhotoMediaKind({ contentType: "image/jpeg", isAnimated: true }), "动态照片");
  assert.equal(getPhotoMediaKind({ contentType: "image/webp", isAnimated: true }), "动图");
  const labelInput = {
    displayName: "旅行 🌏.jpg",
    isVideo: false,
    favorite: false,
  };
  assert.match(
    getPhotoPrimaryActionLabel({ ...labelInput, mediaKind: "动态照片" }),
    /^打开动态照片 /,
  );
  assert.match(
    getPhotoCardGroupLabel({ ...labelInput, mediaKind: "GIF" }),
    /^GIF /,
  );
});

test("visible names and action labels never fall back to internal media URLs", () => {
  const internalName = "private/user/blob/1786375577-secret.jpg";
  const mediaUrl = "https://storage.example/private/blob.jpg?sig=secret";
  assert.equal(getPhotoDisplayName(internalName, "家庭合影 📷.jpg"), "家庭合影 📷.jpg");
  assert.equal(getPhotoDisplayName("folder/1786375577-summer.jpg"), "summer.jpg");

  for (const action of ["move", "favorite", "unfavorite", "delete"]) {
    const label = getPhotoActionLabel(action, "家庭合影 📷.jpg");
    assert.match(label, /家庭合影 📷\.jpg/);
    assert.doesNotMatch(label, /private|blob|https|sig=/i);
    assert.doesNotMatch(label, new RegExp(mediaUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
