import {
  app,
  HttpRequest,
  HttpResponseInit,
} from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getShareLinksContainer, ShareLinkDoc } from "../../utils/cosmosClient";

function json(body: unknown, status = 200): HttpResponseInit {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

app.http("listShareLinks", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/share/links",
  handler: async (request: HttpRequest): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return json({ error: "Unauthorized" }, 401);

    const container = await getShareLinksContainer();
    const { resources } = await container.items.query<ShareLinkDoc>({
      query: "SELECT * FROM c WHERE c.createdByUserId = @uid ORDER BY c.createdAt DESC",
      parameters: [{ name: "@uid", value: payload.userId }],
    }).fetchAll();

    const origin = new URL(request.url).origin;
    const withUrl = resources.map((item) => ({
      ...item,
      url: `${origin}/api/photos/share/open/${encodeURIComponent(item.id)}`,
    }));

    return json(withUrl);
  },
});

app.http("updateShareLink", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "photos/share/links/{linkId}",
  handler: async (request: HttpRequest): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return json({ error: "Unauthorized" }, 401);

    const linkId = request.params.linkId;
    if (!linkId) return json({ error: "linkId required" }, 400);

    const body = await request.json().catch(() => ({})) as { action?: "revoke" | "extend"; hours?: number };
    if (!body.action) return json({ error: "action required" }, 400);

    const container = await getShareLinksContainer();
    const { resource } = await container.item(linkId, linkId).read<ShareLinkDoc>();
    if (!resource) return json({ error: "Share link not found" }, 404);
    if (resource.createdByUserId !== payload.userId && payload.role !== "admin") {
      return json({ error: "Forbidden" }, 403);
    }

    const now = Date.now();
    let updated: ShareLinkDoc = resource;

    if (body.action === "revoke") {
      updated = {
        ...resource,
        status: "revoked",
        revokedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      };
    } else {
      if (resource.status !== "active") return json({ error: "Only active links can be extended" }, 400);
      const extendHoursRaw = Number(body.hours ?? 24);
      const extendHours = Number.isFinite(extendHoursRaw)
        ? Math.max(1, Math.min(24 * 30, Math.floor(extendHoursRaw)))
        : 24;
      const baseMs = Math.max(now, new Date(resource.expiresAt).getTime());
      updated = {
        ...resource,
        expiresAt: new Date(baseMs + extendHours * 3600 * 1000).toISOString(),
      };
    }

    await container.item(linkId, linkId).replace(updated);
    return json(updated);
  },
});
