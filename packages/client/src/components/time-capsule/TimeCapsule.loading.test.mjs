import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const capsuleSource = readFileSync(new URL("./TimeCapsule.tsx", import.meta.url), "utf8");
const authenticatedCss = readFileSync(new URL("../../authenticated.css", import.meta.url), "utf8");
const {
  CAPSULE_PHOTO_BATCH_SIZE,
  CAPSULE_PHOTO_INITIAL_COUNT,
  advanceIncrementalWindow,
  resolveIncrementalVisibleCount,
} = await import("../shared/incrementalRenderWindow.ts");

test("capsule media window starts below the production request budget and reaches all 60", () => {
  assert.equal(CAPSULE_PHOTO_INITIAL_COUNT, 18);
  assert.equal(CAPSULE_PHOTO_BATCH_SIZE, 12);
  assert.ok(CAPSULE_PHOTO_INITIAL_COUNT <= 18);

  let state = { sourceKey: "", count: CAPSULE_PHOTO_INITIAL_COUNT };
  const seenCounts = [];
  while (resolveIncrementalVisibleCount(state, "recent", 60) < 60) {
    state = advanceIncrementalWindow(state, "recent", 60);
    seenCounts.push(state.count);
  }

  assert.deepEqual(seenCounts, [30, 42, 54, 60]);
  assert.equal(new Set(seenCounts).size, seenCounts.length);
});

test("source changes reset synchronously while a still-focused photo remains mounted", () => {
  const fullWindow = { sourceKey: "recent", count: 60 };

  assert.equal(resolveIncrementalVisibleCount(fullWindow, "folder-a", 60), 18);
  assert.equal(resolveIncrementalVisibleCount(fullWindow, "folder-a", 60, 37), 38);
  assert.equal(resolveIncrementalVisibleCount(fullWindow, "folder-a", 8), 8);
});

test("capsule observes an internal sentinel and renders only the current derivative window", () => {
  assert.match(capsuleSource, /ref=\{capsulePhotoGridRef\}[\s\S]*className="capsule-photo-grid"/);
  assert.match(capsuleSource, /visibleDisplayPhotos\.map/);
  assert.match(capsuleSource, /displayPhotos\.slice\(0, visiblePhotoCount\)/);
  assert.match(capsuleSource, /photoScrollState\.sourceKey === displayPhotoSourceKey[\s\S]*photoScrollState\.scrolled/);
  assert.match(capsuleSource, /onScroll=\{\(event\) => \{[\s\S]*event\.currentTarget\.scrollTop <= 0[\s\S]*setPhotoScrollState/);
  assert.match(capsuleSource, /useLayoutEffect\(\(\) => \{[\s\S]*committedPhotoSourceKeyRef\.current === displayPhotoSourceKey[\s\S]*scrollTop = 0/);
  assert.match(capsuleSource, /new IntersectionObserver\([\s\S]*root: scrollRoot[\s\S]*rootMargin: "0px 0px 96px 0px"/);
  assert.match(capsuleSource, /!showCreateRef\.current[\s\S]*displayPhotoSourceKeyRef\.current !== observerSourceKey/);
  assert.match(capsuleSource, /observer\.observe\(sentinel\)/);
  assert.match(authenticatedCss, /\.capsule-photo-sentinel\s*\{[^}]*margin-top:\s*96px;/);
  assert.match(capsuleSource, /visibleIndex !== visibleDisplayPhotos\.length - 1[\s\S]*matches\(":focus-visible"\)[\s\S]*advanceIncrementalWindow/);
  assert.match(capsuleSource, /showCreate,[\s\S]*visiblePhotoCount,[\s\S]*\]\);/);
  assert.match(capsuleSource, /key="capsule-photo-sentinel"[\s\S]*ref=\{capsulePhotoSentinelRef\}/);
  assert.match(capsuleSource, /active = false;[\s\S]*observer\.disconnect\(\)/);
  assert.match(capsuleSource, /resetCapsulePhotoWindow\(\);[\s\S]*setShowCreate\(true\)/);
  assert.match(capsuleSource, /resetCapsulePhotoWindow\(\);[\s\S]*setFolderFilter\(e\.target\.value\)/);
  assert.match(capsuleSource, /data-capsule-photo-name=\{p\.name\}/);
  assert.match(capsuleSource, /<MediaThumb[\s\S]*thumbnailUrl=\{p\.thumbnailUrl\}[\s\S]*previewUrl=\{p\.previewUrl\}/);
  assert.doesNotMatch(capsuleSource, /<video/);
});
