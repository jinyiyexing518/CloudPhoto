import assert from "node:assert/strict";
import test from "node:test";

test("access-token verification rejects refresh tokens", async () => {
  process.env.JWT_SECRET = "location-contract-secret";
  const jwt = (await import("../dist/src/utils/auth/jwtUtils.js")).default;
  const payload = {
    userId: "user-1",
    username: "viewer",
    displayName: "Viewer",
    role: "user",
  };
  const access = jwt.signToken(payload);
  const refresh = jwt.signRefreshToken(payload);
  assert.equal(jwt.verifyToken(access)?.userId, payload.userId);
  assert.equal(jwt.verifyToken(refresh), null);
  assert.equal(jwt.extractTokenFromHeader(`Bearer ${refresh}`), null);
  assert.deepEqual(jwt.verifyRefreshToken(refresh), payload);
});
