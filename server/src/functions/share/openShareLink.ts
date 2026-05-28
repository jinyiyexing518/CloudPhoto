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
} from "../../utils/blobStorage";
import { getShareLinksContainer, ShareLinkDoc } from "../../utils/cosmosClient";

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

app.http("openShareLink", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/share/open/{linkId}",
  handler: async (
    request: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    const linkId = request.params.linkId;
    if (!linkId) {
      return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "linkId required" }) };
    }

    try {
      const links = await getShareLinksContainer();
      const { resource } = await links.item(linkId, linkId).read<ShareLinkDoc>();
      if (!resource) {
        return { status: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Share link not found" }) };
      }

      const now = Date.now();
      const expired = new Date(resource.expiresAt).getTime() <= now;
      if (resource.status !== "active" || expired) {
        if (expired && resource.status !== "expired") {
          try {
            await links.item(resource.id, resource.id).replace({ ...resource, status: "expired" });
          } catch {
            // Best-effort status refresh.
          }
        }
        return { status: 410, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Share link expired or revoked" }) };
      }

      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const props = await containerClient.getBlobClient(resource.blobName).getProperties();
      if (getMeta(props.metadata, "deletedAt")) {
        return { status: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Photo not found" }) };
      }

      const remainingHours = Math.max(1, Math.ceil((new Date(resource.expiresAt).getTime() - now) / (1000 * 60 * 60)));
      const key = await getUserDelegationKey(Math.min(remainingHours, 24));
      const sasUrl = generateSasUrlWithKey(resource.blobName, key, Math.min(remainingHours, 24));

      const updated: ShareLinkDoc = {
        ...resource,
        viewCount: (resource.viewCount ?? 0) + 1,
        lastViewedAt: new Date().toISOString(),
      };
      await links.item(resource.id, resource.id).replace(updated);

      return {
        status: 302,
        headers: {
          Location: sasUrl,
          "Cache-Control": "no-store",
        },
      };
    } catch (error) {
      context.error("Open share link error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Failed to open share link" }) };
    }
  },
});
