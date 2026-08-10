import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mediaThumbSource = readFileSync(new URL("./MediaThumb.tsx", import.meta.url), "utf8");
const audioBranch = mediaThumbSource.slice(
  mediaThumbSource.indexOf("if (isAudio)"),
  mediaThumbSource.indexOf("if (!isVideo)"),
);

test("audio thumbnails render a local, correctly named placeholder", () => {
  assert.match(mediaThumbSource, /const isAudio = contentType\?\.startsWith\("audio\/"\) \?\? false/);
  assert.match(audioBranch, /className=\{\[className, "audio-thumb-placeholder"\]/);
  assert.match(audioBranch, /data-media-policy=\{GRID_MEDIA_POLICY_MARKER\}/);
  assert.match(audioBranch, /role="img"/);
  assert.match(audioBranch, /aria-label=\{alt \? `\$\{alt\}，音频文件` : "音频文件"\}/);
  assert.match(audioBranch, /audio-thumb-placeholder-icon[\s\S]*🎵/);
  assert.match(audioBranch, /photo-audio-badge[\s\S]*音频/);
});

test("audio thumbnail branch cannot request an image, video, or original source", () => {
  assert.doesNotMatch(audioBranch, /<img|<video|<audio|src=|url/);
  assert.match(audioBranch, /media-thumb-audio-wrap/);
  assert.match(audioBranch, /wrapClass \? "" : "media-thumb-audio-wrap--fill"/);
  assert.doesNotMatch(audioBranch, /if \(wrapClass\) return/);
});
