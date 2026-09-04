import { randomUUID } from "node:crypto";

export interface MoveCopyProperties {
  etag?: string;
  copyId?: string;
  copyStatus?: string;
  metadata?: Record<string, string>;
}

interface MoveCopyPoller {
  isDone(): boolean;
  poll(options?: { abortSignal?: AbortSignal }): Promise<void>;
  getResult(): MoveCopyProperties | undefined;
  getOperationState(): unknown;
}

export interface MoveCopyBlobClient {
  beginCopyFromURL(
    sourceUrl: string,
    options: {
      abortSignal?: AbortSignal;
      conditions: { ifNoneMatch: "*" };
      metadata: Record<string, string>;
      sourceConditions?: { ifMatch: string };
    },
  ): Promise<MoveCopyPoller>;
  getProperties(options?: {
    abortSignal?: AbortSignal;
  }): Promise<MoveCopyProperties>;
  abortCopyFromURL(
    copyId: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
  deleteIfExists(options?: {
    abortSignal?: AbortSignal;
    conditions?: { ifMatch: string };
  }): Promise<{ succeeded: boolean }>;
  getBlobLeaseClient(): {
    acquireLease(
      duration: number,
      options?: { abortSignal?: AbortSignal },
    ): Promise<unknown>;
    releaseLease(options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  };
}

export interface CopyBlobForMoveOptions {
  destinationBlob: MoveCopyBlobClient;
  sourceUrl: string;
  sourceEtag?: string;
  sourceMetadata?: Record<string, string>;
  renewCatalogMutation: () => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  cleanupTimeoutMs?: number;
}

export interface RemoveCompletedMoveDestinationOptions {
  destinationBlob: MoveCopyBlobClient;
  completedCopy: MoveCopyProperties;
  renewCatalogMutation: () => Promise<void>;
  cleanupTimeoutMs?: number;
}

export interface WithVerifiedCompletedMoveDestinationOptions<T> {
  destinationBlob: MoveCopyBlobClient;
  completedCopy: MoveCopyProperties;
  renewCatalogMutation: () => Promise<void>;
  operation: (abortSignal: AbortSignal) => Promise<T>;
  onLeaseReleaseError: (error: unknown) => void;
  criticalSectionTimeoutMs?: number;
  leaseReleaseTimeoutMs?: number;
}

export class MoveDestinationChangedError extends Error {
  constructor() {
    super("Photo move destination changed before source deletion");
    this.name = "MoveDestinationChangedError";
  }
}

const DEFAULT_MOVE_COPY_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MOVE_COPY_POLL_INTERVAL_MS = 500;
const DEFAULT_MOVE_COPY_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_MOVE_DELETE_CRITICAL_SECTION_TIMEOUT_MS = 10_000;
const MOVE_DESTINATION_LEASE_SECONDS = 15;
const MOVE_OPERATION_METADATA_KEY = "cloudphotomoveid";

function storageStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = Reflect.get(error, "statusCode");
  return typeof statusCode === "number" ? statusCode : undefined;
}

function createDeadline(
  timeoutMs: number,
  message: string,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timeout),
  };
}

async function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function pollerCopyId(poller: MoveCopyPoller): string | undefined {
  const state = poller.getOperationState();
  if (!state || typeof state !== "object") return undefined;
  const copyId = Reflect.get(state, "copyId");
  return typeof copyId === "string" && copyId ? copyId : undefined;
}

async function removeOwnedDestination(
  options: CopyBlobForMoveOptions,
  operationId: string,
  expectedCopyId?: string,
): Promise<void> {
  const cleanup = createDeadline(
    options.cleanupTimeoutMs ?? DEFAULT_MOVE_COPY_CLEANUP_TIMEOUT_MS,
    "Photo move copy cleanup timed out",
  );
  try {
    let destination: MoveCopyProperties;
    try {
      destination = await options.destinationBlob.getProperties({
        abortSignal: cleanup.signal,
      });
    } catch (error) {
      if (storageStatusCode(error) === 404) return;
      throw error;
    }
    if (destination.metadata?.[MOVE_OPERATION_METADATA_KEY] !== operationId) {
      throw new Error("Photo move destination is not owned by this operation");
    }
    const copyId = expectedCopyId ?? destination.copyId;
    if (!copyId || destination.copyId !== copyId) {
      throw new Error("Photo move destination is no longer owned by this copy");
    }
    if (destination.copyStatus === "pending") {
      let abortError: unknown;
      try {
        await options.renewCatalogMutation();
        await options.destinationBlob.abortCopyFromURL(copyId, {
          abortSignal: cleanup.signal,
        });
      } catch (error) {
        abortError = error;
      }
      destination = await options.destinationBlob.getProperties({
        abortSignal: cleanup.signal,
      });
      if (
        destination.copyId !== copyId
        || destination.metadata?.[MOVE_OPERATION_METADATA_KEY] !== operationId
        || destination.copyStatus === "pending"
      ) {
        if (abortError) {
          throw new Error(
            `Photo move copy abort did not reach a terminal state: ${String(abortError)}`,
          );
        }
        throw new Error("Photo move copy did not reach a terminal cleanup state");
      }
    }
    if (!["aborted", "failed", "success"].includes(destination.copyStatus ?? "")) {
      throw new Error("Photo move destination reached an unsafe cleanup state");
    }
    if (!destination.etag) {
      throw new Error("Photo move destination is missing an ETag during cleanup");
    }
    await options.renewCatalogMutation();
    const deleted = await options.destinationBlob.deleteIfExists({
      abortSignal: cleanup.signal,
      conditions: { ifMatch: destination.etag },
    });
    if (!deleted.succeeded) {
      throw new Error("Photo move destination cleanup was incomplete");
    }
  } finally {
    cleanup.dispose();
  }
}

export async function withVerifiedCompletedMoveDestination<T>(
  options: WithVerifiedCompletedMoveDestinationOptions<T>,
): Promise<T> {
  const { completedCopy } = options;
  if (
    !completedCopy.copyId
    || completedCopy.copyStatus !== "success"
    || !completedCopy.etag
  ) {
    throw new MoveDestinationChangedError();
  }
  const criticalScope = createDeadline(
    options.criticalSectionTimeoutMs
      ?? DEFAULT_MOVE_DELETE_CRITICAL_SECTION_TIMEOUT_MS,
    "Photo move source-delete critical section timed out",
  );
  const leaseClient = options.destinationBlob.getBlobLeaseClient();
  let leaseAttempted = false;
  try {
    await options.renewCatalogMutation();
    leaseAttempted = true;
    await leaseClient.acquireLease(MOVE_DESTINATION_LEASE_SECONDS, {
      abortSignal: criticalScope.signal,
    });
    const destination = await options.destinationBlob.getProperties({
      abortSignal: criticalScope.signal,
    });
    if (
      destination.copyId !== completedCopy.copyId
      || destination.copyStatus !== "success"
      || destination.etag !== completedCopy.etag
    ) {
      throw new MoveDestinationChangedError();
    }
    return await options.operation(criticalScope.signal);
  } finally {
    criticalScope.dispose();
    if (leaseAttempted) {
      const releaseScope = createDeadline(
        options.leaseReleaseTimeoutMs ?? DEFAULT_MOVE_COPY_CLEANUP_TIMEOUT_MS,
        "Photo move destination lease release timed out",
      );
      try {
        await options.renewCatalogMutation();
        await leaseClient.releaseLease({ abortSignal: releaseScope.signal });
      } catch (error) {
        options.onLeaseReleaseError(error);
      } finally {
        releaseScope.dispose();
      }
    }
  }
}

export async function removeCompletedMoveDestination(
  options: RemoveCompletedMoveDestinationOptions,
): Promise<void> {
  const { completedCopy } = options;
  if (
    !completedCopy.copyId
    || completedCopy.copyStatus !== "success"
    || !completedCopy.etag
  ) {
    throw new Error("Photo move completed copy identity is incomplete");
  }
  const cleanup = createDeadline(
    options.cleanupTimeoutMs ?? DEFAULT_MOVE_COPY_CLEANUP_TIMEOUT_MS,
    "Photo move destination cleanup timed out",
  );
  try {
    let destination: MoveCopyProperties;
    try {
      destination = await options.destinationBlob.getProperties({
        abortSignal: cleanup.signal,
      });
    } catch (error) {
      if (storageStatusCode(error) === 404) return;
      throw error;
    }
    if (
      destination.copyId !== completedCopy.copyId
      || destination.copyStatus !== "success"
      || destination.etag !== completedCopy.etag
    ) {
      throw new Error("Photo move destination changed before conflict cleanup");
    }
    await options.renewCatalogMutation();
    const deleted = await options.destinationBlob.deleteIfExists({
      abortSignal: cleanup.signal,
      conditions: { ifMatch: completedCopy.etag },
    });
    if (!deleted.succeeded) {
      throw new Error("Photo move destination conflict cleanup was incomplete");
    }
  } finally {
    cleanup.dispose();
  }
}

export async function copyBlobForMove(
  options: CopyBlobForMoveOptions,
): Promise<MoveCopyProperties> {
  const deadline = createDeadline(
    options.timeoutMs ?? DEFAULT_MOVE_COPY_TIMEOUT_MS,
    "Photo move copy timed out",
  );
  const operationId = randomUUID();
  let copyId: string | undefined;
  try {
    await options.renewCatalogMutation();
    const poller = await options.destinationBlob.beginCopyFromURL(
      options.sourceUrl,
      {
        abortSignal: deadline.signal,
        conditions: { ifNoneMatch: "*" },
        metadata: {
          ...options.sourceMetadata,
          [MOVE_OPERATION_METADATA_KEY]: operationId,
        },
        sourceConditions: options.sourceEtag
          ? { ifMatch: options.sourceEtag }
          : undefined,
      },
    );
    copyId = pollerCopyId(poller);
    if (!copyId) {
      throw new Error("Photo move copy returned no operation ID");
    }

    while (!poller.isDone()) {
      await delayWithAbort(
        options.pollIntervalMs ?? DEFAULT_MOVE_COPY_POLL_INTERVAL_MS,
        deadline.signal,
      );
      await options.renewCatalogMutation();
      await poller.poll({ abortSignal: deadline.signal });
    }
    const result = poller.getResult();
    if (
      !result
      || result.copyId !== copyId
      || result.copyStatus !== "success"
      || !result.etag
    ) {
      throw new Error(`Photo move copy failed: ${result?.copyStatus ?? "unknown"}`);
    }
    return result;
  } catch (error) {
    try {
      await removeOwnedDestination(options, operationId, copyId);
    } catch (cleanupError) {
      if (!copyId && storageStatusCode(error) === 412) {
        throw error;
      }
      if (copyId || storageStatusCode(error) !== 412) {
        throw new Error(
          `Photo move copy and cleanup both failed: ${String(error)}; ${String(cleanupError)}`,
        );
      }
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}
