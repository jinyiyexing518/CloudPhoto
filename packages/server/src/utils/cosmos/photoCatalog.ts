import { createHash, randomUUID } from "node:crypto";
import type { BlobItem } from "@azure/storage-blob";
import type { Container } from "@azure/cosmos";
import { isVoiceMemoPathWithinPhotoScope } from "../auth/photoAccess";
import {
  blobPhotoCatalogFenceStore,
  emptyPhotoCatalogFenceState,
  type PhotoCatalogFenceRecord,
  type PhotoCatalogFenceState,
  type PhotoCatalogFenceStore,
} from "../blob/photoCatalogFence";
import {
  hasGpsMetadataKeys,
  readGpsMetadata,
} from "../photos/gpsCoordinates";
import { getPhotoCatalogContainer } from "./cosmosClient";

export const PHOTO_CATALOG_DOC_TYPE = "photo-catalog";
export const PHOTO_CATALOG_SUMMARY_DOC_TYPE = "photo-catalog-summary";
export const PHOTO_CATALOG_MUTATION_DOC_TYPE = "photo-catalog-mutation";
export const PHOTO_CATALOG_SUMMARY_ID = "catalog:summary:v2";
export const PHOTO_CATALOG_VERSION = 2;
export const DEFAULT_PHOTO_PAGE_SIZE = 24;
export const MAX_PHOTO_PAGE_SIZE = 100;
export const PHOTO_CATALOG_MUTATION_RECOVERY_MS = 10 * 60_000;
export const PHOTO_CATALOG_REBUILD_RECOVERY_MS = 2 * 60_000;
export const PHOTO_CATALOG_MUTATION_HEARTBEAT_MS = 60_000;
export const PHOTO_CATALOG_REBUILD_HEARTBEAT_MS = 20_000;
export const PHOTO_CATALOG_STALE_ROW_CLEANUP_LIMIT = 250;
const PHOTO_CATALOG_FENCE_CLOCK_SKEW_MS = 60_000;
const PHOTO_CATALOG_ROW_WRITE_BATCH_SIZE = 100;

export interface PhotoCatalogDerivativeNames {
  thumbnailName?: string;
  previewName?: string;
}

export interface PhotoCatalogRow {
  id: string;
  docType: typeof PHOTO_CATALOG_DOC_TYPE;
  scope: string;
  snapshotId: string;
  name: string;
  active: boolean;
  sortTimeMs: number;
  sortKey: string;
  sourceBlobEtag: string;
  originalName?: string;
  subject?: string;
  folder?: string;
  groupId?: string;
  thumbnailName?: string;
  previewName?: string;
  size: number;
  lastModified: string;
  contentType: string;
  createdAt?: string;
  createdBy?: string;
  favorite: boolean;
  lastModifiedAt?: string;
  lastModifiedBy?: string;
  voiceMemoName?: string;
  gpsMetadataPresent: boolean;
  gpsLat?: string;
  gpsLon?: string;
  takenAt?: string;
  isAnimated: boolean;
  catalogUpdatedAt: string;
}

export interface PhotoCatalogSummary {
  id: typeof PHOTO_CATALOG_SUMMARY_ID;
  docType: typeof PHOTO_CATALOG_SUMMARY_DOC_TYPE;
  scope: string;
  version: typeof PHOTO_CATALOG_VERSION;
  ready: boolean;
  revision: number;
  total: number;
  rebuiltAt?: string;
  activeSnapshotId?: string;
  rebuildId?: string;
  rebuildStartedAt?: string;
  rebuildHeartbeatAt?: string;
}

export interface PhotoCatalogMutationHandle {
  id: string;
  docType: typeof PHOTO_CATALOG_MUTATION_DOC_TYPE;
  scope: string;
  names: string[];
  startedAt: string;
  blobFenceHeartbeatAt?: string;
}

export interface PhotoCatalogRebuildHandle {
  id: string;
  scope: string;
  revision: number;
  total: number;
  startedAt: string;
  fenceEtag: string;
  blobFenceEtag: string;
  blobFenceHeartbeatAt: string;
  previousSnapshotId?: string;
}

export interface PhotoCatalogCursor {
  scope: string;
  revision: number;
  snapshotId: string;
  after: string;
}

export interface PhotoCatalogPage {
  items: PhotoCatalogRow[];
  nextCursor: string | null;
  done: boolean;
  revision: number;
  total: number;
}

type PhotoCatalogSummaryRecord = PhotoCatalogSummary & {
  _etag?: string;
  _ts?: number;
};

type PendingPhotoCatalogMutation = Pick<
  PhotoCatalogMutationHandle,
  "id" | "startedAt"
> & {
  _ts?: number;
};

export class CatalogNotReadyError extends Error {
  constructor() {
    super("Photo catalog is not ready");
    this.name = "CatalogNotReadyError";
  }
}

export class PhotoCatalogMutationInProgressError extends Error {
  constructor() {
    super("Photo catalog mutation is in progress");
    this.name = "PhotoCatalogMutationInProgressError";
  }
}

export class PhotoCatalogRebuildInProgressError extends Error {
  constructor() {
    super("Photo catalog rebuild is in progress");
    this.name = "PhotoCatalogRebuildInProgressError";
  }
}

export class StalePhotoCatalogMutationError extends Error {
  constructor() {
    super("Photo catalog mutation lease was lost");
    this.name = "StalePhotoCatalogMutationError";
  }
}

export class StalePhotoCatalogRebuildError extends Error {
  constructor() {
    super("Photo catalog rebuild was superseded");
    this.name = "StalePhotoCatalogRebuildError";
  }
}

export class InvalidPhotoCatalogCursorError extends Error {
  constructor() {
    super("Invalid photo catalog cursor");
    this.name = "InvalidPhotoCatalogCursorError";
  }
}

export class StalePhotoCatalogCursorError extends Error {
  constructor() {
    super("Photo catalog changed while paging");
    this.name = "StalePhotoCatalogCursorError";
  }
}

function cosmosStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown; code?: unknown }).statusCode
    ?? (error as { code?: unknown }).code;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function isWriteConflict(error: unknown): boolean {
  return [404, 409, 412].includes(cosmosStatusCode(error) ?? -1);
}

function isRecent(
  value: string,
  now: Date,
  recoveryMs: number,
): boolean {
  const timestamp = canonicalTimestamp(value);
  return timestamp === undefined || now.getTime() - timestamp < recoveryMs;
}

function isBeyondClockSkew(value: string, now: Date): boolean {
  const timestamp = canonicalTimestamp(value);
  return timestamp === undefined
    || timestamp > now.getTime() + PHOTO_CATALOG_FENCE_CLOCK_SKEW_MS;
}

function canonicalTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function cosmosRecordIsExpired(
  serverTimestamp: number | undefined,
  now: Date,
  recoveryMs: number,
): boolean {
  if (
    typeof serverTimestamp !== "number"
    || !Number.isSafeInteger(serverTimestamp)
    || serverTimestamp <= 0
  ) {
    return false;
  }
  return now.getTime() - serverTimestamp * 1000 >= recoveryMs;
}

function photoCatalogRebuildClaimIsRecent(
  summary: PhotoCatalogSummaryRecord,
  now: Date,
): boolean {
  if (!summary.rebuildId) return false;
  const heartbeatAt = summary.rebuildHeartbeatAt ?? summary.rebuildStartedAt;
  if (!heartbeatAt || isBeyondClockSkew(heartbeatAt, now)) {
    return !cosmosRecordIsExpired(
      summary._ts,
      now,
      PHOTO_CATALOG_REBUILD_RECOVERY_MS,
    );
  }
  return isRecent(heartbeatAt, now, PHOTO_CATALOG_REBUILD_RECOVERY_MS)
    || !cosmosRecordIsExpired(
      summary._ts,
      now,
      PHOTO_CATALOG_REBUILD_RECOVERY_MS,
    );
}

function photoCatalogFenceStateIsFuture(
  state: PhotoCatalogFenceState,
  now: Date,
): boolean {
  const futureCutoff = now.getTime() + PHOTO_CATALOG_FENCE_CLOCK_SKEW_MS;
  return [
    state.updatedAt,
    ...state.activeMutations.flatMap((mutation) => [
      mutation.startedAt,
      mutation.heartbeatAt,
    ]),
    ...(state.rebuild
      ? [state.rebuild.startedAt, state.rebuild.heartbeatAt]
      : []),
  ].some((value) => Date.parse(value) > futureCutoff);
}

async function updatePhotoCatalogFence(
  store: PhotoCatalogFenceStore,
  scope: string,
  update: (
    current: PhotoCatalogFenceRecord | null,
  ) => PhotoCatalogFenceState | null,
): Promise<PhotoCatalogFenceRecord | null> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const current = await store.read(scope);
    const now = new Date();
    const malformed = current && (
      !current.state
      || photoCatalogFenceStateIsFuture(current.state, now)
    );
    if (
      malformed
      && isRecent(
        current.lastModified,
        now,
        PHOTO_CATALOG_MUTATION_RECOVERY_MS,
      )
    ) {
      throw new CatalogNotReadyError();
    }
    const normalized = malformed
      ? { ...current, state: emptyPhotoCatalogFenceState(now) }
      : current;
    const next = update(normalized);
    if (!next) return current;
    try {
      return await store.write(scope, current?.etag ?? null, next);
    } catch (error) {
      if (isWriteConflict(error) && attempt < 5) continue;
      throw error;
    }
  }
  throw new Error(`Photo catalog Blob fence did not converge for ${scope}`);
}

async function invalidatePhotoCatalogFenceForMutation(
  store: PhotoCatalogFenceStore,
  handle: PhotoCatalogMutationHandle,
): Promise<PhotoCatalogFenceRecord> {
  const now = new Date();
  const record = await updatePhotoCatalogFence(store, handle.scope, (current) => {
    const base = current?.state ?? emptyPhotoCatalogFenceState(now);
    return {
      version: base.version,
      updatedAt: now.toISOString(),
      activeMutations: [
        ...base.activeMutations.filter((mutation) => mutation.id !== handle.id),
        {
          id: handle.id,
          startedAt: handle.startedAt,
          heartbeatAt: now.toISOString(),
        },
      ],
    };
  });
  if (!record) {
    throw new Error(`Photo catalog mutation fence was not created for ${handle.scope}`);
  }
  handle.blobFenceHeartbeatAt = now.toISOString();
  return record;
}

const mutationFenceRenewals = new WeakMap<
  PhotoCatalogMutationHandle,
  Promise<void>
>();

export async function renewPhotoCatalogMutation(
  handle: PhotoCatalogMutationHandle,
  fenceStore: PhotoCatalogFenceStore = blobPhotoCatalogFenceStore,
  force = false,
): Promise<void> {
  const now = new Date();
  const lastHeartbeat = Date.parse(handle.blobFenceHeartbeatAt ?? "");
  if (
    !force
    && Number.isFinite(lastHeartbeat)
    && now.getTime() - lastHeartbeat < PHOTO_CATALOG_MUTATION_HEARTBEAT_MS
  ) {
    return;
  }
  const pending = mutationFenceRenewals.get(handle);
  if (pending) return pending;
  const renewal = (async () => {
    const heartbeatAt = new Date().toISOString();
    const record = await updatePhotoCatalogFence(
      fenceStore,
      handle.scope,
      (current) => {
        const state = current?.state;
        if (
          !state
          || !state.activeMutations.some((mutation) => mutation.id === handle.id)
        ) {
          throw new StalePhotoCatalogMutationError();
        }
        return {
          version: state.version,
          updatedAt: heartbeatAt,
          activeMutations: state.activeMutations.map((mutation) => (
            mutation.id === handle.id
              ? { ...mutation, heartbeatAt }
              : mutation
          )),
        };
      },
    );
    if (!record) throw new StalePhotoCatalogMutationError();
    handle.blobFenceHeartbeatAt = heartbeatAt;
  })();
  mutationFenceRenewals.set(handle, renewal);
  try {
    await renewal;
  } finally {
    if (mutationFenceRenewals.get(handle) === renewal) {
      mutationFenceRenewals.delete(handle);
    }
  }
}

async function finishPhotoCatalogFenceMutation(
  store: PhotoCatalogFenceStore,
  handle: PhotoCatalogMutationHandle,
): Promise<void> {
  const now = new Date();
  await updatePhotoCatalogFence(store, handle.scope, (current) => {
    const base = current?.state ?? emptyPhotoCatalogFenceState(now);
    return {
      version: base.version,
      updatedAt: now.toISOString(),
      activeMutations: base.activeMutations.filter(
        (mutation) => mutation.id !== handle.id,
      ),
    };
  });
}

async function acquirePhotoCatalogRebuildFence(
  store: PhotoCatalogFenceStore,
  handle: PhotoCatalogRebuildHandle,
  now: Date,
): Promise<PhotoCatalogFenceRecord> {
  const record = await updatePhotoCatalogFence(store, handle.scope, (current) => {
    if (
      current
      && !current.state
      && isRecent(
        current.lastModified,
        now,
        PHOTO_CATALOG_MUTATION_RECOVERY_MS,
      )
    ) {
      throw new CatalogNotReadyError();
    }
    const base = current?.state ?? emptyPhotoCatalogFenceState(now);
    if (
      base.activeMutations.some((mutation) => (
        isRecent(mutation.heartbeatAt, now, PHOTO_CATALOG_MUTATION_RECOVERY_MS)
      ))
    ) {
      throw new PhotoCatalogMutationInProgressError();
    }
    if (
      base.rebuild
      && isRecent(base.rebuild.heartbeatAt, now, PHOTO_CATALOG_REBUILD_RECOVERY_MS)
    ) {
      throw new PhotoCatalogRebuildInProgressError();
    }
    return {
      version: base.version,
      updatedAt: now.toISOString(),
      activeMutations: [],
      rebuild: {
        id: handle.id,
        startedAt: handle.startedAt,
        heartbeatAt: now.toISOString(),
      },
      ...(base.ready ? { ready: base.ready } : {}),
    };
  });
  if (!record) {
    throw new Error(`Photo catalog Blob fence was not acquired for ${handle.scope}`);
  }
  return record;
}

const rebuildFenceRenewals = new WeakMap<
  PhotoCatalogRebuildHandle,
  Promise<void>
>();

export async function renewPhotoCatalogRebuild(
  handle: PhotoCatalogRebuildHandle,
  catalogContainer?: Container,
  fenceStore: PhotoCatalogFenceStore = blobPhotoCatalogFenceStore,
  force = false,
): Promise<void> {
  const now = new Date();
  const lastHeartbeat = Date.parse(handle.blobFenceHeartbeatAt);
  if (
    !force
    && Number.isFinite(lastHeartbeat)
    && now.getTime() - lastHeartbeat < PHOTO_CATALOG_REBUILD_HEARTBEAT_MS
  ) {
    return;
  }
  const pending = rebuildFenceRenewals.get(handle);
  if (pending) return pending;
  const renewal = (async () => {
    const heartbeatAt = new Date().toISOString();
    const container = catalogContainer ?? await getPhotoCatalogContainer();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const current = await readExistingCatalogSummary(container, handle.scope);
      if (
        !current
        || current.ready
        || current.rebuildId !== handle.id
        || current.rebuildStartedAt !== handle.startedAt
        || current.revision !== handle.revision
      ) {
        throw new StalePhotoCatalogRebuildError();
      }
      const etag = current._etag;
      if (!etag) {
        throw new Error(`Photo catalog summary is missing an ETag for ${handle.scope}`);
      }
      const renewedSummary: PhotoCatalogSummary = {
        id: PHOTO_CATALOG_SUMMARY_ID,
        docType: PHOTO_CATALOG_SUMMARY_DOC_TYPE,
        scope: handle.scope,
        version: PHOTO_CATALOG_VERSION,
        ready: false,
        revision: current.revision,
        total: current.total,
        ...(current.activeSnapshotId
          ? { activeSnapshotId: current.activeSnapshotId }
          : {}),
        rebuildId: handle.id,
        rebuildStartedAt: handle.startedAt,
        rebuildHeartbeatAt: heartbeatAt,
      };
      try {
        const response = await container
          .item(PHOTO_CATALOG_SUMMARY_ID, handle.scope)
          .replace(renewedSummary, {
            accessCondition: {
              type: "IfMatch",
              condition: etag,
            },
          });
        handle.fenceEtag = response.etag
          ?? (response.resource as (PhotoCatalogSummary & { _etag?: string }) | undefined)?._etag
          ?? "";
        if (!handle.fenceEtag) {
          throw new Error(
            `Photo catalog rebuild renewal returned no ETag for ${handle.scope}`,
          );
        }
        break;
      } catch (error) {
        if (cosmosStatusCode(error) === 412 && attempt < 3) continue;
        if ([404, 409, 412].includes(cosmosStatusCode(error) ?? -1)) {
          throw new StalePhotoCatalogRebuildError();
        }
        throw error;
      }
    }
    const record = await updatePhotoCatalogFence(
      fenceStore,
      handle.scope,
      (current) => {
        const state = current?.state;
        if (!state || state.rebuild?.id !== handle.id) {
          throw new StalePhotoCatalogRebuildError();
        }
        if (
          state.activeMutations.some((mutation) => (
            isRecent(
              mutation.heartbeatAt,
              new Date(heartbeatAt),
              PHOTO_CATALOG_MUTATION_RECOVERY_MS,
            )
          ))
        ) {
          throw new PhotoCatalogMutationInProgressError();
        }
        return {
          version: state.version,
          updatedAt: heartbeatAt,
          activeMutations: [],
          rebuild: {
            ...state.rebuild,
            heartbeatAt,
          },
          ...(state.ready ? { ready: state.ready } : {}),
        };
      },
    );
    if (!record) throw new StalePhotoCatalogRebuildError();
    handle.blobFenceEtag = record.etag;
    handle.blobFenceHeartbeatAt = heartbeatAt;
  })();
  rebuildFenceRenewals.set(handle, renewal);
  try {
    await renewal;
  } finally {
    if (rebuildFenceRenewals.get(handle) === renewal) {
      rebuildFenceRenewals.delete(handle);
    }
  }
}

async function readReadyPhotoCatalogFence(
  store: PhotoCatalogFenceStore,
  scope: string,
): Promise<PhotoCatalogFenceRecord & {
  state: PhotoCatalogFenceState & {
    ready: NonNullable<PhotoCatalogFenceState["ready"]>;
  };
}> {
  const record = await store.read(scope);
  if (!record?.state) throw new CatalogNotReadyError();
  const now = new Date();
  if (photoCatalogFenceStateIsFuture(record.state, now)) {
    throw new CatalogNotReadyError();
  }
  if (record.state.activeMutations.length > 0) {
    if (
      record.state.activeMutations.some((mutation) => (
        isRecent(mutation.heartbeatAt, now, PHOTO_CATALOG_MUTATION_RECOVERY_MS)
      ))
    ) {
      throw new PhotoCatalogMutationInProgressError();
    }
    throw new CatalogNotReadyError();
  }
  if (record.state.rebuild) {
    if (
      isRecent(
        record.state.rebuild.heartbeatAt,
        now,
        PHOTO_CATALOG_REBUILD_RECOVERY_MS,
      )
    ) {
      throw new PhotoCatalogRebuildInProgressError();
    }
    throw new CatalogNotReadyError();
  }
  if (!record.state.ready) throw new CatalogNotReadyError();
  return record as PhotoCatalogFenceRecord & {
    state: PhotoCatalogFenceState & {
      ready: NonNullable<PhotoCatalogFenceState["ready"]>;
    };
  };
}

async function assertPhotoCatalogFenceUnchanged(
  store: PhotoCatalogFenceStore,
  scope: string,
  expected: PhotoCatalogFenceRecord,
): Promise<void> {
  const current = await store.read(scope);
  if (!current || current.etag !== expected.etag) {
    throw new StalePhotoCatalogCursorError();
  }
}

async function abandonPhotoCatalogBlobRebuild(
  store: PhotoCatalogFenceStore,
  handle: PhotoCatalogRebuildHandle,
): Promise<void> {
  const now = new Date();
  await updatePhotoCatalogFence(store, handle.scope, (current) => {
    const state = current?.state;
    if (!state || state.rebuild?.id !== handle.id) return null;
    return {
      version: state.version,
      updatedAt: now.toISOString(),
      activeMutations: state.activeMutations,
    };
  });
}

function decodeMeta(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return Buffer.from(raw, "base64").toString("utf8") || undefined;
  } catch {
    return raw || undefined;
  }
}

function getMeta(
  metadata: Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

function parseValidTime(value: string | Date | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) && time >= 0 ? time : null;
}

export function photoCatalogRowId(snapshotId: string, name: string): string {
  if (!snapshotId) throw new Error("Photo catalog snapshot ID is required");
  return `catalog:${createHash("sha256").update(`${snapshotId}\0${name}`).digest("base64url")}`;
}

export function photoCatalogSortKey(sortTimeMs: number, name: string): string {
  return `${String(sortTimeMs).padStart(16, "0")}|${Buffer.from(name).toString("base64url")}`;
}

export function photoCatalogBlobCopyIsStable(
  blob: Pick<BlobItem, "properties">,
): boolean {
  if (blob.properties.copyStatus === "pending") {
    throw new PhotoCatalogRebuildInProgressError();
  }
  return !blob.properties.copyStatus || blob.properties.copyStatus === "success";
}

export function buildPhotoCatalogRow(
  blob: Pick<BlobItem, "name" | "properties" | "metadata">,
  scope: string,
  snapshotId: string,
  derivatives: PhotoCatalogDerivativeNames = {},
  now = new Date(),
  location?: {
    gpsLat?: string;
    gpsLon?: string;
    gpsMetadataPresent: boolean;
  },
): PhotoCatalogRow {
  const sourceBlobEtag = blob.properties.etag;
  if (!sourceBlobEtag) {
    throw new Error(`Photo catalog source ETag missing for ${blob.name}`);
  }

  const segments = blob.name.split("/");
  const folderRaw = segments.slice(2, -1).join("/");
  const folder = folderRaw === "_" ? "" : folderRaw;
  const storedVoiceMemoName = getMeta(blob.metadata, "voiceMemoName");
  const voiceMemoName = storedVoiceMemoName
    && isVoiceMemoPathWithinPhotoScope(blob.name, storedVoiceMemoName)
    ? storedVoiceMemoName
    : undefined;
  const takenAt = getMeta(blob.metadata, "takenAt");
  const createdAt = getMeta(blob.metadata, "createdAt");
  const lastModified = blob.properties.lastModified ?? new Date(0);
  const sortTimeMs = parseValidTime(takenAt)
    ?? parseValidTime(createdAt)
    ?? parseValidTime(lastModified)
    ?? 0;
  const gps = readGpsMetadata(blob.metadata);

  return {
    id: photoCatalogRowId(snapshotId, blob.name),
    docType: PHOTO_CATALOG_DOC_TYPE,
    scope,
    snapshotId,
    name: blob.name,
    active: true,
    sortTimeMs,
    sortKey: photoCatalogSortKey(sortTimeMs, blob.name),
    sourceBlobEtag,
    originalName: decodeMeta(getMeta(blob.metadata, "originalName")),
    subject: decodeMeta(getMeta(blob.metadata, "subject")),
    folder,
    groupId: segments[0] === "groups" ? segments[1] : undefined,
    thumbnailName: derivatives.thumbnailName,
    previewName: derivatives.previewName,
    size: blob.properties.contentLength ?? 0,
    lastModified: lastModified.toISOString(),
    contentType: blob.properties.contentType ?? "application/octet-stream",
    createdAt,
    createdBy: decodeMeta(getMeta(blob.metadata, "createdBy")),
    favorite: ["1", "true"].includes(getMeta(blob.metadata, "favorite") ?? ""),
    lastModifiedAt: getMeta(blob.metadata, "lastModifiedAt"),
    lastModifiedBy: decodeMeta(getMeta(blob.metadata, "lastModifiedBy")),
    voiceMemoName,
    gpsMetadataPresent: location?.gpsMetadataPresent ?? hasGpsMetadataKeys(blob.metadata),
    gpsLat: location?.gpsLat ?? gps?.gpsLat,
    gpsLon: location?.gpsLon ?? gps?.gpsLon,
    takenAt,
    isAnimated: getMeta(blob.metadata, "isAnimated") === "1"
      || blob.properties.contentType === "image/gif",
    catalogUpdatedAt: now.toISOString(),
  };
}

export function encodePhotoCatalogCursor(cursor: PhotoCatalogCursor): string {
  return Buffer.from(JSON.stringify({
    v: PHOTO_CATALOG_VERSION,
    s: cursor.scope,
    r: cursor.revision,
    x: cursor.snapshotId,
    a: cursor.after,
  })).toString("base64url");
}

export function decodePhotoCatalogCursor(
  encoded: string,
  expectedScope: string,
  expectedRevision: number,
  expectedSnapshotId: string,
  throwOnRevisionMismatch = false,
): PhotoCatalogCursor | null {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      v?: unknown;
      s?: unknown;
      r?: unknown;
      x?: unknown;
      a?: unknown;
    };
    if (
      value.v !== PHOTO_CATALOG_VERSION
      || value.s !== expectedScope
      || typeof value.r !== "number"
      || !Number.isSafeInteger(value.r)
      || value.r < 0
      || typeof value.x !== "string"
      || !value.x
      || typeof value.a !== "string"
      || !value.a
    ) {
      return null;
    }
    if (
      value.r !== expectedRevision
      || value.x !== expectedSnapshotId
    ) {
      if (throwOnRevisionMismatch) throw new StalePhotoCatalogCursorError();
      return null;
    }
    return {
      scope: value.s,
      revision: value.r,
      snapshotId: value.x,
      after: value.a,
    };
  } catch (error) {
    if (error instanceof StalePhotoCatalogCursorError) throw error;
    return null;
  }
}

async function readCatalogSummary(
  container: Container,
  scope: string,
): Promise<PhotoCatalogSummary> {
  try {
    const { resource } = await container
      .item(PHOTO_CATALOG_SUMMARY_ID, scope)
      .read<PhotoCatalogSummaryRecord>();
    if (
      !resource
      || resource.docType !== PHOTO_CATALOG_SUMMARY_DOC_TYPE
      || resource.scope !== scope
      || resource.version !== PHOTO_CATALOG_VERSION
      || !Number.isSafeInteger(resource.revision)
      || resource.revision < 0
      || !Number.isSafeInteger(resource.total)
      || resource.total < 0
    ) {
      throw new CatalogNotReadyError();
    }
    if (!resource.ready) {
      const now = new Date();
      const rebuildHeartbeatAt = resource.rebuildHeartbeatAt
        ?? resource.rebuildStartedAt;
      const rebuildHeartbeatTimestamp = canonicalTimestamp(rebuildHeartbeatAt);
      if (
        rebuildHeartbeatTimestamp !== undefined
        && !isBeyondClockSkew(rebuildHeartbeatAt ?? "", now)
        && now.getTime() - rebuildHeartbeatTimestamp < PHOTO_CATALOG_REBUILD_RECOVERY_MS
      ) {
        throw new PhotoCatalogRebuildInProgressError();
      }
      throw new CatalogNotReadyError();
    }
    if (
      typeof resource.activeSnapshotId !== "string"
      || !resource.activeSnapshotId
    ) {
      throw new CatalogNotReadyError();
    }
    return resource;
  } catch (error) {
    if (
      error instanceof CatalogNotReadyError
      || error instanceof PhotoCatalogRebuildInProgressError
    ) {
      throw error;
    }
    if (cosmosStatusCode(error) === 404) throw new CatalogNotReadyError();
    throw error;
  }
}

async function readExistingCatalogSummary(
  container: Container,
  scope: string,
): Promise<PhotoCatalogSummaryRecord | null> {
  try {
    const response = await container
      .item(PHOTO_CATALOG_SUMMARY_ID, scope)
      .read<PhotoCatalogSummaryRecord>();
    return response.resource ?? null;
  } catch (error) {
    if (cosmosStatusCode(error) === 404) return null;
    throw error;
  }
}

async function invalidatePhotoCatalogSummary(
  container: Container,
  scope: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = await readExistingCatalogSummary(container, scope);
    const next: PhotoCatalogSummary = {
      id: PHOTO_CATALOG_SUMMARY_ID,
      docType: PHOTO_CATALOG_SUMMARY_DOC_TYPE,
      scope,
      version: PHOTO_CATALOG_VERSION,
      ready: false,
      revision: Math.max(0, current?.revision ?? 0) + 1,
      total: Math.max(0, current?.total ?? 0),
      ...(current?.activeSnapshotId
        ? { activeSnapshotId: current.activeSnapshotId }
        : {}),
      ...(current?.rebuildId && current.rebuildStartedAt
        ? {
            rebuildId: current.rebuildId,
            rebuildStartedAt: current.rebuildStartedAt,
            ...(current.rebuildHeartbeatAt
              ? { rebuildHeartbeatAt: current.rebuildHeartbeatAt }
              : {}),
          }
        : {}),
    };
    try {
      if (current) {
        const etag = current._etag;
        if (!etag) throw new Error(`Photo catalog summary is missing an ETag for ${scope}`);
        await container.item(PHOTO_CATALOG_SUMMARY_ID, scope).replace(next, {
          accessCondition: { type: "IfMatch", condition: etag },
        });
      } else {
        await container.items.create(next);
      }
      return;
    } catch (error) {
      if (
        (cosmosStatusCode(error) === 409 || cosmosStatusCode(error) === 412)
        && attempt < 3
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function listPendingPhotoCatalogMutations(
  container: Container,
  scope: string,
): Promise<PendingPhotoCatalogMutation[]> {
  const { resources } = await container.items
    .query<PendingPhotoCatalogMutation>({
      query: [
        "SELECT c.id, c.startedAt, c._ts FROM c",
        "WHERE c.scope = @scope",
        `AND c.docType = "${PHOTO_CATALOG_MUTATION_DOC_TYPE}"`,
      ].join(" "),
      parameters: [{ name: "@scope", value: scope }],
    }, {
      partitionKey: scope,
    })
    .fetchAll();
  return resources;
}

function recoverablePhotoCatalogMutations(
  mutations: PendingPhotoCatalogMutation[],
  now: Date,
): PendingPhotoCatalogMutation[] {
  const recoveryCutoff = now.getTime() - PHOTO_CATALOG_MUTATION_RECOVERY_MS;
  return mutations.filter((mutation) => {
    const startedAt = canonicalTimestamp(mutation.startedAt);
    if (
      startedAt === undefined
      || startedAt > now.getTime() + PHOTO_CATALOG_FENCE_CLOCK_SKEW_MS
    ) {
      return cosmosRecordIsExpired(
        mutation._ts,
        now,
        PHOTO_CATALOG_MUTATION_RECOVERY_MS,
      );
    }
    return startedAt <= recoveryCutoff && cosmosRecordIsExpired(
      mutation._ts,
      now,
      PHOTO_CATALOG_MUTATION_RECOVERY_MS,
    );
  });
}

async function assertNoActivePhotoCatalogMutation(
  container: Container,
  scope: string,
  now: Date,
): Promise<Array<Pick<PhotoCatalogMutationHandle, "id" | "startedAt">>> {
  const pendingMutations = await listPendingPhotoCatalogMutations(container, scope);
  const recoverableMutations = recoverablePhotoCatalogMutations(pendingMutations, now);
  if (recoverableMutations.length !== pendingMutations.length) {
    throw new PhotoCatalogMutationInProgressError();
  }
  return recoverableMutations;
}

export async function beginPhotoCatalogMutation(
  scope: string,
  names: readonly string[],
  catalogContainer?: Container,
  fenceStore: PhotoCatalogFenceStore = blobPhotoCatalogFenceStore,
): Promise<PhotoCatalogMutationHandle> {
  const container = catalogContainer ?? await getPhotoCatalogContainer();
  const handle: PhotoCatalogMutationHandle = {
    id: `catalog:mutation:${randomUUID()}`,
    docType: PHOTO_CATALOG_MUTATION_DOC_TYPE,
    scope,
    names: [...new Set(names)],
    startedAt: new Date().toISOString(),
  };
  await container.items.create(handle);
  try {
    await invalidatePhotoCatalogSummary(container, scope);
    await invalidatePhotoCatalogFenceForMutation(fenceStore, handle);
  } catch (error) {
    try {
      await container.item(handle.id, scope).delete();
    } catch (cleanupError) {
      if (cosmosStatusCode(cleanupError) !== 404) {
        throw new Error(
          `Photo catalog mutation setup and cleanup both failed for ${scope}: `
          + `${String(error)}; ${String(cleanupError)}`,
        );
      }
    }
    throw error;
  }
  return handle;
}

export async function finishPhotoCatalogMutation(
  handle: PhotoCatalogMutationHandle,
  catalogContainer?: Container,
  fenceStore: PhotoCatalogFenceStore = blobPhotoCatalogFenceStore,
): Promise<void> {
  const container = catalogContainer ?? await getPhotoCatalogContainer();
  await finishPhotoCatalogFenceMutation(fenceStore, handle);
  await invalidatePhotoCatalogSummary(container, handle.scope);
  try {
    await container.item(handle.id, handle.scope).delete();
  } catch (error) {
    if (cosmosStatusCode(error) !== 404) throw error;
  }
}

export async function beginPhotoCatalogRebuild(
  container: Container,
  scope: string,
  startedAt = new Date(),
  fenceStore: PhotoCatalogFenceStore = blobPhotoCatalogFenceStore,
): Promise<PhotoCatalogRebuildHandle> {
  await assertNoActivePhotoCatalogMutation(container, scope, startedAt);
  let handle: PhotoCatalogRebuildHandle | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const existingSummary = await readExistingCatalogSummary(container, scope);
    if (
      existingSummary
      && !existingSummary.ready
      && photoCatalogRebuildClaimIsRecent(existingSummary, startedAt)
    ) {
      throw new PhotoCatalogRebuildInProgressError();
    }

    const candidate: PhotoCatalogRebuildHandle = {
      id: `catalog:rebuild:${randomUUID()}`,
      scope,
      revision: Math.max(0, existingSummary?.revision ?? 0) + 1,
      total: Math.max(0, existingSummary?.total ?? 0),
      startedAt: startedAt.toISOString(),
      fenceEtag: "",
      blobFenceEtag: "",
      blobFenceHeartbeatAt: "",
      ...(existingSummary?.activeSnapshotId
        ? { previousSnapshotId: existingSummary.activeSnapshotId }
        : {}),
    };
    const nextSummary: PhotoCatalogSummary = {
      id: PHOTO_CATALOG_SUMMARY_ID,
      docType: PHOTO_CATALOG_SUMMARY_DOC_TYPE,
      scope,
      version: PHOTO_CATALOG_VERSION,
      ready: false,
      revision: candidate.revision,
      total: candidate.total,
      ...(candidate.previousSnapshotId
        ? { activeSnapshotId: candidate.previousSnapshotId }
        : {}),
      rebuildId: candidate.id,
      rebuildStartedAt: candidate.startedAt,
      rebuildHeartbeatAt: candidate.startedAt,
    };
    try {
      const fence = existingSummary
        ? await container.item(PHOTO_CATALOG_SUMMARY_ID, scope).replace(
            nextSummary,
            {
              accessCondition: {
                type: "IfMatch",
                condition: existingSummary._etag ?? "",
              },
            },
          )
        : await container.items.create(nextSummary);
      candidate.fenceEtag = fence.etag
        ?? (fence.resource as (PhotoCatalogSummary & { _etag?: string }) | undefined)?._etag
        ?? "";
      handle = candidate;
      break;
    } catch (error) {
      if ([404, 409, 412].includes(cosmosStatusCode(error) ?? -1)) {
        if (attempt < 3) continue;
        throw new PhotoCatalogRebuildInProgressError();
      }
      throw error;
    }
  }
  if (!handle) throw new PhotoCatalogRebuildInProgressError();
  if (!handle.fenceEtag) {
    const fenceError = new Error(
      `Photo catalog rebuild fence returned no ETag for ${scope}`,
    );
    try {
      await abandonPhotoCatalogRebuild(container, handle, fenceStore);
    } catch (cleanupError) {
      throw new Error(
        `Photo catalog rebuild setup and cleanup both failed for ${scope}: `
        + `${String(fenceError)}; ${String(cleanupError)}`,
      );
    }
    throw fenceError;
  }
  try {
    const blobFence = await acquirePhotoCatalogRebuildFence(
      fenceStore,
      handle,
      startedAt,
    );
    handle.blobFenceEtag = blobFence.etag;
    handle.blobFenceHeartbeatAt = blobFence.state?.rebuild?.heartbeatAt
      ?? startedAt.toISOString();
  } catch (error) {
    try {
      await abandonPhotoCatalogRebuild(container, handle, fenceStore);
    } catch (cleanupError) {
      throw new Error(
        `Photo catalog rebuild Blob-fence setup and cleanup both failed for ${scope}: `
        + `${String(error)}; ${String(cleanupError)}`,
      );
    }
    throw error;
  }
  try {
    await assertNoActivePhotoCatalogMutation(container, scope, startedAt);
  } catch (error) {
    try {
      await abandonPhotoCatalogRebuild(container, handle, fenceStore);
    } catch (cleanupError) {
      throw new Error(
        `Photo catalog rebuild setup and cleanup both failed for ${scope}: `
        + `${String(error)}; ${String(cleanupError)}`,
      );
    }
    throw error;
  }
  return handle;
}

export async function abandonPhotoCatalogRebuild(
  container: Container,
  handle: PhotoCatalogRebuildHandle,
  fenceStore: PhotoCatalogFenceStore = blobPhotoCatalogFenceStore,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const current = await readExistingCatalogSummary(container, handle.scope);
    if (current?.activeSnapshotId === handle.id) return;
    if (!current || current.rebuildId !== handle.id) break;
    const etag = current._etag;
    if (!etag) {
      throw new Error(`Photo catalog summary is missing an ETag for ${handle.scope}`);
    }
    const abandonedSummary: PhotoCatalogSummary = {
      id: PHOTO_CATALOG_SUMMARY_ID,
      docType: PHOTO_CATALOG_SUMMARY_DOC_TYPE,
      scope: handle.scope,
      version: PHOTO_CATALOG_VERSION,
      ready: false,
      revision: current.revision,
      total: current.total,
      ...(current.activeSnapshotId
        ? { activeSnapshotId: current.activeSnapshotId }
        : {}),
    };
    try {
      await container
        .item(PHOTO_CATALOG_SUMMARY_ID, handle.scope)
        .replace(abandonedSummary, {
          accessCondition: {
            type: "IfMatch",
            condition: etag,
          },
        });
      break;
    } catch (error) {
      if (cosmosStatusCode(error) === 404) break;
      if (cosmosStatusCode(error) === 412 && attempt < 3) continue;
      throw error;
    }
  }
  await abandonPhotoCatalogBlobRebuild(fenceStore, handle);
  await deletePhotoCatalogSnapshot(container, handle.scope, handle.id);
}

async function forEachBounded<T>(
  values: readonly T[],
  operation: (value: T) => Promise<void>,
  concurrency = 12,
): Promise<void> {
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (!failed && nextIndex < values.length) {
        const value = values[nextIndex];
        nextIndex += 1;
        try {
          await operation(value);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) throw firstError;
}

export async function deletePhotoCatalogSnapshot(
  container: Container,
  scope: string,
  snapshotId: string,
): Promise<void> {
  if (!snapshotId) throw new Error("Photo catalog snapshot ID is required");
  const { resources } = await container.items
    .query<Pick<PhotoCatalogRow, "id">>({
      query: [
        "SELECT c.id FROM c",
        "WHERE c.scope = @scope",
        `AND c.docType = "${PHOTO_CATALOG_DOC_TYPE}"`,
        "AND c.snapshotId = @snapshotId",
      ].join(" "),
      parameters: [
        { name: "@scope", value: scope },
        { name: "@snapshotId", value: snapshotId },
      ],
    }, { partitionKey: scope })
    .fetchAll();
  await forEachBounded(resources, async (row) => {
    try {
      await container.item(row.id, scope).delete();
    } catch (error) {
      if (cosmosStatusCode(error) !== 404) throw error;
    }
  });
}

export async function deleteStalePhotoCatalogRows(
  container: Container,
  scope: string,
  maxRows = PHOTO_CATALOG_STALE_ROW_CLEANUP_LIMIT,
  fenceStore: PhotoCatalogFenceStore = blobPhotoCatalogFenceStore,
): Promise<number> {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1_000) {
    throw new Error("Photo catalog stale-row cleanup limit must be between 1 and 1000");
  }

  const blobFence = await readReadyPhotoCatalogFence(fenceStore, scope);
  const summary = await readCatalogSummary(container, scope);
  const activeSnapshotId = summary.activeSnapshotId;
  if (
    !activeSnapshotId
    || blobFence.state.ready.snapshotId !== activeSnapshotId
    || blobFence.state.ready.revision !== summary.revision
  ) {
    throw new StalePhotoCatalogCursorError();
  }

  const { resources } = await container.items
    .query<Pick<PhotoCatalogRow, "id" | "snapshotId">>({
      query: [
        `SELECT TOP ${maxRows} c.id, c.snapshotId FROM c`,
        "WHERE c.scope = @scope",
        `AND c.docType = "${PHOTO_CATALOG_DOC_TYPE}"`,
        "AND c.snapshotId != @activeSnapshotId",
      ].join(" "),
      parameters: [
        { name: "@scope", value: scope },
        { name: "@activeSnapshotId", value: activeSnapshotId },
      ],
    }, { partitionKey: scope })
    .fetchAll();

  if (resources.some((row) => (
    typeof row.id !== "string"
    || !row.id
    || typeof row.snapshotId !== "string"
    || !row.snapshotId
    || row.snapshotId === activeSnapshotId
  ))) {
    throw new Error(`Photo catalog stale-row cleanup returned invalid rows for ${scope}`);
  }

  // A rebuild that started during the query may already have written rows.
  // Refuse deletion unless the ready fence is still the exact snapshot we queried around.
  await assertPhotoCatalogFenceUnchanged(fenceStore, scope, blobFence);
  await forEachBounded(resources, async (row) => {
    try {
      await container.item(row.id, scope).delete();
    } catch (error) {
      if (cosmosStatusCode(error) !== 404) throw error;
    }
  });
  await assertPhotoCatalogFenceUnchanged(fenceStore, scope, blobFence);
  return resources.length;
}

export async function replacePhotoCatalogSnapshot(
  container: Container,
  scope: string,
  rows: readonly PhotoCatalogRow[],
  rebuiltAt = new Date(),
  rebuildHandle?: PhotoCatalogRebuildHandle,
  fenceStore: PhotoCatalogFenceStore = blobPhotoCatalogFenceStore,
): Promise<{ revision: number; total: number }> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      row.scope !== scope
      || row.docType !== PHOTO_CATALOG_DOC_TYPE
      || !row.active
      || !row.snapshotId
      || ids.has(row.id)
    ) {
      throw new Error(`Invalid photo catalog snapshot row: ${row.name}`);
    }
    ids.add(row.id);
  }

  const rebuild = rebuildHandle ?? await beginPhotoCatalogRebuild(
    container,
    scope,
    rebuiltAt,
    fenceStore,
  );
  if (rebuild.scope !== scope) {
    throw new Error(`Photo catalog rebuild scope mismatch: ${rebuild.scope}`);
  }
  for (const row of rows) {
    if (
      row.snapshotId !== rebuild.id
      || row.id !== photoCatalogRowId(rebuild.id, row.name)
    ) {
      throw new Error(`Photo catalog row belongs to another snapshot: ${row.name}`);
    }
  }
  const mutationRecoveryReference = new Date(rebuild.startedAt);
  await assertNoActivePhotoCatalogMutation(
    container,
    scope,
    mutationRecoveryReference,
  );
  await renewPhotoCatalogRebuild(rebuild, container, fenceStore, true);

  for (let index = 0; index < rows.length; index += PHOTO_CATALOG_ROW_WRITE_BATCH_SIZE) {
    await renewPhotoCatalogRebuild(rebuild, container, fenceStore);
    await forEachBounded(
      rows.slice(index, index + PHOTO_CATALOG_ROW_WRITE_BATCH_SIZE),
      async (row) => {
        await container.items.upsert(row);
      },
    );
  }

  const finalRecoverableMutations = await assertNoActivePhotoCatalogMutation(
    container,
    scope,
    mutationRecoveryReference,
  );
  await forEachBounded(finalRecoverableMutations, async (mutation) => {
    try {
      await container.item(mutation.id, scope).delete();
    } catch (error) {
      if (cosmosStatusCode(error) !== 404) throw error;
    }
  });
  await renewPhotoCatalogRebuild(rebuild, container, fenceStore, true);
  const readySummary: PhotoCatalogSummary = {
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: PHOTO_CATALOG_SUMMARY_DOC_TYPE,
    scope,
    version: PHOTO_CATALOG_VERSION,
    ready: true,
    revision: rebuild.revision,
    total: rows.length,
    rebuiltAt: rebuiltAt.toISOString(),
    activeSnapshotId: rebuild.id,
  };
  if (!rebuild.blobFenceEtag) {
    throw new Error(`Photo catalog rebuild is missing its Blob fence for ${scope}`);
  }
  let readyBlobFence: PhotoCatalogFenceRecord;
  try {
    readyBlobFence = await fenceStore.write(
      scope,
      rebuild.blobFenceEtag,
      {
        ...emptyPhotoCatalogFenceState(rebuiltAt),
        ready: {
          snapshotId: rebuild.id,
          revision: rebuild.revision,
        },
      },
    );
  } catch (error) {
    if (isWriteConflict(error)) throw new StalePhotoCatalogRebuildError();
    throw error;
  }
  try {
    await container.item(PHOTO_CATALOG_SUMMARY_ID, scope).replace(readySummary, {
      accessCondition: {
        type: "IfMatch",
        condition: rebuild.fenceEtag,
      },
    });
  } catch (error) {
    const statusCode = cosmosStatusCode(error);
    if (statusCode === 404 || statusCode === 412) {
      try {
        await fenceStore.write(
          scope,
          readyBlobFence.etag,
          emptyPhotoCatalogFenceState(new Date()),
        );
      } catch (cleanupError) {
        if (!isWriteConflict(cleanupError)) {
          throw new Error(
            `Photo catalog publication and Blob-fence rollback both failed for ${scope}: `
            + `${String(error)}; ${String(cleanupError)}`,
          );
        }
      }
      throw new StalePhotoCatalogRebuildError();
    }
    try {
      const current = await readExistingCatalogSummary(container, scope);
      if (
        current?.ready
        && current.revision === rebuild.revision
        && current.activeSnapshotId === rebuild.id
      ) {
        return { revision: rebuild.revision, total: rows.length };
      }
    } catch (readError) {
      throw new Error(
        `Photo catalog publication and read-back both failed for ${scope}: `
        + `${String(error)}; ${String(readError)}`,
      );
    }
    throw error;
  }

  return { revision: rebuild.revision, total: rows.length };
}

export async function listCompletePhotoCatalog(
  container: Container,
  scope: string,
  fenceStore: PhotoCatalogFenceStore = blobPhotoCatalogFenceStore,
): Promise<PhotoCatalogRow[]> {
  const blobFence = await readReadyPhotoCatalogFence(fenceStore, scope);
  const summary = await readCatalogSummary(container, scope);
  const activeSnapshotId = summary.activeSnapshotId;
  if (!activeSnapshotId) throw new CatalogNotReadyError();
  if (
    blobFence.state.ready.snapshotId !== activeSnapshotId
    || blobFence.state.ready.revision !== summary.revision
  ) {
    throw new StalePhotoCatalogCursorError();
  }
  const { resources } = await container.items
    .query<PhotoCatalogRow>({
      query: [
        "SELECT * FROM c",
        "WHERE c.scope = @scope",
        `AND c.docType = "${PHOTO_CATALOG_DOC_TYPE}"`,
        "AND c.snapshotId = @snapshotId",
        "AND c.active = true",
        "ORDER BY c.sortKey DESC",
      ].join(" "),
      parameters: [
        { name: "@scope", value: scope },
        { name: "@snapshotId", value: activeSnapshotId },
      ],
    }, { partitionKey: scope })
    .fetchAll();
  await assertPhotoCatalogFenceUnchanged(fenceStore, scope, blobFence);
  if (
    resources.length !== summary.total
    || resources.some((row) => (
      row.scope !== scope
      || row.docType !== PHOTO_CATALOG_DOC_TYPE
      || row.snapshotId !== activeSnapshotId
      || !row.active
    ))
  ) {
    throw new PhotoCatalogRebuildInProgressError();
  }
  return resources;
}

export async function listPhotoCatalogPage(
  container: Container,
  input: {
    scope: string;
    limit?: number;
    cursor?: string;
  },
  fenceStore: PhotoCatalogFenceStore = blobPhotoCatalogFenceStore,
): Promise<PhotoCatalogPage> {
  const limit = Math.min(
    MAX_PHOTO_PAGE_SIZE,
    Math.max(1, Math.trunc(input.limit ?? DEFAULT_PHOTO_PAGE_SIZE)),
  );
  const blobFence = await readReadyPhotoCatalogFence(fenceStore, input.scope);
  const summary = await readCatalogSummary(container, input.scope);
  const activeSnapshotId = summary.activeSnapshotId;
  if (!activeSnapshotId) throw new CatalogNotReadyError();
  if (
    blobFence.state.ready.snapshotId !== activeSnapshotId
    || blobFence.state.ready.revision !== summary.revision
  ) {
    throw new StalePhotoCatalogCursorError();
  }
  let after = "";
  if (input.cursor) {
    const cursor = decodePhotoCatalogCursor(
      input.cursor,
      input.scope,
      summary.revision,
      activeSnapshotId,
      true,
    );
    if (!cursor) throw new InvalidPhotoCatalogCursorError();
    after = cursor.after;
  }

  const take = limit + 1;
  const { resources } = await container.items
    .query<PhotoCatalogRow>({
      query: [
        "SELECT TOP @take * FROM c",
        "WHERE c.scope = @scope",
        `AND c.docType = "${PHOTO_CATALOG_DOC_TYPE}"`,
        "AND c.snapshotId = @snapshotId",
        "AND c.active = true",
        ...(after ? ["AND c.sortKey < @after"] : []),
        "ORDER BY c.sortKey DESC",
      ].join(" "),
      parameters: [
        { name: "@take", value: take },
        { name: "@scope", value: input.scope },
        { name: "@snapshotId", value: activeSnapshotId },
        ...(after ? [{ name: "@after", value: after }] : []),
      ],
    }, {
      partitionKey: input.scope,
      maxItemCount: take,
    })
    .fetchAll();
  await assertPhotoCatalogFenceUnchanged(fenceStore, input.scope, blobFence);

  const items = resources.slice(0, limit);
  const done = resources.length <= limit;
  const nextCursor = done || items.length === 0
    ? null
    : encodePhotoCatalogCursor({
        scope: input.scope,
        revision: summary.revision,
        snapshotId: activeSnapshotId,
        after: items[items.length - 1].sortKey,
      });

  return {
    items,
    nextCursor,
    done,
    revision: summary.revision,
    total: summary.total,
  };
}
