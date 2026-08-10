import assert from "node:assert/strict";
import test from "node:test";
import backfillCursor from "../dist/src/functions/photos/backfillCursor.js";

const {
  BACKFILL_PAGE_SIZE,
  decodeBackfillCursor,
  encodeBackfillCursor,
} = backfillCursor;

test("round-trips opaque Azure continuation cursors for both backfills", () => {
  const cursor = {
    token: "opaque+/= continuation token",
    after: "personal/user/相册/1700000000-photo.jpg",
    context: "metadata:personal/user",
  };
  const encoded = encodeBackfillCursor(cursor);

  assert.doesNotMatch(encoded, /[+/=]/);
  assert.deepEqual(decodeBackfillCursor(encoded, cursor.context), cursor);
  assert.equal(BACKFILL_PAGE_SIZE, 200);
});

test("normalizes an empty cursor and rejects malformed cursors", () => {
  assert.deepEqual(
    decodeBackfillCursor("", "thumbnails:personal/user"),
    { token: "", after: "", context: "thumbnails:personal/user" },
  );
  assert.equal(decodeBackfillCursor("not-json", "metadata:personal/user"), null);
  assert.equal(decodeBackfillCursor(encodeBackfillCursor({
    token: "token",
    after: "name",
    context: "metadata:personal/user",
  }), "metadata:personal/other-user"), null);
  assert.equal(
    decodeBackfillCursor(
      Buffer.from(JSON.stringify({ token: 1, after: null, context: "metadata:personal/user" })).toString("base64url"),
      "metadata:personal/user",
    ),
    null,
  );
});
