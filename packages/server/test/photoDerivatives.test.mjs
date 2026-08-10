import assert from "node:assert/strict";
import test from "node:test";
import photoDerivatives from "../dist/src/functions/photos/photoDerivatives.js";

const {
  expectedPhotoDerivativeNames,
  resolveListedPhotoDerivatives,
} = photoDerivatives;

test("recovers exact thumbnail and preview blobs from the existing flat listing", () => {
  const originalName = "personal/user-a/trips/2026/clip.mp4";
  const expected = expectedPhotoDerivativeNames(originalName);
  const listed = new Set([
    originalName,
    expected.thumbnailName,
    expected.previewName,
  ]);

  assert.deepEqual(resolveListedPhotoDerivatives(originalName, listed), expected);
});

test("does not attach lookalike or cross-folder derivatives", () => {
  const originalName = "groups/group-a/_/clip.mp4";
  const expected = expectedPhotoDerivativeNames(originalName);

  assert.deepEqual(
    resolveListedPhotoDerivatives(originalName, new Set([
      "groups/group-a/other/_th_clip.mp4.webp",
      `${expected.thumbnailName}.bak`,
      "groups/group-a/_/_th_other-clip.mp4.webp",
    ])),
    {},
  );
});
