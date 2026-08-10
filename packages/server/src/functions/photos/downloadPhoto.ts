import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { generateDownloadSasUrl } from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { canAccessPhotoPath, sanitizeDownloadFilename } from "../../utils/auth/photoAccess";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";

app.http("downloadPhoto", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/download",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(
      request.headers.get("authorization") ?? ""
    );
    if (!payload) {
      return {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const blobName = request.query.get("name");
    if (!blobName) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "name required" }),
      };
    }

    if (!await canAccessPhotoPath(blobName, payload, isGroupMember)) {
      return {
        status: 403,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Forbidden" }),
      };
    }

    try {
      const fallbackName = blobName.split("/").pop() ?? "photo";
      const originalName = sanitizeDownloadFilename(
        request.query.get("filename"),
        fallbackName,
      );

      // Generate a short-lived SAS URL that instructs the browser to download
      // the file as an attachment (Content-Disposition: attachment; filename=...).
      // The authenticated path check and client filename avoid an extra Blob read.
      const url = await generateDownloadSasUrl(blobName, originalName, 1);

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, filename: originalName }),
      };
    } catch (error) {
      context.error("Download error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Download failed" }),
      };
    }
  },
});
