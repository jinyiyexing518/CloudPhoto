import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import {
  isGalleryPhotoPath,
  isPhotoPathWithinScope,
} from "../../utils/auth/photoAccess";
import {
  containerName,
  getBlobServiceClient,
} from "../../utils/blob/blobStorage";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import {
  formatCoordinate,
  hasGpsMetadataKeys,
  readGpsMetadata,
} from "../../utils/photos/gpsCoordinates";
import {
  createByteBudget,
  EmbeddedPhotoGpsBudgetError,
  estimateMetadataScanBytes,
  isRecoverableImageMime,
  readEmbeddedPhotoGps,
} from "./photoMetadataRecovery";
import { resolveUploadMediaType } from "./uploadMediaType";

export const MAX_READ_ONLY_LOCATION_RECOVERY_PHOTOS = 64;
export const READ_ONLY_LOCATION_RECOVERY_BYTE_BUDGET = 8 * 1024 * 1024;
export const READ_ONLY_LOCATION_RECOVERY_TIMEOUT_MS = 2_500;
export const READ_ONLY_LOCATION_RECOVERY_BODY_LIMIT = 96 * 1024;
const RECOVERY_CONCURRENCY = 1;

interface RecoveryCandidate {
  name: string;
  blobEtag: string;
}

interface RecoveryLocation {
  name: string;
  gpsLat: string;
  gpsLon: string;
  sourceBlobEtag: string;
}

interface BlobProperties {
  etag?: string;
  metadata?: Record<string, string>;
  contentType?: string;
  contentLength?: number;
}

interface RecoveryBlobClient {
  getProperties(options: {
    abortSignal?: AbortSignal;
    conditions: { ifMatch: string };
  }): Promise<BlobProperties>;
  downloadToBuffer(
    offset: number,
    count: number,
    options: {
      abortSignal?: AbortSignal;
      conditions: { ifMatch: string };
    },
  ): Promise<Buffer>;
}

interface RecoveryContainerClient {
  getBlockBlobClient(name: string): RecoveryBlobClient;
}

interface RecoveryIdentity {
  userId: string;
  role: string;
}

interface ReadOnlyRecoveryDependencies {
  authenticate?: typeof extractTokenFromHeader;
  checkGroupMembership?: typeof isGroupMember;
  getContainerClient?: () => RecoveryContainerClient;
  timeoutMs?: number;
}

function errorResponse(status: number, error: string): HttpResponseInit {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error }),
  };
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown; code?: unknown }).statusCode
    ?? (error as { code?: unknown }).code;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function parseCandidates(value: unknown): RecoveryCandidate[] | null {
  if (!Array.isArray(value) || value.length > MAX_READ_ONLY_LOCATION_RECOVERY_PHOTOS) {
    return null;
  }
  const candidates: RecoveryCandidate[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { name, blobEtag } = entry as { name?: unknown; blobEtag?: unknown };
    if (
      typeof name !== "string"
      || name.length === 0
      || name.length > 1024
      || typeof blobEtag !== "string"
      || blobEtag.length === 0
      || blobEtag.length > 256
      || names.has(name)
    ) {
      return null;
    }
    names.add(name);
    candidates.push({ name, blobEtag });
  }
  return candidates;
}

function candidateIsAuthorized(
  candidate: RecoveryCandidate,
  identity: RecoveryIdentity,
  groupId: string,
): boolean {
  if (groupId) {
    return isPhotoPathWithinScope(candidate.name, `groups/${groupId}`);
  }
  if (identity.role === "admin") {
    return candidate.name.startsWith("personal/") && isGalleryPhotoPath(candidate.name);
  }
  return isPhotoPathWithinScope(candidate.name, `personal/${identity.userId}`);
}

async function recoverCandidate(
  container: RecoveryContainerClient,
  candidate: RecoveryCandidate,
  budget: ReturnType<typeof createByteBudget>,
  signal: AbortSignal,
): Promise<RecoveryLocation | null> {
  const client = container.getBlockBlobClient(candidate.name);
  const properties = await client.getProperties({
    abortSignal: signal,
    conditions: { ifMatch: candidate.blobEtag },
  });
  if (properties.etag !== candidate.blobEtag) return null;

  const metadata = properties.metadata;
  const metadataGps = readGpsMetadata(metadata);
  if (metadataGps) {
    return {
      name: candidate.name,
      ...metadataGps,
      sourceBlobEtag: candidate.blobEtag,
    };
  }
  if (hasGpsMetadataKeys(metadata)) return null;

  const contentType = resolveUploadMediaType(
    properties.contentType ?? "",
    candidate.name,
  ) ?? "";
  const contentLength = properties.contentLength ?? 0;
  const scanBytes = estimateMetadataScanBytes(contentType, contentLength);
  if (!isRecoverableImageMime(contentType) || scanBytes === 0) {
    return null;
  }
  const embeddedGps = await readEmbeddedPhotoGps({
    name: candidate.name,
    contentType,
    contentLength,
    budget,
    signal,
    readRange: (offset, count, abortSignal) => client.downloadToBuffer(
      offset,
      count,
      {
        abortSignal,
        conditions: { ifMatch: candidate.blobEtag },
      },
    ),
  });
  if (!embeddedGps) return null;
  return {
    name: candidate.name,
    gpsLat: formatCoordinate(embeddedGps.latitude),
    gpsLon: formatCoordinate(embeddedGps.longitude),
    sourceBlobEtag: candidate.blobEtag,
  };
}

export function createReadOnlyPhotoLocationRecoveryHandler({
  authenticate = extractTokenFromHeader,
  checkGroupMembership = isGroupMember,
  getContainerClient = () => getBlobServiceClient()
    .getContainerClient(containerName) as unknown as RecoveryContainerClient,
  timeoutMs = READ_ONLY_LOCATION_RECOVERY_TIMEOUT_MS,
}: ReadOnlyRecoveryDependencies = {}) {
  return async (
    request: HttpRequest,
    context: Pick<InvocationContext, "warn">,
  ): Promise<HttpResponseInit> => {
    const identity = authenticate(request.headers.get("authorization") ?? "");
    if (!identity) return errorResponse(401, "Unauthorized");

    const deadline = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadlinePromise = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        deadline.abort(new Error("Read-only location recovery timed out"));
        resolve();
      }, timeoutMs);
    });

    try {
      const contentLengthHeader = request.headers.get("content-length");
      if (!contentLengthHeader) {
        return errorResponse(411, "Content-Length is required");
      }
      if (!/^\d+$/.test(contentLengthHeader)) {
        return errorResponse(400, "Invalid Content-Length");
      }
      const declaredContentLength = Number(contentLengthHeader);
      if (declaredContentLength > READ_ONLY_LOCATION_RECOVERY_BODY_LIMIT) {
        return errorResponse(413, "Recovery request is too large");
      }

      const groupId = request.query.get("groupId") ?? "";
      if (groupId) {
        const membership = await Promise.race([
          checkGroupMembership(groupId, identity.userId, deadline.signal),
          deadlinePromise.then(() => false),
        ]);
        if (timedOut) {
          return errorResponse(503, "Read-only location recovery timed out");
        }
        if (!membership) {
          return errorResponse(403, "Not a member of this group");
        }
      }

      const bodyResult = await Promise.race([
        request.arrayBuffer().then(
          (body) => {
            const bytes = Buffer.from(body);
            if (bytes.length > READ_ONLY_LOCATION_RECOVERY_BODY_LIMIT) {
              return { ok: false as const, tooLarge: true as const };
            }
            if (bytes.length !== declaredContentLength) {
              return { ok: false as const, lengthMismatch: true as const };
            }
            try {
              return {
                ok: true as const,
                body: JSON.parse(bytes.toString("utf8")) as unknown,
              };
            } catch {
              return { ok: false as const };
            }
          },
          () => ({ ok: false as const }),
        ),
        deadlinePromise.then(() => null),
      ]);
      if (!bodyResult) {
        return errorResponse(503, "Read-only location recovery timed out");
      }
      if (!bodyResult.ok) {
        if ("tooLarge" in bodyResult) {
          return errorResponse(413, "Recovery request is too large");
        }
        if ("lengthMismatch" in bodyResult) {
          return errorResponse(400, "Content-Length does not match request body");
        }
        return errorResponse(400, "Invalid recovery request");
      }
      if (
        !bodyResult.body
        || typeof bodyResult.body !== "object"
        || Array.isArray(bodyResult.body)
      ) {
        return errorResponse(400, "Invalid recovery request");
      }
      const candidates = parseCandidates(
        (bodyResult.body as { photos?: unknown }).photos,
      );
      if (!candidates) {
        return errorResponse(
          400,
          `Recovery accepts at most ${MAX_READ_ONLY_LOCATION_RECOVERY_PHOTOS} unique current photos`,
        );
      }
      if (candidates.some((candidate) => !candidateIsAuthorized(
        candidate,
        identity,
        groupId,
      ))) {
        return errorResponse(403, "Photo is outside the authorized workspace");
      }
      if (candidates.length === 0) {
        return {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          body: JSON.stringify({
            locations: [],
            processed: [],
            bytesRead: 0,
            truncated: false,
          }),
        };
      }

      const budget = createByteBudget(READ_ONLY_LOCATION_RECOVERY_BYTE_BUDGET);
      const container = getContainerClient();
      const locations: Array<RecoveryLocation | undefined> = new Array(candidates.length);
      const completed: boolean[] = new Array(candidates.length).fill(false);
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(RECOVERY_CONCURRENCY, candidates.length) },
        async () => {
          while (!deadline.signal.aborted) {
            const index = cursor;
            cursor += 1;
            if (index >= candidates.length) return;
            let processed = false;
            try {
              locations[index] = await recoverCandidate(
                container,
                candidates[index],
                budget,
                deadline.signal,
              ) ?? undefined;
              processed = true;
            } catch (error) {
              if (
                statusCode(error) === 404
                || statusCode(error) === 412
              ) {
                processed = true;
                continue;
              }
              if (deadline.signal.aborted || error instanceof EmbeddedPhotoGpsBudgetError) {
                continue;
              }
              context.warn(`Read-only location recovery failed for ${candidates[index].name}:`, error);
            } finally {
              if (!deadline.signal.aborted && processed) completed[index] = true;
            }
          }
        },
      );
      const recoveryPromise = Promise.all(workers);
      recoveryPromise.catch((error) => {
        context.warn("Read-only location recovery completed late with an error:", error);
      });

      await Promise.race([
        recoveryPromise,
        deadlinePromise,
      ]);

      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({
          locations: locations.filter(
            (location): location is RecoveryLocation => Boolean(location),
          ),
          processed: candidates
            .filter((_candidate, index) => completed[index])
            .map((candidate) => candidate.name),
          bytesRead: budget.used,
          truncated: timedOut || completed.some((value) => !value),
        }),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

app.http("readOnlyPhotoLocationRecovery", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/locations/recover",
  handler: createReadOnlyPhotoLocationRecoveryHandler(),
});
