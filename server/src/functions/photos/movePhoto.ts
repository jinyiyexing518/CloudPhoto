import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  getBlobServiceClient,
  containerName,
  generateSasUrl,
} from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";

app.http("movePhoto", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/move",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(
      request.headers.get("authorization") ?? ""
    );
    if (!payload)
      return {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };

    try {
      const body = (await request.json()) as {
        name?: string;
        toFolder?: string;
      };
      const { name, toFolder } = body;

      if (!name || toFolder === undefined) {
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "name and toFolder are required" }),
        };
      }

      // Path: {scope}/{ownerId}/{folderPath...}/{filename}  (4+ segments)
      // filename is always the last segment; folderPath can span multiple segments for sub-folders
      const segs = name.split("/");
      if (segs.length < 4) {
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Invalid blob path" }),
        };
      }

      const scope = segs[0];
      const ownerId = segs[1];
      const filename = segs[segs.length - 1]; // last segment is always the file
      // Sanitise each segment of the target folder path (allow "/" as path separator)
      const safeFolderPath = toFolder
        ? toFolder
            .split("/")
            .map((seg) => seg.replace(/[\\\0<>"|?*:]/g, "_").trim())
            .filter(Boolean)
            .join("/")
        : "_";
      const newBlobName = `${scope}/${ownerId}/${safeFolderPath}/${filename}`;

      if (newBlobName === name) {
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newName: name }),
        };
      }

      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      const sourceBlob = containerClient.getBlockBlobClient(name);
      const destBlob = containerClient.getBlockBlobClient(newBlobName);

      // Server-side copy using a short-lived SAS on the source blob
      const sourceSasUrl = generateSasUrl(name, 1);
      const copyPoller = await destBlob.beginCopyFromURL(sourceSasUrl);
      await copyPoller.pollUntilDone();

      // Remove the original blob
      await sourceBlob.deleteIfExists();

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: newBlobName }),
      };
    } catch (error) {
      context.error("Move photo error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Move failed" }),
      };
    }
  },
});
