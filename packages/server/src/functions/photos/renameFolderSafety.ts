import type { ContainerClient } from "@azure/storage-blob";
import { isPhotoFolderPath } from "../../utils/auth/photoAccess";

export type FolderRenamePhase = "copy" | "delete";

export interface FolderRenameErrorDetails {
  phase?: FolderRenamePhase;
  recoveryNeeded?: boolean;
  remainingSources?: string[];
  createdDestinations?: string[];
}

export class FolderRenameError extends Error {
  readonly status: number;
  readonly details: FolderRenameErrorDetails;

  constructor(status: number, message: string, details: FolderRenameErrorDetails = {}) {
    super(message);
    this.name = "FolderRenameError";
    this.status = status;
    this.details = details;
  }
}

export interface FolderRenamePlan {
  oldFolder: string;
  newFolder: string;
  unchanged: boolean;
}

interface RenameContainer {
  listBlobsFlat: ContainerClient["listBlobsFlat"];
  getBlockBlobClient: ContainerClient["getBlockBlobClient"];
}

interface RenameContext {
  error: (...args: unknown[]) => void;
}

interface RenameFolderBlobsOptions {
  container: RenameContainer;
  oldPrefix: string;
  newPrefix: string;
  generateSourceUrl: (blobName: string, abortSignal: AbortSignal) => Promise<string>;
  context: RenameContext;
  copyPhaseTimeoutMs?: number;
  copyPollIntervalMs?: number;
  deleteCriticalSectionTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface SourceBlobSnapshot {
  name: string;
  etag: string;
}

interface CreatedDestination {
  name: string;
  copyId: string | null;
  etag: string | null;
}

interface TaskFailure<T> {
  index: number;
  item: T;
  error: unknown;
}

class CopyTaskError extends Error {
  readonly originalError: unknown;
  readonly uncertainDestinationName: string | null;

  constructor(originalError: unknown, uncertainDestinationName: string | null) {
    super("Folder rename copy task failed");
    this.originalError = originalError;
    this.uncertainDestinationName = uncertainDestinationName;
  }
}

export const FOLDER_RENAME_CONCURRENCY = Object.freeze({
  copy: 4,
  delete: 4,
  rollback: 2,
});

export const FOLDER_RENAME_REQUEST_LIMITS = Object.freeze({
  maxBlobs: 100,
  copyPhaseTimeoutMs: 120_000,
  copyPollIntervalMs: 2_000,
  copyCancelTimeoutMs: 10_000,
  rollbackPhaseTimeoutMs: 60_000,
  deleteCriticalSectionTimeoutMs: 20_000,
  requestTimeoutMs: 210_000,
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function validateFolderPath(value: string, fieldName: string): string {
  const normalized = value.normalize("NFC");
  const segments = value.split("/");
  if (
    value.length === 0
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    || value.includes("\\")
    || CONTROL_CHARACTERS.test(value)
    || !isPhotoFolderPath(normalized)
  ) {
    throw new FolderRenameError(400, `${fieldName} must be a canonical relative folder path`);
  }
  return normalized;
}

export function planFolderRename(oldFolder: string, newFolder: string): FolderRenamePlan {
  const normalizedOldFolder = validateFolderPath(oldFolder, "oldFolder");
  const normalizedNewFolder = validateFolderPath(newFolder, "newFolder");
  if (normalizedOldFolder === normalizedNewFolder) {
    return { oldFolder, newFolder, unchanged: true };
  }

  const oldSegments = oldFolder.split("/");
  const newSegments = newFolder.split("/");
  const oldParent = oldSegments.slice(0, -1).join("/");
  const newParent = newSegments.slice(0, -1).join("/");
  if (oldParent !== newParent || oldSegments.length !== newSegments.length) {
    throw new FolderRenameError(400, "Folder rename may only change the final segment within the same parent");
  }

  return { oldFolder, newFolder, unchanged: false };
}

async function listBlobItems(
  container: RenameContainer,
  prefix: string,
  maxItems: number,
  abortSignal: AbortSignal,
): Promise<Array<{ name: string; etag?: string }>> {
  const items: Array<{ name: string; etag?: string }> = [];
  const pages = container
    .listBlobsFlat({ prefix, abortSignal })
    .byPage({ maxPageSize: maxItems });
  for await (const page of pages) {
    for (const item of page.segment.blobItems) {
      items.push({ name: item.name, etag: item.properties.etag });
      if (items.length >= maxItems) return items;
    }
  }
  return items;
}

function createAbortScope(
  timeoutMs: number,
  timeoutMessage: string,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollCopyToCompletion<TResult>(
  poller: {
    isDone(): boolean;
    poll(options?: { abortSignal?: AbortSignal }): Promise<void>;
    getResult(): TResult | undefined;
  },
  signal: AbortSignal,
  intervalMs: number,
): Promise<TResult> {
  while (!poller.isDone()) {
    if (intervalMs > 0) await delayWithAbort(intervalMs, signal);
    await poller.poll({ abortSignal: signal });
  }
  const result = poller.getResult();
  if (!result) throw new Error("Copy poller completed without a result");
  return result;
}

async function runBoundedFailStop<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<TaskFailure<T>[]> {
  let nextIndex = 0;
  let stopped = false;
  const failures: TaskFailure<T>[] = [];
  const worker = async () => {
    while (!stopped) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      try {
        await task(items[index], index);
      } catch (error) {
        failures.push({ index, item: items[index], error });
        stopped = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return failures.sort((left, right) => left.index - right.index);
}

async function runBoundedAll<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<TaskFailure<T>[]> {
  let nextIndex = 0;
  const failures: TaskFailure<T>[] = [];
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      try {
        await task(items[index], index);
      } catch (error) {
        failures.push({ index, item: items[index], error });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return failures.sort((left, right) => left.index - right.index);
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

async function rollbackCreatedDestinations(
  container: RenameContainer,
  createdDestinations: readonly CreatedDestination[],
  context: RenameContext,
  parentSignal: AbortSignal,
): Promise<string[]> {
  const rollbackScope = createAbortScope(
    FOLDER_RENAME_REQUEST_LIMITS.rollbackPhaseTimeoutMs,
    "Folder rename rollback exceeded its safe HTTP budget",
    parentSignal,
  );
  const rollbackOrder = [...createdDestinations].reverse();
  let failures: TaskFailure<CreatedDestination>[];
  try {
    failures = await runBoundedAll(
      rollbackOrder,
      FOLDER_RENAME_CONCURRENCY.rollback,
      async (destination) => {
        if (!destination.copyId) {
          throw new Error("Copy operation returned no copyId; destination ownership is unknown");
        }
        const destinationBlob = container.getBlockBlobClient(destination.name);
        const properties = await destinationBlob.getProperties({
          abortSignal: rollbackScope.signal,
        });
        if (!properties.etag || properties.copyId !== destination.copyId) {
          throw new Error("Destination no longer belongs to this rename operation");
        }
        await destinationBlob.deleteIfExists({
          abortSignal: rollbackScope.signal,
          conditions: { ifMatch: properties.etag },
        });
      },
    );
  } finally {
    rollbackScope.dispose();
  }
  const failed: string[] = [];
  for (const failure of failures) {
    if (statusCode(failure.error) === 404) continue;
    failed.push(failure.item.name);
    context.error("Folder rename rollback failed", {
      destinationName: failure.item.name,
      error: failure.error,
    });
  }
  return failed;
}

function getCopyId(poller: { getOperationState(): unknown }): string | null {
  const state = poller.getOperationState();
  if (!state || typeof state !== "object" || !("copyId" in state)) return null;
  const copyId = state.copyId;
  return typeof copyId === "string" && copyId.length > 0 ? copyId : null;
}

function inventoriesMatch(
  actual: readonly { name: string; etag?: string }[],
  expected: readonly { name: string; etag: string | null }[],
): boolean {
  if (actual.length !== expected.length) return false;
  const expectedByName = new Map(expected.map((item) => [item.name, item.etag]));
  return actual.every((item) => expectedByName.get(item.name) === item.etag);
}

async function destinationMayExist(
  container: RenameContainer,
  destinationName: string,
  context: RenameContext,
  abortSignal: AbortSignal,
): Promise<boolean> {
  try {
    await container.getBlockBlobClient(destinationName).getProperties({ abortSignal });
    return true;
  } catch (error) {
    if (statusCode(error) === 404) return false;
    context.error("Folder rename could not determine whether copy initiation created a destination", {
      destinationName,
      error,
    });
    return true;
  }
}

async function renameFolderBlobsWithinDeadline({
  container,
  oldPrefix,
  newPrefix,
  generateSourceUrl,
  context,
  copyPhaseTimeoutMs = FOLDER_RENAME_REQUEST_LIMITS.copyPhaseTimeoutMs,
  copyPollIntervalMs = FOLDER_RENAME_REQUEST_LIMITS.copyPollIntervalMs,
  deleteCriticalSectionTimeoutMs = FOLDER_RENAME_REQUEST_LIMITS.deleteCriticalSectionTimeoutMs,
  requestSignal,
}: RenameFolderBlobsOptions & { requestSignal: AbortSignal }): Promise<{ renamed: number }> {
  const sourceItems = await listBlobItems(
    container,
    oldPrefix,
    FOLDER_RENAME_REQUEST_LIMITS.maxBlobs + 1,
    requestSignal,
  );
  const targetItems = await listBlobItems(container, newPrefix, 1, requestSignal);

  if (sourceItems.length === 0) {
    throw new FolderRenameError(404, "Folder not found or already empty");
  }
  if (targetItems.length > 0) {
    throw new FolderRenameError(409, "目标文件夹已存在，无法重命名");
  }
  if (sourceItems.length > FOLDER_RENAME_REQUEST_LIMITS.maxBlobs) {
    throw new FolderRenameError(
      413,
      `文件夹包含 ${sourceItems.length} 个 Blob，超过单次安全重命名上限 ${FOLDER_RENAME_REQUEST_LIMITS.maxBlobs}`,
      {
        phase: "copy",
        recoveryNeeded: false,
        remainingSources: sourceItems.map((item) => item.name),
      },
    );
  }
  const missingSourceEtag = sourceItems.find((item) => !item.etag);
  if (missingSourceEtag) {
    throw new FolderRenameError(500, "无法确认源文件版本，未开始重命名", {
      phase: "copy",
      recoveryNeeded: false,
      remainingSources: sourceItems.map((item) => item.name),
    });
  }
  const sources = sourceItems as SourceBlobSnapshot[];

  const createdDestinations: Array<CreatedDestination | undefined> = new Array(sources.length);
  const copyScope = createAbortScope(
    copyPhaseTimeoutMs,
    "Folder rename copy phase exceeded its safe HTTP budget",
    requestSignal,
  );
  const copyFailures = await runBoundedFailStop(
    sources,
    FOLDER_RENAME_CONCURRENCY.copy,
    async (source, index) => {
      const destinationName = newPrefix + source.name.slice(oldPrefix.length);
      const destinationBlob = container.getBlockBlobClient(destinationName);
      const sourceUrl = await generateSourceUrl(source.name, copyScope.signal);
      let uncertainDestinationName: string | null = destinationName;
      try {
        const copyPoller = await destinationBlob.beginCopyFromURL(sourceUrl, {
          abortSignal: copyScope.signal,
          conditions: { ifNoneMatch: "*" },
          sourceConditions: { ifMatch: source.etag },
        });
        const createdDestination: CreatedDestination = {
          name: destinationName,
          copyId: getCopyId(copyPoller),
          etag: null,
        };
        createdDestinations[index] = createdDestination;
        uncertainDestinationName = null;
        let copyResult;
        try {
          copyResult = await pollCopyToCompletion(
            copyPoller,
            copyScope.signal,
            copyPollIntervalMs,
          );
        } catch (error) {
          if (createdDestination.copyId) {
            const cancelScope = createAbortScope(
              FOLDER_RENAME_REQUEST_LIMITS.copyCancelTimeoutMs,
              "Timed out cancelling Azure copy",
              requestSignal,
            );
            try {
              await destinationBlob.abortCopyFromURL(
                createdDestination.copyId,
                { abortSignal: cancelScope.signal },
              );
            } catch (cancelError) {
              context.error("Folder rename copy cancellation failed", {
                destinationName,
                copyId: createdDestination.copyId,
                error: cancelError,
              });
            } finally {
              cancelScope.dispose();
            }
          }
          throw error;
        }
        if (
          copyResult.copyStatus !== "success"
          || !createdDestination.copyId
          || !copyResult.etag
          || copyResult.copyId !== createdDestination.copyId
        ) {
          throw new Error(`Copy ended with status ${copyResult.copyStatus ?? "unknown"}`);
        }
        createdDestination.etag = copyResult.etag;
      } catch (error) {
        throw new CopyTaskError(error, uncertainDestinationName);
      }
    },
  );
  copyScope.dispose();

  const trackedDestinations = createdDestinations.filter(
    (destination): destination is CreatedDestination => destination !== undefined,
  );
  if (copyFailures.length > 0) {
    const rollbackFailures = await rollbackCreatedDestinations(
      container,
      trackedDestinations,
      context,
      requestSignal,
    );
    const uncertainDestinations: string[] = [];
    for (const failure of copyFailures) {
      const copyError = failure.error instanceof CopyTaskError ? failure.error : null;
      if (
        copyError?.uncertainDestinationName
        && await destinationMayExist(
          container,
          copyError.uncertainDestinationName,
          context,
          requestSignal,
        )
      ) {
        uncertainDestinations.push(copyError.uncertainDestinationName);
      }
    }
    const recoveryDestinations = [
      ...rollbackFailures,
      ...uncertainDestinations,
    ];
    if (recoveryDestinations.length > 0) {
      throw new FolderRenameError(500, "文件夹复制失败且回滚不完整，需要人工恢复", {
        phase: "copy",
        recoveryNeeded: true,
        createdDestinations: recoveryDestinations,
      });
    }
    const firstError = copyFailures[0].error instanceof CopyTaskError
      ? copyFailures[0].error.originalError
      : copyFailures[0].error;
    if (statusCode(firstError) === 412) {
      throw new FolderRenameError(409, "源文件或目标文件在重命名期间发生变化，请刷新后重试", {
        phase: "copy",
        recoveryNeeded: false,
      });
    }
    throw new FolderRenameError(500, "文件夹复制失败，源文件已保留", {
      phase: "copy",
      recoveryNeeded: false,
    });
  }
  const completedDestinations = trackedDestinations;

  const sourceRecheck = await listBlobItems(
    container,
    oldPrefix,
    sources.length + 1,
    requestSignal,
  );
  const targetRecheck = await listBlobItems(
    container,
    newPrefix,
    completedDestinations.length + 1,
    requestSignal,
  );
  const sourceInventoryStable = inventoriesMatch(
    sourceRecheck,
    sources.map((source) => ({ name: source.name, etag: source.etag })),
  );
  const targetInventoryStable = inventoriesMatch(targetRecheck, completedDestinations);
  if (!sourceInventoryStable || !targetInventoryStable) {
    const rollbackFailures = await rollbackCreatedDestinations(
      container,
      completedDestinations,
      context,
      requestSignal,
    );
    if (rollbackFailures.length > 0) {
      throw new FolderRenameError(500, "复制完成后检测到并发修改且回滚不完整，需要人工恢复", {
        phase: "copy",
        recoveryNeeded: true,
        remainingSources: sourceRecheck.map((item) => item.name),
        createdDestinations: rollbackFailures,
      });
    }
    throw new FolderRenameError(409, "文件夹内容在重命名期间发生变化，源文件已保留，请刷新后重试", {
      phase: "copy",
      recoveryNeeded: false,
      remainingSources: sourceRecheck.map((item) => item.name),
    });
  }

  const deleteFailures = await runBoundedFailStop(
    sources,
    FOLDER_RENAME_CONCURRENCY.delete,
    async (source, index) => {
      const destination = completedDestinations[index];
      const destinationBlob = container.getBlockBlobClient(destination.name);
      const leaseClient = destinationBlob.getBlobLeaseClient();
      let leaseAcquired = false;
      let criticalScope: ReturnType<typeof createAbortScope> | null = null;
      try {
        await leaseClient.acquireLease(60, { abortSignal: requestSignal });
        leaseAcquired = true;
        criticalScope = createAbortScope(
          deleteCriticalSectionTimeoutMs,
          "Folder rename source-delete critical section exceeded its lease budget",
          requestSignal,
        );
        const destinationProperties = await destinationBlob.getProperties({
          abortSignal: criticalScope.signal,
        });
        if (
          !destination.copyId
          || !destination.etag
          || destinationProperties.copyId !== destination.copyId
          || destinationProperties.etag !== destination.etag
        ) {
          throw new Error("Destination changed before source deletion");
        }
        const deleted = await container.getBlockBlobClient(source.name).deleteIfExists({
          abortSignal: criticalScope.signal,
          conditions: { ifMatch: source.etag },
        });
        if (!deleted.succeeded) throw new Error("Source blob was not deleted");
      } finally {
        criticalScope?.dispose();
        if (leaseAcquired) {
          try {
            await leaseClient.releaseLease({ abortSignal: requestSignal });
          } catch (error) {
            context.error("Folder rename destination lease release failed", {
              destinationName: destination.name,
              error,
            });
          }
        }
      }
    },
  );
  if (deleteFailures.length > 0) {
    let remainingSources = sources.map((item) => item.name);
    try {
      remainingSources = (await listBlobItems(
        container,
        oldPrefix,
        FOLDER_RENAME_REQUEST_LIMITS.maxBlobs + 1,
        requestSignal,
      )).map((item) => item.name);
    } catch (inventoryError) {
      context.error("Folder rename could not list remaining sources after delete failure", {
        error: inventoryError,
      });
    }
    context.error("Folder rename source deletion failed", {
      failedSources: deleteFailures.map((failure) => failure.item.name),
      remainingSources,
      errors: deleteFailures.map((failure) => failure.error),
    });
    throw new FolderRenameError(500, "文件夹已复制，但部分源文件删除失败；数据仍保留，请刷新后重试或联系管理员", {
      phase: "delete",
      recoveryNeeded: true,
      remainingSources,
      createdDestinations: completedDestinations.map((item) => item.name),
    });
  }

  const remainingSources = await listBlobItems(
    container,
    oldPrefix,
    FOLDER_RENAME_REQUEST_LIMITS.maxBlobs + 1,
    requestSignal,
  );
  const finalTargets = await listBlobItems(
    container,
    newPrefix,
    completedDestinations.length + 1,
    requestSignal,
  );
  if (
    remainingSources.length > 0
    || !inventoriesMatch(finalTargets, completedDestinations)
  ) {
    context.error("Folder rename inventory changed after source deletion", {
      remainingSources: remainingSources.map((item) => item.name),
      finalTargets: finalTargets.map((item) => item.name),
    });
    throw new FolderRenameError(500, "文件夹重命名后检测到并发修改，结果需要对账", {
      phase: "delete",
      recoveryNeeded: true,
      remainingSources: remainingSources.map((item) => item.name),
      createdDestinations: completedDestinations.map((item) => item.name),
    });
  }

  return { renamed: sources.length };
}

export async function renameFolderBlobs(
  options: RenameFolderBlobsOptions,
): Promise<{ renamed: number }> {
  const requestScope = createAbortScope(
    options.requestTimeoutMs ?? FOLDER_RENAME_REQUEST_LIMITS.requestTimeoutMs,
    "Folder rename request exceeded its safe HTTP budget",
  );
  try {
    return await renameFolderBlobsWithinDeadline({
      ...options,
      requestSignal: requestScope.signal,
    });
  } finally {
    requestScope.dispose();
  }
}
