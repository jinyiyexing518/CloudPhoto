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
import {
  createByteBudget,
  isRecoverableImageMime,
  recoveryResultFromError,
  scanPhotoMetadataCandidate,
  type PhotoMetadataRecoveryResult,
} from "./photoMetadataRecovery";

const PAGE_BYTE_BUDGET = 8 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 100_000;

function emptyMetrics(): PhotoMetadataRecoveryResult {
  return {
    candidates: 0,
    estimatedBytes: 0,
    bytesRead: 0,
    recovered: 0,
    cleanedInvalid: 0,
    trulyMissing: 0,
    skippedBudget: 0,
    indexReconciled: 0,
    failed: 0,
    metadataUpdated: 0,
    retryCurrent: 0,
  };
}

function addMetrics(
  totals: PhotoMetadataRecoveryResult,
  current: PhotoMetadataRecoveryResult,
): void {
  for (const key of Object.keys(totals) as Array<keyof PhotoMetadataRecoveryResult>) {
    totals[key] += current[key];
  }
}

function responseBody(
  processed: number,
  metrics: PhotoMetadataRecoveryResult,
  hasMore: boolean,
  cursor: string,
) {
  return {
    processed,
    updated: metrics.metadataUpdated,
    candidates: metrics.candidates,
    estimatedBytes: metrics.estimatedBytes,
    bytesRead: metrics.bytesRead,
    recovered: metrics.recovered,
    cleanedInvalid: metrics.cleanedInvalid,
    trulyMissing: metrics.trulyMissing,
    skippedBudget: metrics.skippedBudget,
    indexReconciled: metrics.indexReconciled,
    failed: metrics.failed,
    hasMore,
    cursor,
  };
}

export async function backfillPhotoMetadataHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
  if (!payload) {
    return {
      status: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  const groupId = request.query.get("groupId") ?? "";
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadline.abort(new Error("Metadata recovery request reached its safe deadline"));
  }, REQUEST_DEADLINE_MS);
  if (groupId && !(await isGroupMember(groupId, payload.userId, deadline.signal))) {
    clearTimeout(deadlineTimer);
    if (deadline.signal.aborted) {
      return {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "5" },
        body: JSON.stringify({ error: "Metadata recovery authorization timed out" }),
      };
    }
    return {
      status: 403,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Not a member" }),
    };
  }
  if (!request.query.has("limit")) {
    clearTimeout(deadlineTimer);
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
  const dryRun = request.query.get("dryRun") === "true";
  const scope = groupId ? `groups/${groupId}` : `personal/${payload.userId}`;
  const cursorContext = `metadata:${scope}`;
  const cursor = decodeBackfillCursor(request.query.get("cursor") ?? "", cursorContext);
  if (!cursor) {
    clearTimeout(deadlineTimer);
    return {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid cursor" }),
    };
  }

  const prefix = `${scope}/`;
  try {
    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    const listing = containerClient.listBlobsFlat({
      prefix,
      includeMetadata: true,
      abortSignal: deadline.signal,
    });
    const budget = createByteBudget(PAGE_BYTE_BUDGET);
    const metrics = emptyMetrics();
    let processed = 0;
    let visited = 0;
    let lastProcessedName = cursor.after;
    let hasMore = false;
    let nextCursor = "";
    const pageStartToken = cursor.token || undefined;

    pages: for await (const page of listing.byPage({
      continuationToken: pageStartToken,
      maxPageSize: BACKFILL_PAGE_SIZE,
    })) {
      for (const blob of page.segment.blobItems) {
        if (cursor.after && blob.name <= cursor.after) continue;
        if (visited >= limit || deadline.signal.aborted) {
          hasMore = true;
          nextCursor = encodeBackfillCursor({
            token: pageStartToken ?? "",
            after: lastProcessedName,
            context: cursorContext,
          });
          break pages;
        }
        visited += 1;

        const filename = blob.name.split("/").pop() ?? "";
        const folder = blob.name.split("/").slice(2, -1).join("/");
        const contentType = blob.properties.contentType ?? "";
        const metadata = { ...(blob.metadata ?? {}) };
        const isDeleted = Object.entries(metadata)
          .some(([key, value]) => key.toLowerCase() === "deletedat" && Boolean(value));
        if (
          filename.startsWith("_th_")
          || folder === "_voice"
          || isDeleted
          || !isRecoverableImageMime(contentType)
        ) {
          lastProcessedName = blob.name;
          continue;
        }

        const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
        const etag = blob.properties.etag;
        const contentLength = blob.properties.contentLength ?? 0;
        try {
          if (!dryRun && !etag) throw new Error("Missing photo ETag");
          const current = await scanPhotoMetadataCandidate({
            name: blob.name,
            contentType,
            contentLength,
            etag: etag ?? "",
            metadata,
            budget,
            dryRun,
            signal: deadline.signal,
            readRange: (offset, count, signal) => blockBlobClient.downloadToBuffer(
              offset,
              count,
              {
                abortSignal: signal,
                conditions: { ifMatch: etag },
              },
            ),
            writeMetadata: async (nextMetadata, sourceEtag, signal) => {
              await blockBlobClient.setMetadata(nextMetadata, {
                abortSignal: signal,
                conditions: { ifMatch: sourceEtag },
              });
            },
            syncLocation: (signal) => syncPhotoLocationFromBlob(
              blockBlobClient,
              blob.name,
              scope,
              signal,
            ),
          });
          if (current.retryCurrent) {
            addMetrics(metrics, {
              ...current,
              candidates: 0,
              estimatedBytes: 0,
            });
            hasMore = true;
            nextCursor = encodeBackfillCursor({
              token: pageStartToken ?? "",
              after: lastProcessedName,
              context: cursorContext,
            });
            break pages;
          }
          addMetrics(metrics, current);
          processed += 1;
          lastProcessedName = blob.name;
        } catch (error) {
          const partial = recoveryResultFromError(error);
          if (partial) addMetrics(metrics, partial);
          if (deadline.signal.aborted) {
            hasMore = true;
            nextCursor = encodeBackfillCursor({
              token: pageStartToken ?? "",
              after: lastProcessedName,
              context: cursorContext,
            });
            break pages;
          }
          metrics.failed += 1;
          processed += 1;
          lastProcessedName = blob.name;
          context.warn(`Backfill failed for ${blob.name}:`, error);
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
      body: JSON.stringify(responseBody(processed, metrics, hasMore, nextCursor)),
    };
  } catch (error) {
    context.error("Backfill error:", error);
    return {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "回填失败" }),
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

app.http("backfillPhotoMetadata", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/backfill",
  handler: backfillPhotoMetadataHandler,
});
