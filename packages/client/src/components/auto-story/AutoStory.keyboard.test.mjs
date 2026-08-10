import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const storySource = readFileSync(new URL("./AutoStory.tsx", import.meta.url), "utf8");
const previewGridSource = storySource.slice(
  storySource.indexOf("{/* Preview grid */"),
  storySource.indexOf("{/* Full-screen player */"),
);
const playerSource = storySource.slice(storySource.indexOf("{/* Full-screen player */"));

test("StoryPlayer uses the shared modal boundary and restores its trigger", () => {
  assert.match(storySource, /useModalFocusBoundary\(\{[\s\S]*active: playing && currentPhoto !== undefined/);
  assert.match(storySource, /className=\{`story-player story-player--\$\{transition\}`\}[\s\S]*data-modal-layer/);
  assert.match(storySource, /role="dialog"/);
  assert.match(storySource, /aria-modal="true"/);
  assert.match(storySource, /aria-label="自动故事播放器"/);
  assert.match(storySource, /tabIndex=\{-1\}/);
  assert.match(storySource, /initialFocusRef: storyCloseButtonRef/);
  assert.match(storySource, /ref=\{storyCloseButtonRef\}/);
  assert.match(storySource, /storyLayerRef\.current = element;[\s\S]*storyDialogRef\.current = element;/);
  assert.match(storySource, /onEscape: \(\) => \{[\s\S]*closeStoryPlayer\(\)/);
});

test("StoryPlayer keeps arrows and pause controls inside the modal boundary", () => {
  assert.match(storySource, /const onStoryKeyDown = useCallback[\s\S]*ArrowLeft[\s\S]*prev\(\)[\s\S]*ArrowRight[\s\S]*next\(\)/);
  assert.match(storySource, /setPaused\(\(value\) => !value\)/);
  assert.doesNotMatch(storySource, /window\.addEventListener\("keydown", onKey\)/);
});

test("StoryPlayer stays on preview derivatives without passive original or video loading", () => {
  assert.match(previewGridSource, /<MediaThumb[\s\S]*thumbnailUrl=\{p\.thumbnailUrl\}[\s\S]*previewUrl=\{p\.previewUrl\}/);
  assert.doesNotMatch(previewGridSource, /<video/);
  assert.match(storySource, /selectGridMediaSources\(currentPhoto\)/);
  assert.match(playerSource, /currentPhotoIsVideo \? \([\s\S]*<MediaThumb/);
  assert.match(playerSource, /src=\{currentPreviewSources\[0\] \?\? BLANK_GIF\}/);
  assert.doesNotMatch(playerSource, /<video/);
});
