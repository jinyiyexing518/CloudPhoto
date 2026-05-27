import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName, generateSasUrl } from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { isGroupMember } from "../../utils/cosmosClient";

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
      if (oldFolder === newFolder)
        return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ renamed: 0 }) };

      // Sanitise each segment of the new folder name
      const safeNew = newFolder
        .split("/")
        .map((seg) => seg.replace(/[\\\0<>"|?*:]/g, "_").trim())
        .filter(Boolean)
        .join("/");
      if (!safeNew)
        return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid newFolder" }) };

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

      const oldPrefix = `${scope}/${oldFolder}/`;
      const newPrefix = `${scope}/${safeNew}/`;

      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);

      // Collect all blobs under the old folder prefix
      const blobs: string[] = [];
      for await (const item of containerClient.listBlobsFlat({ prefix: oldPrefix })) {
        blobs.push(item.name);
      }

      if (blobs.length === 0)
        return { status: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Folder not found or already empty" }) };

      // Copy each blob to its new name, then delete the original
      let renamed = 0;
      for (const blobName of blobs) {
        const newBlobName = newPrefix + blobName.slice(oldPrefix.length);
        const sourceBlob = containerClient.getBlockBlobClient(blobName);
        const destBlob = containerClient.getBlockBlobClient(newBlobName);
        const sourceSasUrl = await generateSasUrl(blobName, 1);
        const copyPoller = await destBlob.beginCopyFromURL(sourceSasUrl);
        await copyPoller.pollUntilDone();
        await sourceBlob.deleteIfExists();
        renamed++;
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ renamed, oldFolder, newFolder: safeNew }),
      };
    } catch (error) {
      context.error("Rename folder error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Rename failed" }),
      };
    }
  },
});
