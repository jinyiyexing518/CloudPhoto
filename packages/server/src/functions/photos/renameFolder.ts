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
  planFolderRename,
  renameFolderBlobs,
} from "./renameFolderSafety";
import { syncPhotoLocationFromBlob } from "../../utils/cosmos/photoLocationSync";

async function reconcileRenamedPhotoLocations(
  container: ReturnType<ReturnType<typeof getBlobServiceClient>["getContainerClient"]>,
  oldPrefix: string,
  newPrefix: string,
  scope: string,
  context: InvocationContext,
): Promise<number> {
  let pending = 0;
  for await (const blob of container.listBlobsFlat({ prefix: newPrefix })) {
    const relativeName = blob.name.slice(newPrefix.length);
    const filename = relativeName.split("/").pop() ?? "";
    if (filename.startsWith("_th_") || relativeName.startsWith("_voice/")) continue;
    const oldName = `${oldPrefix}${relativeName}`;
    let reconciled = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await syncPhotoLocationFromBlob(container.getBlockBlobClient(blob.name), blob.name, scope);
        await syncPhotoLocationFromBlob(container.getBlockBlobClient(oldName), oldName, scope);
        reconciled = true;
        break;
      } catch (error) {
        if (attempt === 3) {
          context.warn("Folder rename location reconciliation pending", {
            oldName,
            newName: blob.name,
            error,
          });
        }
      }
    }
    if (!reconciled) pending++;
  }
  return pending;
}

app.http("renameFolder", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "photos/folder",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
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
      });
      const pendingLocationIndexes = await reconcileRenamedPhotoLocations(
        containerClient,
        oldPrefix,
        newPrefix,
        scope,
        context,
      );

      return {
        status: pendingLocationIndexes > 0 ? 500 : 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          renamed: result.renamed,
          oldFolder: plan.oldFolder,
          newFolder: plan.newFolder,
          ...(pendingLocationIndexes > 0 && {
            error: "文件夹已重命名，但部分照片位置索引对账未完成，请联系管理员",
            phase: "location-index",
            recoveryNeeded: true,
            locationIndexPending: true,
            pendingLocationIndexes,
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
