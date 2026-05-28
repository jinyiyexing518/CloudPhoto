import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  getBlobServiceClient,
  containerName,
  getUserDelegationKey,
  generateSasUrlWithKey,
} from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { isGroupMember } from "../../utils/cosmosClient";

function delegationKeyExpiryMs(key: { signedExpiresOn?: string | Date }): number {
  const raw = key.signedExpiresOn;
  if (!raw) return 0;
  const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

function candidateBlobNames(rawName: string): string[] {
  const result = new Set<string>();
  const trimmed = rawName.trim();
  if (trimmed) result.add(trimmed);
  try {
    const decoded = decodeURIComponent(trimmed);
    if (decoded) result.add(decoded);
  } catch {
    // Keep original name when decode fails.
  }
  return [...result];
}

app.http("createShareLink", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/share",
  handler: async (
    request: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) {
      return {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const rawBlobName = request.query.get("name");
    if (!rawBlobName) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "name required" }),
      };
    }

    const blobNameList = candidateBlobNames(rawBlobName);
    const blobName = blobNameList[0];

    const hoursRaw = Number(request.query.get("hours") ?? "24");
    const hours = Number.isFinite(hoursRaw)
      ? Math.max(1, Math.min(168, Math.floor(hoursRaw)))
      : 24;

    const segs = blobName.split("/");
    if (segs[0] === "personal") {
      if (segs[1] !== payload.userId && payload.role !== "admin") {
        return {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Forbidden" }),
        };
      }
    } else if (segs[0] === "groups") {
      if (!await isGroupMember(segs[1], payload.userId)) {
        return {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Not a member of this group" }),
        };
      }
    } else {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid photo path" }),
      };
    }

    try {
      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);

      let actualBlobName: string | null = null;
      let props: Awaited<ReturnType<ReturnType<typeof containerClient.getBlobClient>["getProperties"]>> | null = null;
      for (const candidate of blobNameList) {
        try {
          const candidateProps = await containerClient.getBlobClient(candidate).getProperties();
          actualBlobName = candidate;
          props = candidateProps;
          break;
        } catch {
          // Try the next candidate variant.
        }
      }

      if (!actualBlobName || !props) {
        return {
          status: 404,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Photo not found" }),
        };
      }

      if (getMeta(props.metadata, "deletedAt")) {
        return {
          status: 404,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Photo not found" }),
        };
      }

      const key = await getUserDelegationKey(hours);
      const url = generateSasUrlWithKey(actualBlobName, key, hours);
      const requestedExpiresAtMs = Date.now() + hours * 3600 * 1000;
      const keyExpiresAtMs = delegationKeyExpiryMs(key);
      const effectiveExpiresAtMs = keyExpiresAtMs > 0
        ? Math.min(requestedExpiresAtMs, keyExpiresAtMs - 60 * 1000)
        : requestedExpiresAtMs;
      const expiresAt = new Date(effectiveExpiresAtMs).toISOString();
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, expiresAt }),
      };
    } catch (error) {
      context.error("Create share link error:", error);
      const message = error instanceof Error ? error.message : "Failed to create share link";
      if (/AuthorizationPermissionMismatch|AuthorizationFailure|Permission/i.test(message)) {
        return {
          status: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Storage permission missing for share link generation" }),
        };
      }
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: message || "Failed to create share link" }),
      };
    }
  },
});
