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

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: number }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function isPreconditionFailed(error: unknown): boolean {
  return getStatusCode(error) === 412;
}

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

      const sourceProps = await sourceBlob.getProperties();
      const sourceEtag = sourceProps.etag;

      // Server-side copy using a short-lived SAS on the source blob
      const sourceSasUrl = await generateSasUrl(name, 1);
      const copyPoller = await destBlob.beginCopyFromURL(sourceSasUrl, {
        sourceConditions: sourceEtag ? { ifMatch: sourceEtag } : undefined,
      });
      await copyPoller.pollUntilDone();

      // Remove the original blob
      try {
        const deleted = await sourceBlob.deleteIfExists({
          conditions: sourceEtag ? { ifMatch: sourceEtag } : undefined,
        });
        if (!deleted.succeeded) {
          return {
            status: 409,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Move conflict detected, please retry" }),
          };
        }
      } catch (e) {
        if (isPreconditionFailed(e)) {
          return {
            status: 409,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Photo changed during move, please retry" }),
          };
        }
        throw e;
      }

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
