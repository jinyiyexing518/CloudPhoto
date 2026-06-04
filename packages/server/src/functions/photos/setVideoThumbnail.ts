import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  getBlobServiceClient,
  containerName,
  getUserDelegationKey,
  generateSasUrlWithKey,
} from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/**
 * POST /api/photos/set-thumbnail?blobName=xxx
 *
 * Accepts a WebP image body (extracted client-side from a video frame),
 * stores it as the _th_ thumbnail blob, and writes thumbnailName into the
 * original blob's metadata so listPhotos can return a thumbnailUrl.
 *
 * Returns: { thumbnailUrl: string }
 */
app.http("setVideoThumbnail", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/set-thumbnail",
  handler: async (
    request: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) {
      return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const blobName = request.query.get("blobName") ?? "";
    if (!blobName) {
      return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "blobName required" }) };
    }

    try {
      const body = await request.arrayBuffer();
      if (!body.byteLength) {
        return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Empty thumbnail body" }) };
      }

      const containerClient = getBlobServiceClient().getContainerClient(containerName);

      // Derive thumbnail blob name — same pattern used in uploadPhoto and backfillThumbnails
      const lastSlash = blobName.lastIndexOf("/");
      const dir = blobName.substring(0, lastSlash + 1);
      const fname = blobName.substring(lastSlash + 1);
      const thumbnailBlobName = `${dir}_th_${fname}.webp`;

      // Store the thumbnail blob
      const thumbClient = containerClient.getBlockBlobClient(thumbnailBlobName);
      await thumbClient.uploadData(Buffer.from(body), {
        blobHTTPHeaders: { blobContentType: "image/webp" },
        metadata: { isThumb: "1" },
      });

      // Patch the original blob's metadata with thumbnailName (b64-encoded)
      const origClient = containerClient.getBlockBlobClient(blobName);
      const props = await origClient.getProperties();
      await origClient.setMetadata({
        ...(props.metadata ?? {}),
        thumbnailName: b64(thumbnailBlobName),
      });

      // Return a fresh SAS URL so the client can update state immediately
      const delegationKey = await getUserDelegationKey();
      const thumbnailUrl = generateSasUrlWithKey(thumbnailBlobName, delegationKey);

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thumbnailUrl }),
      };
    } catch (err) {
      context.error("setVideoThumbnail error:", err);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Internal error" }) };
    }
  },
});
