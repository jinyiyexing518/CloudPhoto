import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import deploymentFunction from "../dist/src/functions/deployment/getDeployment.js";
import deploymentMarker from "../dist/src/utils/deploymentMarker.js";

const { createGetDeploymentHandler } = deploymentFunction;
const {
  deploymentMarkerResponse,
  deploymentMarkerUnavailableResponse,
  parseDeploymentMarker,
  readDeploymentSha,
} = deploymentMarker;

test("accepts only one canonical deployment SHA", () => {
  const sha = "a".repeat(40);
  assert.equal(parseDeploymentMarker(JSON.stringify({ sha })), sha);

  for (const serialized of [
    "",
    "not-json",
    "[]",
    "{}",
    JSON.stringify({ sha: "A".repeat(40) }),
    JSON.stringify({ sha: "a".repeat(39) }),
    JSON.stringify({ sha, branch: "main" }),
    `{"sha":"${"b".repeat(40)}","sha":"${sha}"}`,
  ]) {
    assert.throws(() => parseDeploymentMarker(serialized), /Deployment marker/);
  }
  assert.equal(parseDeploymentMarker(`${JSON.stringify({ sha })}\n`), sha);
});

test("reads the packaged marker and returns an exact no-store response", async () => {
  const sha = "b".repeat(40);
  const directory = await mkdtemp(join(tmpdir(), "cloudphoto-deployment-marker-"));
  const markerPath = join(directory, "deployment.json");
  try {
    await writeFile(markerPath, `${JSON.stringify({ sha })}\n`, "utf8");
    assert.equal(await readDeploymentSha(markerPath), sha);
    assert.deepEqual(deploymentMarkerResponse(sha), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ sha }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns a no-store 503 without exposing marker failure details", () => {
  assert.deepEqual(deploymentMarkerUnavailableResponse(), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({ error: "Deployment identity unavailable" }),
  });
});

test("serves the packaged SHA through the anonymous deployment handler", async () => {
  const sha = "c".repeat(40);
  const handler = createGetDeploymentHandler(async () => sha);
  assert.deepEqual(await handler({}, { error: () => {} }), deploymentMarkerResponse(sha));
});

test("fails closed without returning deployment marker errors", async () => {
  const messages = [];
  const handler = createGetDeploymentHandler(async () => {
    throw new Error("C:\\sensitive\\deployment.json was missing");
  });
  const response = await handler({}, {
    error: (...parts) => messages.push(parts),
  });
  assert.deepEqual(response, deploymentMarkerUnavailableResponse());
  assert.equal(response.body.includes("sensitive"), false);
  assert.equal(messages.length, 1);
});
