import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { ContainerClient } from "@azure/storage-blob";
import {
  containerName,
  generateSasUrlWithKey,
  getBlobServiceClient,
  getUserDelegationKey,
} from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { canAccessPhotoPath } from "../../utils/auth/photoAccess";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import {
  beginPhotoCatalogMutation,
  finishPhotoCatalogMutation,
  renewPhotoCatalogMutation,
} from "../../utils/cosmos/photoCatalog";
import { expectedPhotoDerivativeNames } from "./photoDerivatives";
import {
  photoDerivativeStrategy,
  resolveUploadMediaType,
} from "./uploadMediaType";
import { UploadAdmissionController } from "./uploadAdmission";
import type sharpT from "sharp";

const MAX_REPAIR_SOURCE_BYTES = 24 * 1024 * 1024;
const coverRepairAdmission = new UploadAdmissionController({
  instanceMaxWeight: 2,
  userMaxWeight: 2,
  instanceMaxDeclaredBytes: 2 * MAX_REPAIR_SOURCE_BYTES,
  userMaxDeclaredBytes: 2 * MAX_REPAIR_SOURCE_BYTES,
  retryAfterSeconds: 5,
});
const inFlightRepairs = new Map<string, Promise<PhotoCoverRepairResult>>();
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

let sharpFn: typeof sharpT | null = null;
function getSharp(): typeof sharpT | null {
  if (sharpFn !== null) return sharpFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sharpFn = require("sharp") as typeof sharpT;
    return sharpFn;
  } catch {
    return null;
  }
}

interface PhotoCoverRepairResult {
  thumbnailUrl: string;
  previewUrl: string;
}

class PhotoCoverRepairError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PhotoCoverRepairError";
  }
}

function getMeta(
  metadata: Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

function decodeMeta(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return Buffer.from(raw, "base64").toString("utf8") || undefined;
  } catch {
    return raw;
  }
}

function setMeta(
  metadata: Record<string, string>,
  key: string,
  value: string,
): void {
  for (const existing of Object.keys(metadata)) {
    if (existing.toLowerCase() === key.toLowerCase()) delete metadata[existing];
  }
  metadata[key] = value;
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown; code?: unknown }).statusCode
    ?? (error as { code?: unknown }).code;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

async function repairPhotoCover(
  blobName: string,
  force: boolean,
  context: InvocationContext,
  containerClient: ContainerClient,
): Promise<PhotoCoverRepairResult> {
  const originalClient = containerClient.getBlockBlobClient(blobName);
  let initialProperties;
  try {
    initialProperties = await originalClient.getProperties();
  } catch (error) {
    if (statusCode(error) === 404) {
      throw new PhotoCoverRepairError(404, "not_found", "Photo not found");
    }
    throw error;
  }
  if (getMeta(initialProperties.metadata, "deletedAt")) {
    throw new PhotoCoverRepairError(409, "deleted", "Photo was deleted");
  }

  const resolvedContentType = resolveUploadMediaType(
    initialProperties.contentType ?? "",
    blobName,
  );
  const strategy = photoDerivativeStrategy(resolvedContentType);
  if (strategy === "client") {
    throw new PhotoCoverRepairError(
      422,
      "client_thumbnail_required",
      "This format requires client-side thumbnail generation",
    );
  }
  if (strategy !== "server") {
    throw new PhotoCoverRepairError(415, "unsupported_media", "Unsupported photo format");
  }
  if ((initialProperties.contentLength ?? 0) > MAX_REPAIR_SOURCE_BYTES) {
    throw new PhotoCoverRepairError(413, "source_too_large", "Photo is too large to repair");
  }

  const { thumbnailName, previewName } = expectedPhotoDerivativeNames(blobName);
  const thumbnailClient = containerClient.getBlockBlobClient(thumbnailName);
  const previewClient = containerClient.getBlockBlobClient(previewName);
  let [thumbnailExists, previewExists] = await Promise.all([
    thumbnailClient.exists(),
    previewClient.exists(),
  ]);
  const storedThumbnailName = decodeMeta(getMeta(initialProperties.metadata, "thumbnailName"));
  const storedPreviewName = decodeMeta(getMeta(initialProperties.metadata, "previewName"));
  const needsMutation = force
    || !thumbnailExists
    || !previewExists
    || storedThumbnailName !== thumbnailName
    || storedPreviewName !== previewName;

  if (needsMutation) {
    const scope = blobName.split("/").slice(0, 2).join("/");
    const catalogMutation = await beginPhotoCatalogMutation(scope, [blobName]);
    try {
      const regenerateThumbnail = force || !thumbnailExists;
      const regeneratePreview = force || !previewExists;
      if (regenerateThumbnail || regeneratePreview) {
        const sharp = getSharp();
        if (!sharp) {
          throw new PhotoCoverRepairError(
            503,
            "processor_unavailable",
            "Photo processing is unavailable",
          );
        }
        const source = await originalClient.downloadToBuffer();
        if (regenerateThumbnail) {
          let thumbnail: Buffer;
          try {
            thumbnail = await sharp(source)
              .resize({ width: 400, withoutEnlargement: true })
              .webp({ quality: 75 })
              .toBuffer();
          } catch {
            throw new PhotoCoverRepairError(
              422,
              "decode_failed",
              "Photo could not be decoded",
            );
          }
          await renewPhotoCatalogMutation(catalogMutation);
          try {
            await thumbnailClient.uploadData(thumbnail, {
              blobHTTPHeaders: {
                blobContentType: "image/webp",
                blobCacheControl: "private, max-age=3600, immutable",
              },
              metadata: { isThumb: "1" },
            });
          } catch {
            throw new PhotoCoverRepairError(
              502,
              "storage_write_failed",
              "Photo cover could not be stored",
            );
          }
          thumbnailExists = true;
        }
        if (regeneratePreview) {
          let preview: Buffer;
          try {
            preview = await sharp(source)
              .resize({
                width: 2048,
                height: 2048,
                fit: "inside",
                withoutEnlargement: true,
              })
              .webp({ quality: 82 })
              .toBuffer();
          } catch {
            throw new PhotoCoverRepairError(
              422,
              "decode_failed",
              "Photo could not be decoded",
            );
          }
          await renewPhotoCatalogMutation(catalogMutation);
          try {
            await previewClient.uploadData(preview, {
              blobHTTPHeaders: {
                blobContentType: "image/webp",
                blobCacheControl: "private, max-age=3600, immutable",
              },
              metadata: { isThumb: "1" },
            });
          } catch {
            throw new PhotoCoverRepairError(
              502,
              "storage_write_failed",
              "Photo cover could not be stored",
            );
          }
          previewExists = true;
        }
      }

      let metadataUpdated = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const properties = await originalClient.getProperties();
        const metadata: Record<string, string> = { ...(properties.metadata ?? {}) };
        if (getMeta(metadata, "deletedAt")) {
          throw new PhotoCoverRepairError(409, "deleted", "Photo was deleted");
        }
        if (thumbnailExists) setMeta(metadata, "thumbnailName", b64(thumbnailName));
        if (previewExists) setMeta(metadata, "previewName", b64(previewName));
        try {
          if (!properties.etag) throw new Error("Missing photo ETag");
          await renewPhotoCatalogMutation(catalogMutation);
          await originalClient.setMetadata(metadata, {
            conditions: { ifMatch: properties.etag },
          });
          metadataUpdated = true;
          break;
        } catch (error) {
          if (statusCode(error) === 412 && attempt < 3) continue;
          throw error;
        }
      }
      if (!metadataUpdated) {
        throw new PhotoCoverRepairError(
          409,
          "metadata_conflict",
          "Photo changed while repairing its cover",
        );
      }
    } finally {
      try {
        await finishPhotoCatalogMutation(catalogMutation);
      } catch (error) {
        context.error("Photo catalog finalization failed after cover repair:", error);
      }
    }
  }

  const delegationKey = await getUserDelegationKey();
  return {
    thumbnailUrl: generateSasUrlWithKey(thumbnailName, delegationKey),
    previewUrl: generateSasUrlWithKey(previewName, delegationKey),
  };
}

app.http("repairPhotoCover", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/repair-cover",
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
    const blobName = request.query.get("blobName") ?? "";
    if (!blobName) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "blobName required" }),
      };
    }
    if (!await canAccessPhotoPath(blobName, payload, isGroupMember)) {
      return {
        status: 403,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Forbidden" }),
      };
    }

    const force = request.query.get("force") === "1";
    const repairKey = `${blobName}\n${force ? "force" : "missing"}`;
    let repair = inFlightRepairs.get(repairKey);
    if (!repair) {
      const admission = coverRepairAdmission.tryAcquire(
        payload.userId,
        1,
        MAX_REPAIR_SOURCE_BYTES,
      );
      if (!admission.accepted) {
        return {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Retry-After": String(admission.retryAfterSeconds),
          },
          body: JSON.stringify({
            error: "Photo cover repair is busy",
            code: "repair_busy",
          }),
        };
      }
      repair = (async () => {
        try {
          const containerClient = getBlobServiceClient().getContainerClient(containerName);
          return await repairPhotoCover(blobName, force, context, containerClient);
        } finally {
          admission.lease.release();
        }
      })();
      inFlightRepairs.set(repairKey, repair);
    }
    try {
      const result = await repair;
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify(result),
      };
    } catch (error) {
      if (error instanceof PhotoCoverRepairError) {
        if (error.status >= 500) context.error("repairPhotoCover error:", error);
        return {
          status: error.status,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
          body: JSON.stringify({ error: error.message, code: error.code }),
        };
      }
      context.error("repairPhotoCover error:", error);
      return {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({ error: "Internal error", code: "internal_error" }),
      };
    } finally {
      if (inFlightRepairs.get(repairKey) === repair) {
        inFlightRepairs.delete(repairKey);
      }
    }
  },
});
