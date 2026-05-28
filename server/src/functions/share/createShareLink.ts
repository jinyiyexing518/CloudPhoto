import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import {
  getBlobServiceClient,
  containerName,
  getUserDelegationKey,
  generateSasUrlWithKey,
} from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { isGroupMember, getShareLinksContainer, ShareLinkDoc } from "../../utils/cosmosClient";

function decodeMeta(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try { return Buffer.from(raw, "base64").toString("utf8") || undefined; }
  catch { return raw || undefined; }
}

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

function normalizeFolderPath(rawFolder: string): string {
  if (rawFolder === "_") return "";
  return rawFolder
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function resolvePublicBaseUrl(request: HttpRequest): string {
  // Use explicit share URL base only when configured.
  const shareBase = process.env.SHARE_PUBLIC_BASE_URL?.trim();
  if (shareBase) return normalizeBaseUrl(shareBase);

  // Default to current API origin to avoid frontend-auth interception.
  return normalizeBaseUrl(new URL(request.url).origin);
}

function isCosmosWriteAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (statusCode === 401 || statusCode === 403) return true;
  const message = (error as { message?: string }).message ?? "";
  return /Request blocked by Auth|cosmos-native-rbac|cannot be authorized by AAD token|Authorization/i.test(message);
}

function isCosmosManagedShareUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (statusCode === 401 || statusCode === 403 || statusCode === 404) return true;
  const message = (error as { message?: string }).message ?? "";
  return /Request blocked by Auth|cosmos-native-rbac|cannot be authorized by AAD token|Authorization|NotFound|Owner resource does not exist|sharelinks/i.test(message);
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
    const hasFolderParam = request.query.has("folder");
    const rawFolderPath = request.query.get("folder") ?? "";
    if (!rawBlobName && !hasFolderParam) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "name or folder required" }),
      };
    }

    const hoursRaw = Number(request.query.get("hours") ?? "24");
    const hours = Number.isFinite(hoursRaw)
      ? Math.max(1, Math.min(168, Math.floor(hoursRaw)))
      : 24;

    try {
      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);

      if (hasFolderParam) {
        const folderPath = normalizeFolderPath(rawFolderPath);
        const groupId = (request.query.get("groupId") ?? "").trim();

        if (groupId) {
          if (!await isGroupMember(groupId, payload.userId)) {
            return {
              status: 403,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ error: "Not a member of this group" }),
            };
          }
        }

        const folderSegment = folderPath === "" ? "_" : folderPath;
        const targetPrefix = `${groupId ? `groups/${groupId}` : `personal/${payload.userId}`}/${folderSegment}/`;

        let hasShareablePhoto = false;
        for await (const blob of containerClient.listBlobsFlat({ prefix: targetPrefix, includeMetadata: true })) {
          if (!getMeta(blob.metadata, "deletedAt")) {
            hasShareablePhoto = true;
            break;
          }
        }

        if (!hasShareablePhoto) {
          return {
            status: 404,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Folder has no shareable photos" }),
          };
        }

        const requestedExpiresAtMs = Date.now() + hours * 3600 * 1000;
        const expiresAt = new Date(requestedExpiresAtMs).toISOString();
        const linkId = randomUUID();
        const createdAt = new Date().toISOString();
        const displayName = folderPath === ""
          ? "未分类"
          : `文件夹：${folderPath}`;
        const doc: ShareLinkDoc = {
          id: linkId,
          createdByUserId: payload.userId,
          createdByName: payload.displayName,
          displayName,
          groupId: groupId || undefined,
          targetType: "folder",
          folderPath,
          targetPrefix,
          createdAt,
          expiresAt,
          status: "active",
          viewCount: 0,
        };

        try {
          const shareLinks = await getShareLinksContainer();
          await shareLinks.items.create(doc);
        } catch (e) {
          if (isCosmosManagedShareUnavailable(e)) {
            return {
              status: 503,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ error: "Folder sharing requires the existing Cosmos sharelinks container and managed share permissions" }),
            };
          }
          throw e;
        }

        const baseUrl = resolvePublicBaseUrl(request);
        const managedUrl = `${baseUrl}/api/photos/share/open/${encodeURIComponent(linkId)}`;

        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: managedUrl,
            expiresAt,
            shareId: linkId,
            managed: true,
          }),
        };
      }

      const blobNameList = candidateBlobNames(rawBlobName as string);
      const blobName = blobNameList[0];
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

      const linkId = randomUUID();
      const createdAt = new Date().toISOString();
      const displayName = decodeMeta(getMeta(props.metadata, "originalName"))
        || actualBlobName.split("/").pop()
        || actualBlobName;
      const doc: ShareLinkDoc = {
        id: linkId,
        createdByUserId: payload.userId,
        createdByName: payload.displayName,
        blobName: actualBlobName,
        displayName,
        groupId: segs[0] === "groups" ? segs[1] : undefined,
        targetType: "photo",
        createdAt,
        expiresAt,
        status: "active",
        viewCount: 0,
      };

      let managedShareAvailable = true;
      try {
        const shareLinks = await getShareLinksContainer();
        await shareLinks.items.create(doc);
      } catch (e) {
        if (isCosmosManagedShareUnavailable(e)) {
          managedShareAvailable = false;
          context.warn("Managed share link unavailable due to Cosmos config/container access; falling back to direct SAS", e);
        } else {
          throw e;
        }
      }

      const baseUrl = resolvePublicBaseUrl(request);
      const managedUrl = `${baseUrl}/api/photos/share/open/${encodeURIComponent(linkId)}`;
      const finalUrl = managedShareAvailable ? managedUrl : url;

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: finalUrl,
          expiresAt,
          shareId: managedShareAvailable ? linkId : undefined,
          directUrl: url,
          managed: managedShareAvailable,
        }),
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
