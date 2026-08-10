import type { ContainerClient } from "@azure/storage-blob";

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
  generateSourceUrl: (blobName: string) => Promise<string>;
  context: RenameContext;
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

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function validateFolderPath(value: string, fieldName: string): string {
  const normalized = value.normalize("NFC");
  const segments = value.split("/");
  if (
    value.length === 0
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    || value.includes("\\")
    || CONTROL_CHARACTERS.test(value)
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
): Promise<Array<{ name: string; etag?: string }>> {
  const items: Array<{ name: string; etag?: string }> = [];
  for await (const item of container.listBlobsFlat({ prefix })) {
    items.push({ name: item.name, etag: item.properties.etag });
  }
  return items;
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
): Promise<string[]> {
  const failed: string[] = [];
  for (const destination of [...createdDestinations].reverse()) {
    try {
      if (!destination.copyId) {
        throw new Error("Copy operation returned no copyId; destination ownership is unknown");
      }
      const destinationBlob = container.getBlockBlobClient(destination.name);
      const properties = await destinationBlob.getProperties();
      if (!properties.etag || properties.copyId !== destination.copyId) {
        throw new Error("Destination no longer belongs to this rename operation");
      }
      await destinationBlob.deleteIfExists({
        conditions: { ifMatch: properties.etag },
      });
    } catch (error) {
      if (statusCode(error) === 404) continue;
      failed.push(destination.name);
      context.error("Folder rename rollback failed", {
        destinationName: destination.name,
        error,
      });
    }
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
): Promise<boolean> {
  try {
    await container.getBlockBlobClient(destinationName).getProperties();
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

export async function renameFolderBlobs({
  container,
  oldPrefix,
  newPrefix,
  generateSourceUrl,
  context,
}: RenameFolderBlobsOptions): Promise<{ renamed: number }> {
  const sourceItems = await listBlobItems(container, oldPrefix);
  const targetItems = await listBlobItems(container, newPrefix);

  if (sourceItems.length === 0) {
    throw new FolderRenameError(404, "Folder not found or already empty");
  }
  if (targetItems.length > 0) {
    throw new FolderRenameError(409, "目标文件夹已存在，无法重命名");
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

  const createdDestinations: CreatedDestination[] = [];
  let uncertainDestinationName: string | null = null;
  try {
    for (const source of sources) {
      const destinationName = newPrefix + source.name.slice(oldPrefix.length);
      const destinationBlob = container.getBlockBlobClient(destinationName);
      const sourceUrl = await generateSourceUrl(source.name);
      uncertainDestinationName = destinationName;
      const copyPoller = await destinationBlob.beginCopyFromURL(sourceUrl, {
        conditions: { ifNoneMatch: "*" },
        sourceConditions: { ifMatch: source.etag },
      });
      const createdDestination: CreatedDestination = {
        name: destinationName,
        copyId: getCopyId(copyPoller),
        etag: null,
      };
      createdDestinations.push(createdDestination);
      uncertainDestinationName = null;
      const copyResult = await copyPoller.pollUntilDone();
      if (
        copyResult.copyStatus !== "success"
        || !createdDestination.copyId
        || !copyResult.etag
        || copyResult.copyId !== createdDestination.copyId
      ) {
        throw new Error(`Copy ended with status ${copyResult.copyStatus ?? "unknown"}`);
      }
      createdDestination.etag = copyResult.etag;
    }
  } catch (error) {
    const rollbackFailures = await rollbackCreatedDestinations(
      container,
      createdDestinations,
      context,
    );
    const uncertainDestinationExists = uncertainDestinationName !== null
      && await destinationMayExist(container, uncertainDestinationName, context);
    const recoveryDestinations = [
      ...rollbackFailures,
      ...(uncertainDestinationExists && uncertainDestinationName ? [uncertainDestinationName] : []),
    ];
    if (recoveryDestinations.length > 0) {
      throw new FolderRenameError(500, "文件夹复制失败且回滚不完整，需要人工恢复", {
        phase: "copy",
        recoveryNeeded: true,
        createdDestinations: recoveryDestinations,
      });
    }
    if (statusCode(error) === 412) {
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

  const sourceRecheck = await listBlobItems(container, oldPrefix);
  const targetRecheck = await listBlobItems(container, newPrefix);
  const sourceInventoryStable = inventoriesMatch(
    sourceRecheck,
    sources.map((source) => ({ name: source.name, etag: source.etag })),
  );
  const targetInventoryStable = inventoriesMatch(targetRecheck, createdDestinations);
  if (!sourceInventoryStable || !targetInventoryStable) {
    const rollbackFailures = await rollbackCreatedDestinations(
      container,
      createdDestinations,
      context,
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

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const destination = createdDestinations[index];
    const destinationBlob = container.getBlockBlobClient(destination.name);
    const leaseClient = destinationBlob.getBlobLeaseClient();
    let leaseAcquired = false;
    try {
      await leaseClient.acquireLease(60);
      leaseAcquired = true;
      const destinationProperties = await destinationBlob.getProperties();
      if (
        !destination.copyId
        || !destination.etag
        || destinationProperties.copyId !== destination.copyId
        || destinationProperties.etag !== destination.etag
      ) {
        throw new Error("Destination changed before source deletion");
      }
      const deleted = await container.getBlockBlobClient(source.name).deleteIfExists({
        conditions: { ifMatch: source.etag },
      });
      if (!deleted.succeeded) throw new Error("Source blob was not deleted");
    } catch (error) {
      const remainingSources = sources.slice(index).map((item) => item.name);
      context.error("Folder rename source deletion failed", {
        sourceName: source.name,
        remainingSources,
        error,
      });
      throw new FolderRenameError(500, "文件夹已复制，但部分源文件删除失败；数据仍保留，请刷新后重试或联系管理员", {
        phase: "delete",
        recoveryNeeded: true,
        remainingSources,
        createdDestinations: createdDestinations.map((item) => item.name),
      });
    } finally {
      if (leaseAcquired) {
        try {
          await leaseClient.releaseLease();
        } catch (error) {
          context.error("Folder rename destination lease release failed", {
            destinationName: destination.name,
            error,
          });
        }
      }
    }
  }

  const remainingSources = await listBlobItems(container, oldPrefix);
  const finalTargets = await listBlobItems(container, newPrefix);
  if (
    remainingSources.length > 0
    || !inventoriesMatch(finalTargets, createdDestinations)
  ) {
    context.error("Folder rename inventory changed after source deletion", {
      remainingSources: remainingSources.map((item) => item.name),
      finalTargets: finalTargets.map((item) => item.name),
    });
    throw new FolderRenameError(500, "文件夹重命名后检测到并发修改，结果需要对账", {
      phase: "delete",
      recoveryNeeded: true,
      remainingSources: remainingSources.map((item) => item.name),
      createdDestinations: createdDestinations.map((item) => item.name),
    });
  }

  return { renamed: sources.length };
}
