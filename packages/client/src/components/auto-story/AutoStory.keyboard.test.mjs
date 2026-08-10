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
  assert.match(storySource, /event\.target instanceof HTMLInputElement && event\.target\.type === "range"/);
  assert.match(storySource, /setPaused\(\(value\) => !value\)/);
  assert.doesNotMatch(storySource, /window\.addEventListener\("keydown", onKey\)/);
});

test("StoryPlayer exposes one semantic scrubber instead of per-photo controls", () => {
  assert.match(playerSource, /<input[\s\S]*type="range"[\s\S]*min=\{1\}[\s\S]*max=\{storyPhotos\.length\}[\s\S]*value=\{currentIndex \+ 1\}/);
  assert.match(playerSource, /aria-label="故事进度"/);
  assert.match(playerSource, /aria-valuetext=\{`\$\{currentIndex \+ 1\} \/ \$\{storyPhotos\.length\}/);
  assert.match(playerSource, /onChange=\{\(event\) => jumpTo\(Number\(event\.target\.value\) - 1\)\}/);
  assert.doesNotMatch(playerSource, /storyPhotos\.map/);
  assert.doesNotMatch(playerSource, /story-progress-seg/);
});

test("StoryPlayer cancels delayed navigation on rapid input, close, and unmount", () => {
  assert.match(storySource, /navigationTimerRef = useRef<number \| null>\(null\)/);
  assert.match(storySource, /window\.clearTimeout\(navigationTimerRef\.current\)/);
  assert.match(storySource, /const scheduleNavigation = useCallback/);
  assert.match(storySource, /closeStoryPlayer = useCallback\(\(\) => \{[\s\S]*cancelPendingNavigation\(\)/);
  assert.match(storySource, /closeStoryPlayer = useCallback\(\(\) => \{[\s\S]*setAnimClass\("story-enter"\)/);
  assert.match(storySource, /useEffect\(\(\) => cancelPendingNavigation, \[cancelPendingNavigation\]\)/);
  assert.match(storySource, /const jumpTo = useCallback[\s\S]*cancelPendingNavigation\(\)/);
});

test("StoryPlayer stays on preview derivatives without passive original or video loading", () => {
  assert.match(previewGridSource, /<MediaThumb[\s\S]*thumbnailUrl=\{p\.thumbnailUrl\}[\s\S]*previewUrl=\{p\.previewUrl\}/);
  assert.doesNotMatch(previewGridSource, /<video/);
  assert.match(storySource, /selectGridMediaSources\(currentPhoto\)/);
  assert.match(playerSource, /currentPhotoIsVideo \? \([\s\S]*<MediaThumb/);
  assert.match(playerSource, /src=\{currentPreviewSources\[0\] \?\? BLANK_GIF\}/);
  assert.doesNotMatch(playerSource, /<video/);
});
