import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import photoAccess from "../dist/src/utils/auth/photoAccess.js";

const {
  canAccessPhotoPath,
  isGalleryPhotoPath,
  isPhotoFolderPath,
  isPhotoPathWithinScope,
  isPhotoPathWithinSameScope,
  isVoiceMemoPathWithinPhotoScope,
  sanitizeDownloadFilename,
} = photoAccess;

function collectTypeScriptSources(directory) {
  const sources = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...collectTypeScriptSources(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      sources.push({ path, source: readFileSync(path, "utf8") });
    }
  }
  return sources;
}

test("authorizes only owned personal paths or joined group paths", async () => {
  const memberships = [];
  const isGroupMember = async (groupId, userId) => {
    memberships.push([groupId, userId]);
    return groupId === "group-a" && userId === "user-a";
  };

  assert.equal(
    await canAccessPhotoPath(
      "personal/user-a/_/photo.jpg",
      { userId: "user-a", role: "viewer" },
      isGroupMember,
    ),
    true,
  );
  assert.equal(
    await canAccessPhotoPath(
      "personal/user-b/_/photo.jpg",
      { userId: "user-a", role: "viewer" },
      isGroupMember,
    ),
    false,
  );
  assert.equal(
    await canAccessPhotoPath(
      "personal/user-b/_/photo.jpg",
      { userId: "admin", role: "admin" },
      isGroupMember,
    ),
    true,
  );
  assert.equal(
    await canAccessPhotoPath(
      "groups/group-a/_/photo.jpg",
      { userId: "user-a", role: "viewer" },
      isGroupMember,
    ),
    true,
  );
  assert.equal(
    await canAccessPhotoPath(
      "groups/group-b/_/photo.jpg",
      { userId: "user-a", role: "viewer" },
      isGroupMember,
    ),
    false,
  );
  assert.equal(
    await canAccessPhotoPath(
      "groups/group-a/_/_th_photo.webp",
      { userId: "user-a", role: "viewer" },
      isGroupMember,
    ),
    false,
  );
  assert.equal(
    await canAccessPhotoPath(
      "../groups/group-a/photo.jpg",
      { userId: "user-a", role: "viewer" },
      isGroupMember,
    ),
    false,
  );
  assert.equal(
    await canAccessPhotoPath(
      "uploads/user-a/_/photo.jpg",
      { userId: "admin", role: "admin" },
      isGroupMember,
    ),
    false,
  );
  assert.equal(
    await canAccessPhotoPath(
      "personal/user-a/_voice/memo.webm",
      { userId: "user-a", role: "viewer" },
      isGroupMember,
    ),
    false,
  );
  assert.equal(
    await canAccessPhotoPath(
      "personal/user-a/folder/_voice/memo.webm",
      { userId: "user-a", role: "viewer" },
      isGroupMember,
    ),
    false,
  );
  assert.deepEqual(memberships, [
    ["group-a", "user-a"],
    ["group-b", "user-a"],
  ]);
});

test("recognizes only listable photo folders and recorded scopes", () => {
  assert.equal(isPhotoFolderPath("_"), true);
  assert.equal(isPhotoFolderPath("Trips/2026"), true);
  assert.equal(isPhotoFolderPath("_th_archive/2026"), true);
  assert.equal(isPhotoFolderPath("_voice"), false);
  assert.equal(isPhotoFolderPath("Trips/_voice"), false);
  assert.equal(isPhotoFolderPath("Trips/../Other"), false);
  assert.equal(isPhotoFolderPath("Trips\\Other"), false);
  assert.equal(isPhotoFolderPath("Trips/\u001fOther"), false);

  assert.equal(isGalleryPhotoPath("personal/user-a/_/photo.jpg"), true);
  assert.equal(isGalleryPhotoPath("personal/user-a/_th_archive/photo.jpg"), true);
  assert.equal(isGalleryPhotoPath("personal/user-a/_/_th_photo.webp"), false);
  assert.equal(isGalleryPhotoPath("personal/user-a/_voice/memo.webm"), false);
  assert.equal(isGalleryPhotoPath("personal/user-a/Trips/_voice/memo.webm"), false);

  assert.equal(
    isPhotoPathWithinScope("groups/group-a/Trips/photo.jpg", "groups/group-a"),
    true,
  );
  assert.equal(
    isPhotoPathWithinScope("groups/group-b/Trips/photo.jpg", "groups/group-a"),
    false,
  );
  assert.equal(
    isPhotoPathWithinScope("personal/user-a/_/photo.jpg", "personal/user-a/extra"),
    false,
  );
});

test("allows moves only between listable photo paths in the same scope", () => {
  assert.equal(
    isPhotoPathWithinSameScope(
      "personal/user-a/_/photo.jpg",
      "personal/user-a/trips/2026/photo.jpg",
    ),
    true,
  );
  assert.equal(
    isPhotoPathWithinSameScope(
      "groups/group-a/old/photo.jpg",
      "groups/group-a/new/photo.jpg",
    ),
    true,
  );
  assert.equal(
    isPhotoPathWithinSameScope(
      "personal/user-a/_/photo.jpg",
      "personal/user-b/_/photo.jpg",
    ),
    false,
  );
  assert.equal(
    isPhotoPathWithinSameScope(
      "groups/group-a/_/photo.jpg",
      "groups/group-b/_/photo.jpg",
    ),
    false,
  );
  assert.equal(
    isPhotoPathWithinSameScope(
      "personal/user-a/_/photo.jpg",
      "personal/user-a/_voice/photo.jpg",
    ),
    false,
  );
  assert.equal(
    isPhotoPathWithinSameScope(
      "personal/user-a/_/photo.jpg",
      "personal/user-a/../photo.jpg",
    ),
    false,
  );
});

test("allows voice pointers only in the same scope's dedicated voice folder", () => {
  assert.equal(
    isVoiceMemoPathWithinPhotoScope(
      "personal/user-a/_/photo.jpg",
      "personal/user-a/_voice/memo.webm",
    ),
    true,
  );
  assert.equal(
    isVoiceMemoPathWithinPhotoScope(
      "groups/group-a/trips/photo.jpg",
      "groups/group-a/_voice/memo.webm",
    ),
    true,
  );
  assert.equal(
    isVoiceMemoPathWithinPhotoScope(
      "personal/user-a/_/photo.jpg",
      "personal/user-b/_voice/memo.webm",
    ),
    false,
  );
  assert.equal(
    isVoiceMemoPathWithinPhotoScope(
      "groups/group-a/_/photo.jpg",
      "groups/group-b/_voice/memo.webm",
    ),
    false,
  );
  assert.equal(
    isVoiceMemoPathWithinPhotoScope(
      "personal/user-a/_/photo.jpg",
      "personal/user-a/folder/memo.webm",
    ),
    false,
  );
  assert.equal(
    isVoiceMemoPathWithinPhotoScope(
      "personal/user-a/_/photo.jpg",
      "personal/user-a/_voice/nested/memo.webm",
    ),
    false,
  );
});

test("guards every client-addressable photo path before Blob access", () => {
  const functionsDirectory = fileURLToPath(new URL("../src/functions/", import.meta.url));
  const queryPathSources = collectTypeScriptSources(functionsDirectory)
    .filter(({ source }) =>
      /request\.query\s*\.\s*(?:get|getAll)\s*\((?:"|')(?:name|blobName)(?:"|')\)/.test(source),
    );
  assert(
    queryPathSources.length >= 9,
    "path-route discovery must find the existing client-addressable endpoints",
  );

  const guardedSources = [
    ...queryPathSources,
    {
      path: fileURLToPath(new URL("../src/functions/photos/movePhoto.ts", import.meta.url)),
      source: readFileSync(
        new URL("../src/functions/photos/movePhoto.ts", import.meta.url),
        "utf8",
      ),
    },
  ];

  for (const { path, source } of guardedSources) {
    const authorization = source.indexOf("await canAccessPhotoPath(");
    const blobAccess = source.indexOf("getBlobServiceClient()");
    assert.notEqual(authorization, -1, `${path} must authorize the path`);
    if (blobAccess !== -1) {
      assert(
        authorization < blobAccess,
        `${path} must authorize before Blob access`,
      );
    }
  }
});

test("keeps upload and managed-share targets out of internal Blob namespaces", () => {
  const upload = readFileSync(
    new URL("../src/functions/photos/uploadPhoto.ts", import.meta.url),
    "utf8",
  );
  const createShare = readFileSync(
    new URL("../src/functions/share/createShareLink.ts", import.meta.url),
    "utf8",
  );
  const openShare = readFileSync(
    new URL("../src/functions/share/openShareLink.ts", import.meta.url),
    "utf8",
  );

  assert.match(upload, /isPhotoFolderPath\(safeFolderPath\)/);
  assert.match(createShare, /isPhotoFolderPath\(folderSegment\)/);
  assert.match(createShare, /isGalleryPhotoPath\(blob\.name\)/);
  assert.match(createShare, /targetScope,/);
  assert.match(openShare, /resource\.targetScope/);
  assert.match(openShare, /resource\.targetPrefix !== expectedTargetPrefix/);
  assert.match(openShare, /!isGalleryPhotoPath\(blob\.name\)/);
  assert.match(openShare, /!isPhotoPathWithinScope\(blobName, scopePrefix\)/);
});

test("validates move destinations and voice pointers before storing or signing them", () => {
  const move = readFileSync(
    new URL("../src/functions/photos/movePhoto.ts", import.meta.url),
    "utf8",
  );
  const metadata = readFileSync(
    new URL("../src/functions/photos/updatePhotoMetadata.ts", import.meta.url),
    "utf8",
  );
  const list = readFileSync(
    new URL("../src/functions/photos/listPhotos.ts", import.meta.url),
    "utf8",
  );

  assert.match(move, /isPhotoPathWithinSameScope\(name, newBlobName\)/);
  assert.match(
    metadata,
    /isVoiceMemoPathWithinPhotoScope\(blobName, body\.voiceMemoName\)/,
  );
  assert.match(
    list,
    /isVoiceMemoPathWithinPhotoScope\(blob\.name, storedVoiceMemoName\)/,
  );
});

test("sanitizes client-provided download filenames without changing normal Unicode names", () => {
  assert.equal(sanitizeDownloadFilename("旅行照片 01.jpg", "fallback.jpg"), "旅行照片 01.jpg");
  assert.equal(sanitizeDownloadFilename("../bad\r\nname.jpg", "fallback.jpg"), ".._bad__name.jpg");
  assert.equal(sanitizeDownloadFilename("   ", "fallback.jpg"), "fallback.jpg");
  assert.equal(sanitizeDownloadFilename(undefined, "fallback.jpg"), "fallback.jpg");
  assert.equal(sanitizeDownloadFilename("a".repeat(300), "fallback.jpg").length, 180);
});
