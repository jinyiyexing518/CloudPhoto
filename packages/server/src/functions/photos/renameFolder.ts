import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  getBlobServiceClient,
  containerName,
  generateSasUrlWithKey,
  getUserDelegationKey,
} from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import {
  FolderRenameError,
  FOLDER_RENAME_REQUEST_LIMITS,
  planFolderRename,
  renameFolderBlobs,
} from "./renameFolderSafety";
import { syncPhotoLocationFromBlob } from "../../utils/cosmos/photoLocationSync";

const ENDPOINT_BUDGET_MS = 215_000;
const LOCATION_RECONCILE_BUDGET_MS = 8_000;
const LOCATION_RECONCILE_CONCURRENCY = 4;

export interface RenameLocationReconcileResult {
  pending: number;
  inventoryIncomplete: boolean;
}

export async function reconcileRenamedPhotoLocations(
  container: ReturnType<ReturnType<typeof getBlobServiceClient>["getContainerClient"]>,
  oldPrefix: string,
  newPrefix: string,
  scope: string,
  context: InvocationContext,
  timeoutMs = LOCATION_RECONCILE_BUDGET_MS,
  syncLocation: typeof syncPhotoLocationFromBlob = syncPhotoLocationFromBlob,
): Promise<RenameLocationReconcileResult> {
  if (timeoutMs <= 0) return { pending: 0, inventoryIncomplete: true };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Folder location reconciliation timed out", "TimeoutError")),
    timeoutMs,
  );
  const candidates: string[] = [];
  let pending = 0;
  try {
    for await (const blob of container.listBlobsFlat({
      prefix: newPrefix,
      abortSignal: controller.signal,
    })) {
      const relativeName = blob.name.slice(newPrefix.length);
      const filename = relativeName.split("/").pop() ?? "";
      if (!filename.startsWith("_th_") && !relativeName.startsWith("_voice/")) {
        candidates.push(relativeName);
      }
    }

    let cursor = 0;
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = cursor++;
        if (index >= candidates.length) return;
        const relativeName = candidates[index];
        const newName = `${newPrefix}${relativeName}`;
        const oldName = `${oldPrefix}${relativeName}`;
        try {
          await syncLocation(container.getBlockBlobClient(newName), newName, scope, controller.signal);
          await syncLocation(container.getBlockBlobClient(oldName), oldName, scope, controller.signal);
        } catch (error) {
          pending++;
          context.warn("Folder rename location reconciliation pending", {
            oldName,
            newName,
            error,
          });
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(LOCATION_RECONCILE_CONCURRENCY, candidates.length) },
      worker,
    ));
    if (controller.signal.aborted && cursor < candidates.length) {
      pending += candidates.length - cursor;
    }
  } catch (error) {
    pending = Math.max(candidates.length, pending);
    context.warn("Folder rename location reconciliation inventory incomplete", {
      error,
      timedOut: controller.signal.aborted,
      discoveredCandidates: candidates.length,
    });
    return { pending, inventoryIncomplete: true };
  } finally {
    clearTimeout(timeout);
  }
  return { pending, inventoryIncomplete: false };
}

app.http("renameFolder", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "photos/folder",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const endpointDeadline = Date.now() + ENDPOINT_BUDGET_MS;
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload)
      return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };

    try {
      const body = (await request.json()) as {
        oldFolder?: string;
        newFolder?: string;
        groupId?: string;
      };
      const { oldFolder, newFolder, groupId } = body;

      if (!oldFolder || newFolder === undefined || newFolder === null)
        return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "oldFolder and newFolder are required" }) };
      const plan = planFolderRename(oldFolder, newFolder);
      if (plan.unchanged)
        return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ renamed: 0 }) };

      // Determine scope and authorise
      let scope: string;
      if (groupId) {
        const isMember = await isGroupMember(groupId, payload.userId);
        if (!isMember)
          return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not a group member" }) };
        scope = `groups/${groupId}`;
      } else {
        scope = `personal/${payload.userId}`;
      }

      const oldPrefix = `${scope}/${plan.oldFolder}/`;
      const newPrefix = `${scope}/${plan.newFolder}/`;

      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);
      let delegationKeyPromise: ReturnType<typeof getUserDelegationKey> | null = null;

      const result = await renameFolderBlobs({
        container: containerClient,
        oldPrefix,
        newPrefix,
        generateSourceUrl: async (blobName, abortSignal) => {
          delegationKeyPromise ??= getUserDelegationKey(2, { abortSignal });
          return generateSasUrlWithKey(blobName, await delegationKeyPromise, 2);
        },
        context,
        requestTimeoutMs: Math.min(
          FOLDER_RENAME_REQUEST_LIMITS.requestTimeoutMs,
          Math.max(1_000, endpointDeadline - Date.now() - LOCATION_RECONCILE_BUDGET_MS),
        ),
      });
      const reconcileTimeoutMs = Math.min(
        LOCATION_RECONCILE_BUDGET_MS,
        Math.max(0, endpointDeadline - Date.now()),
      );
      const locationReconciliation = await reconcileRenamedPhotoLocations(
        containerClient,
        oldPrefix,
        newPrefix,
        scope,
        context,
        reconcileTimeoutMs,
      );
      const locationIndexPending = locationReconciliation.pending > 0
        || locationReconciliation.inventoryIncomplete;

      return {
        status: locationIndexPending ? 500 : 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          renamed: result.renamed,
          oldFolder: plan.oldFolder,
          newFolder: plan.newFolder,
          ...(locationIndexPending && {
            error: "文件夹已重命名，但部分照片位置索引对账未完成，请联系管理员",
            phase: "location-index",
            recoveryNeeded: true,
            locationIndexPending: true,
            ...(!locationReconciliation.inventoryIncomplete && {
              pendingLocationIndexes: locationReconciliation.pending,
            }),
            ...(locationReconciliation.inventoryIncomplete && {
              locationIndexInventoryIncomplete: true,
            }),
          }),
        }),
      };
    } catch (error) {
      if (error instanceof FolderRenameError) {
        if (error.status >= 500) {
          context.error("Rename folder safety error:", error);
        }
        return {
          status: error.status,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: error.message, ...error.details }),
        };
      }
      context.error("Rename folder error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Rename failed" }),
      };
    }
  },
});
