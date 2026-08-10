import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import { syncPhotoLocationFromBlob } from "../../utils/cosmos/photoLocationSync";
import {
  BACKFILL_PAGE_SIZE,
  decodeBackfillCursor,
  encodeBackfillCursor,
} from "./backfillCursor";
import exifr from "exifr";
import { reconcileLocationIndex } from "./locationMaintenance";

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/gif",
  "image/webp", "image/heic", "image/heif", "image/bmp", "image/tiff",
]);
const METADATA_SCAN_VERSION = "1";

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

function setMeta(metadata: Record<string, string>, key: string, value: string): void {
  for (const existingKey of Object.keys(metadata)) {
    if (existingKey.toLowerCase() === key.toLowerCase()) delete metadata[existingKey];
  }
  metadata[key] = value;
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
    if (!request.query.has("limit")) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "分页参数 limit 必填，请刷新客户端后重试" }),
      };
    }
    const parsedLimit = Number.parseInt(request.query.get("limit") ?? "30", 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 30;
    const scope = groupId ? `groups/${groupId}` : `personal/${payload.userId}`;
    const cursorContext = `metadata:${scope}`;
    const cursor = decodeBackfillCursor(request.query.get("cursor") ?? "", cursorContext);
    if (!cursor) {
      return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid cursor" }) };
    }

    const prefix = `${scope}/`;

    try {
      const containerClient = getBlobServiceClient().getContainerClient(containerName);
      let processed = 0, updated = 0, indexReconciled = 0, failed = 0;
      let lastProcessedName = "";
      let hasMore = false;
      let nextCursor = "";
      const listing = containerClient.listBlobsFlat({ prefix, includeMetadata: true });
      const pageStartToken = cursor.token || undefined;
      const afterName = cursor.after;

      pages: for await (const page of listing.byPage({
        continuationToken: pageStartToken,
        maxPageSize: BACKFILL_PAGE_SIZE,
      })) {
       for (const blob of page.segment.blobItems) {
        if (afterName && blob.name <= afterName) continue;
        if (processed >= limit) {
          hasMore = true;
          nextCursor = encodeBackfillCursor({
            token: pageStartToken ?? "",
            after: lastProcessedName,
            context: cursorContext,
          });
          break pages;
        }
        const filename = blob.name.split("/").pop() ?? "";
        if (filename.startsWith("_th_")) continue;
        const folder = blob.name.split("/").slice(2, -1).join("/");
        if (folder === "_voice") continue;
        const mime = blob.properties.contentType ?? "";
        const isImage = ALLOWED_IMAGE_MIME.has(mime);
        const isDeleted = Boolean(getMeta(blob.metadata, "deletedAt"));
        const needsTakenAt = !getMeta(blob.metadata, "takenAt");
        const needsGps = !getMeta(blob.metadata, "gpsLat") || !getMeta(blob.metadata, "gpsLon");
        const needsMetadataScan = getMeta(blob.metadata, "metadataScanVersion") !== METADATA_SCAN_VERSION;
        if (isDeleted || !isImage || (!needsTakenAt && !needsGps) || !needsMetadataScan) {
          processed++;
          lastProcessedName = blob.name;
          const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
          const reconciliation = await reconcileLocationIndex({
            metadataChanged: false,
            sync: () => syncPhotoLocationFromBlob(blockBlobClient, blob.name, scope),
          });
          if (reconciliation.indexReconciled) indexReconciled++;
          else {
            failed++;
            context.warn(`photoLocations reconciliation remains pending for ${blob.name}`);
          }
          continue;
        }

        processed++;
        lastProcessedName = blob.name;
        try {
          const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
          const props = await blockBlobClient.getProperties();
          if (!props.etag) throw new Error("Missing photo ETag");
          const buf = await blockBlobClient.downloadToBuffer();
          let extractedTakenAt: string | undefined;
          let extractedGps: { lat: number; lon: number } | undefined;

          if (needsTakenAt) {
            try {
              const exifData = await exifr.parse(buf, ["DateTimeOriginal", "CreateDate", "DateTime"]);
              const dt: unknown = exifData?.DateTimeOriginal ?? exifData?.CreateDate ?? exifData?.DateTime;
              if (dt instanceof Date && !isNaN(dt.getTime())) {
                // Store as naive datetime (no Z) so clients display in local time
                const pad = (n: number) => String(n).padStart(2, "0");
                extractedTakenAt = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
              }
            } catch {
              // No EXIF datetime — best-effort, continue
            }
          }

          if (needsGps) {
            try {
              const gps = await exifr.gps(buf);
              if (gps?.latitude != null && gps?.longitude != null && isFinite(gps.latitude) && isFinite(gps.longitude)) {
                extractedGps = { lat: gps.latitude, lon: gps.longitude };
              }
            } catch {
              // No GPS data — best-effort, continue
            }
          }

          let metadataUpdated = false;
          const latestMetadata: Record<string, string> = { ...(props.metadata ?? {}) };
          if (!getMeta(latestMetadata, "deletedAt")) {

            let changed = false;
            if (extractedTakenAt && !getMeta(latestMetadata, "takenAt")) {
              setMeta(latestMetadata, "takenAt", extractedTakenAt);
              changed = true;
            }
            const needsLatestLat = Boolean(extractedGps && !getMeta(latestMetadata, "gpsLat"));
            const needsLatestLon = Boolean(extractedGps && !getMeta(latestMetadata, "gpsLon"));
            if (extractedGps && needsLatestLat) {
              setMeta(latestMetadata, "gpsLat", String(extractedGps.lat));
              changed = true;
            }
            if (extractedGps && needsLatestLon) {
              setMeta(latestMetadata, "gpsLon", String(extractedGps.lon));
              changed = true;
            }
            if (getMeta(latestMetadata, "metadataScanVersion") !== METADATA_SCAN_VERSION) {
              setMeta(latestMetadata, "metadataScanVersion", METADATA_SCAN_VERSION);
              changed = true;
            }
            if (changed) {
              await blockBlobClient.setMetadata(latestMetadata, {
                conditions: { ifMatch: props.etag },
              });
              metadataUpdated = true;
            }
          }
          if (metadataUpdated) updated++;
          const reconciliation = await reconcileLocationIndex({
            metadataChanged: metadataUpdated,
            sync: () => syncPhotoLocationFromBlob(blockBlobClient, blob.name, scope),
          });
          if (reconciliation.indexReconciled) indexReconciled++;
          else {
            failed++;
            context.warn(`photoLocations reconciliation remains pending for ${blob.name}`);
          }
        } catch (err) {
          context.warn(`Backfill failed for ${blob.name}:`, err);
          failed++;
        }
       }

       if (page.continuationToken) {
         hasMore = true;
         nextCursor = encodeBackfillCursor({
           token: page.continuationToken,
           after: "",
           context: cursorContext,
         });
       }
       break;
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          processed,
          updated,
          indexReconciled,
          failed,
          hasMore,
          ...(hasMore && nextCursor ? { cursor: nextCursor } : {}),
        }),
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
