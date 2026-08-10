import assert from "node:assert/strict";
import test from "node:test";
import photoAccess from "../dist/src/utils/auth/photoAccess.js";

const { canAccessPhotoPath, sanitizeDownloadFilename } = photoAccess;

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
  assert.deepEqual(memberships, [
    ["group-a", "user-a"],
    ["group-b", "user-a"],
  ]);
});

test("sanitizes client-provided download filenames without changing normal Unicode names", () => {
  assert.equal(sanitizeDownloadFilename("旅行照片 01.jpg", "fallback.jpg"), "旅行照片 01.jpg");
  assert.equal(sanitizeDownloadFilename("../bad\r\nname.jpg", "fallback.jpg"), ".._bad__name.jpg");
  assert.equal(sanitizeDownloadFilename("   ", "fallback.jpg"), "fallback.jpg");
  assert.equal(sanitizeDownloadFilename(undefined, "fallback.jpg"), "fallback.jpg");
  assert.equal(sanitizeDownloadFilename("a".repeat(300), "fallback.jpg").length, 180);
});
