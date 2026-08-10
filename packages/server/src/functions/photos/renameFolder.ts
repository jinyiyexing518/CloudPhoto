import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName, generateSasUrl } from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import {
  FolderRenameError,
  planFolderRename,
  renameFolderBlobs,
} from "./renameFolderSafety";

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

      const result = await renameFolderBlobs({
        container: containerClient,
        oldPrefix,
        newPrefix,
        generateSourceUrl: (blobName) => generateSasUrl(blobName, 2),
        context,
      });

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          renamed: result.renamed,
          oldFolder: plan.oldFolder,
          newFolder: plan.newFolder,
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
