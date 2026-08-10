import assert from "node:assert/strict";
import test from "node:test";
import admissionModule from "../dist/src/functions/photos/uploadAdmission.js";

const {
  UploadAdmissionController,
  resolveUploadLengthReservation,
  validateBufferedUploadLength,
} = admissionModule;
const MB = 1024 * 1024;

test("rejects an oversized declared body before buffering", () => {
  assert.deepEqual(resolveUploadLengthReservation(String(201 * MB), 200 * MB), {
    kind: "too-large",
    declaredBytes: 201 * MB,
  });
});

test("missing and invalid lengths are rejected before buffering", () => {
  assert.deepEqual(resolveUploadLengthReservation(null, 20 * MB), {
    kind: "invalid",
    reason: "missing",
  });
  assert.deepEqual(resolveUploadLengthReservation("invalid", 20 * MB), {
    kind: "invalid",
    reason: "invalid",
  });
  assert.equal(validateBufferedUploadLength(21 * MB, 20 * MB), false);
  assert.equal(validateBufferedUploadLength(20 * MB, 20 * MB), true);
  assert.equal(validateBufferedUploadLength(19 * MB, 20 * MB, 20 * MB), false);
});

test("weighted per-user and per-instance admission rejects with Retry-After and releases safely", () => {
  const controller = new UploadAdmissionController({
    instanceMaxWeight: 3,
    userMaxWeight: 3,
    instanceMaxDeclaredBytes: 256 * MB,
    userMaxDeclaredBytes: 220 * MB,
    retryAfterSeconds: 3,
  });
  const video = controller.tryAcquire("user-a", 2, 200 * MB);
  assert.equal(video.accepted, true);
  const image = controller.tryAcquire("user-a", 1, 20 * MB);
  assert.equal(image.accepted, true);
  assert.deepEqual(controller.tryAcquire("user-a", 1, 1 * MB), {
    accepted: false,
    retryAfterSeconds: 3,
  });
  assert.deepEqual(controller.tryAcquire("user-b", 1, 40 * MB), {
    accepted: false,
    retryAfterSeconds: 3,
  });
  assert.equal(controller.snapshot().userCount, 1);
  image.lease.release();
  image.lease.release();
  video.lease.release();
  assert.deepEqual(controller.snapshot(), {
    activeWeight: 0,
    activeDeclaredBytes: 0,
    userCount: 0,
  });
});
