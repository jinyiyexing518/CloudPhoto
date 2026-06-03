import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { getPhotoLocationsContainer, isGroupMember } from "../../utils/cosmos/cosmosClient";
import exifr from "exifr";

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/gif",
  "image/webp", "image/heic", "image/heif", "image/bmp", "image/tiff",
]);

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

app.http("backfillPhotoMetadata", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/backfill",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) {
      return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const groupId = request.query.get("groupId") ?? "";
    if (groupId && !(await isGroupMember(groupId, payload.userId))) {
      return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not a member" }) };
    }

    const scope = groupId ? `groups/${groupId}` : `personal/${payload.userId}`;
    const prefix = `${scope}/`;

    try {
      const containerClient = getBlobServiceClient().getContainerClient(containerName);
      let processed = 0, updated = 0, failed = 0;

      for await (const blob of containerClient.listBlobsFlat({ prefix, includeMetadata: true })) {
        // Skip soft-deleted photos
        if (getMeta(blob.metadata, "deletedAt")) continue;

        // Only process image files (not videos/audio)
        const mime = blob.properties.contentType ?? "";
        if (!ALLOWED_IMAGE_MIME.has(mime)) continue;

        const needsTakenAt = !getMeta(blob.metadata, "takenAt");
        const needsGps = !getMeta(blob.metadata, "gpsLat");
        // Skip blobs that already have all available info
        if (!needsTakenAt && !needsGps) continue;

        processed++;
        try {
          const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
          const buf = await blockBlobClient.downloadToBuffer();
          const existing: Record<string, string> = { ...(blob.metadata ?? {}) };
          let changed = false;

          if (needsTakenAt) {
            try {
              const exifData = await exifr.parse(buf, ["DateTimeOriginal", "CreateDate", "DateTime"]);
              const dt: unknown = exifData?.DateTimeOriginal ?? exifData?.CreateDate ?? exifData?.DateTime;
              if (dt instanceof Date && !isNaN(dt.getTime())) {
                // Store as naive datetime (no Z) so clients display in local time
                const pad = (n: number) => String(n).padStart(2, "0");
                existing.takenAt = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
                changed = true;
              }
            } catch {
              // No EXIF datetime — best-effort, continue
            }
          }

          if (needsGps) {
            try {
              const gps = await exifr.gps(buf);
              if (gps?.latitude != null && gps?.longitude != null && isFinite(gps.latitude) && isFinite(gps.longitude)) {
                existing.gpsLat = String(gps.latitude);
                existing.gpsLon = String(gps.longitude);
                changed = true;

                // Upsert Cosmos location record
                try {
                  const locsContainer = await getPhotoLocationsContainer();
                  await locsContainer.items.upsert({
                    id: encodeURIComponent(blob.name),
                    scope,
                    name: blob.name,
                    lat: gps.latitude,
                    lon: gps.longitude,
                    uploadedAt: getMeta(blob.metadata, "createdAt") ?? new Date().toISOString(),
                  });
                } catch {
                  // Cosmos upsert failure is non-fatal
                }
              }
            } catch {
              // No GPS data — best-effort, continue
            }
          }

          if (changed) {
            await blockBlobClient.setMetadata(existing);
            updated++;
          }
        } catch (err) {
          context.warn(`Backfill failed for ${blob.name}:`, err);
          failed++;
        }
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processed, updated, failed }),
      };
    } catch (err) {
      context.error("Backfill error:", err);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "回填失败" }),
      };
    }
  },
});
