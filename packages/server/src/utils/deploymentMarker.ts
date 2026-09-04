import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface DeploymentMarkerResponse {
  status: number;
  headers: {
    "Content-Type": string;
    "Cache-Control": string;
  };
  body: string;
}

function requireCommitSha(value: unknown): string {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error("Deployment marker must contain a lowercase 40-character commit SHA");
  }
  return value;
}

export function parseDeploymentMarker(serialized: string): string {
  let marker: unknown;
  try {
    marker = JSON.parse(serialized);
  } catch {
    throw new Error("Deployment marker is not valid JSON");
  }
  if (
    !marker
    || typeof marker !== "object"
    || Array.isArray(marker)
    || Object.keys(marker).length !== 1
  ) {
    throw new Error("Deployment marker must contain only sha");
  }
  const sha = requireCommitSha(Reflect.get(marker, "sha"));
  const canonical = JSON.stringify({ sha });
  if (serialized !== canonical && serialized !== `${canonical}\n`) {
    throw new Error("Deployment marker must use canonical JSON");
  }
  return sha;
}

export async function readDeploymentSha(
  markerPath = resolve(process.cwd(), "deployment.json")
): Promise<string> {
  return parseDeploymentMarker(await readFile(markerPath, "utf8"));
}

export function deploymentMarkerResponse(sha: string): DeploymentMarkerResponse {
  return {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({ sha: requireCommitSha(sha) }),
  };
}

export function deploymentMarkerUnavailableResponse(): DeploymentMarkerResponse {
  return {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({ error: "Deployment identity unavailable" }),
  };
}
