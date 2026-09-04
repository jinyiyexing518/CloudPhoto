import { createHash } from "node:crypto";
import { containerName, getBlobServiceClient } from "./blobStorage";

const FENCE_VERSION = 1;
const MAX_FENCE_BYTES = 64 * 1024;

export interface PhotoCatalogFenceMutation {
  id: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface PhotoCatalogFenceState {
  version: typeof FENCE_VERSION;
  updatedAt: string;
  activeMutations: PhotoCatalogFenceMutation[];
  rebuild?: {
    id: string;
    startedAt: string;
    heartbeatAt: string;
  };
  ready?: {
    snapshotId: string;
    revision: number;
  };
}

export interface PhotoCatalogFenceRecord {
  etag: string;
  lastModified: string;
  state: PhotoCatalogFenceState | null;
}

export interface PhotoCatalogFenceStore {
  read(scope: string): Promise<PhotoCatalogFenceRecord | null>;
  write(
    scope: string,
    expectedEtag: string | null,
    state: PhotoCatalogFenceState,
  ): Promise<PhotoCatalogFenceRecord>;
}

function storageStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

function fenceBlobName(scope: string): string {
  const scopeHash = createHash("sha256").update(scope).digest("base64url");
  return `_photo-catalog-fence/${scopeHash}.json`;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseFenceState(value: unknown): PhotoCatalogFenceState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PhotoCatalogFenceState>;
  if (
    candidate.version !== FENCE_VERSION
    || !validDate(candidate.updatedAt)
    || !Array.isArray(candidate.activeMutations)
    || candidate.activeMutations.length > 256
  ) {
    return null;
  }
  const mutationIds = new Set<string>();
  for (const mutation of candidate.activeMutations) {
    if (
      !mutation
      || typeof mutation.id !== "string"
      || !mutation.id
      || mutation.id.length > 256
      || mutationIds.has(mutation.id)
      || !validDate(mutation.startedAt)
      || !validDate(mutation.heartbeatAt)
    ) {
      return null;
    }
    mutationIds.add(mutation.id);
  }
  if (
    candidate.rebuild
    && (
      typeof candidate.rebuild.id !== "string"
      || !candidate.rebuild.id
      || candidate.rebuild.id.length > 256
      || !validDate(candidate.rebuild.startedAt)
      || !validDate(candidate.rebuild.heartbeatAt)
    )
  ) {
    return null;
  }
  if (
    candidate.ready
    && (
      typeof candidate.ready.snapshotId !== "string"
      || !candidate.ready.snapshotId
      || candidate.ready.snapshotId.length > 256
      || !Number.isSafeInteger(candidate.ready.revision)
      || candidate.ready.revision < 0
    )
  ) {
    return null;
  }
  return candidate as PhotoCatalogFenceState;
}

async function readBody(
  stream: NodeJS.ReadableStream | undefined,
): Promise<Buffer | null> {
  if (!stream) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_FENCE_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export const blobPhotoCatalogFenceStore: PhotoCatalogFenceStore = {
  async read(scope) {
    const client = getBlobServiceClient()
      .getContainerClient(containerName)
      .getBlockBlobClient(fenceBlobName(scope));
    try {
      const response = await client.download(0);
      const etag = response.etag ?? "";
      if (!etag) throw new Error(`Photo catalog Blob fence is missing an ETag for ${scope}`);
      const lastModified = response.lastModified?.toISOString() ?? "";
      if (!lastModified) {
        throw new Error(`Photo catalog Blob fence is missing lastModified for ${scope}`);
      }
      const body = await readBody(response.readableStreamBody);
      if (!body) return { etag, lastModified, state: null };
      try {
        return {
          etag,
          lastModified,
          state: parseFenceState(JSON.parse(body.toString("utf8"))),
        };
      } catch {
        return { etag, lastModified, state: null };
      }
    } catch (error) {
      if (storageStatusCode(error) === 404) return null;
      throw error;
    }
  },

  async write(scope, expectedEtag, state) {
    if (!parseFenceState(state)) {
      throw new Error(`Refusing to write an invalid photo catalog Blob fence for ${scope}`);
    }
    const body = Buffer.from(JSON.stringify(state));
    if (body.length > MAX_FENCE_BYTES) {
      throw new Error(`Photo catalog Blob fence exceeds ${MAX_FENCE_BYTES} bytes for ${scope}`);
    }
    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    if (expectedEtag === null) {
      await containerClient.createIfNotExists();
    }
    const client = containerClient.getBlockBlobClient(fenceBlobName(scope));
    const response = await client.uploadData(
      body,
      {
        conditions: expectedEtag
          ? { ifMatch: expectedEtag }
          : { ifNoneMatch: "*" },
        blobHTTPHeaders: {
          blobCacheControl: "no-store",
          blobContentType: "application/json",
        },
      },
    );
    const etag = response.etag ?? "";
    if (!etag) throw new Error(`Photo catalog Blob fence write returned no ETag for ${scope}`);
    return {
      etag,
      lastModified: response.lastModified?.toISOString() ?? state.updatedAt,
      state,
    };
  },
};

export function emptyPhotoCatalogFenceState(now = new Date()): PhotoCatalogFenceState {
  return {
    version: FENCE_VERSION,
    updatedAt: now.toISOString(),
    activeMutations: [],
  };
}
