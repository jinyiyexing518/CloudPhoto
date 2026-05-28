import {
  app,
  HttpRequest,
  HttpResponseInit,
} from "@azure/functions";
import { Container } from "@azure/cosmos";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getShareLinksContainer, ShareLinkDoc } from "../../utils/cosmosClient";

type ShareLinkDocWithEtag = ShareLinkDoc & { _etag?: string };

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const maybeStatus = (error as { statusCode?: number }).statusCode;
  if (typeof maybeStatus === "number") return maybeStatus;
  const maybeCode = (error as { code?: number | string }).code;
  if (typeof maybeCode === "number") return maybeCode;
  return undefined;
}

function isConcurrentConflict(error: unknown): boolean {
  const statusCode = getStatusCode(error);
  return statusCode === 409 || statusCode === 412;
}

function isCosmosAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const statusCode = getStatusCode(error);
  if (statusCode === 401 || statusCode === 403 || statusCode === 404) return true;
  const message = (error as { message?: string }).message ?? "";
  return /Request blocked by Auth|cosmos-native-rbac|cannot be authorized by AAD token|Authorization|NotFound|Owner resource does not exist|sharelinks/i.test(message);
}

async function mutateShareLinkWithRetry(
  container: Container,
  linkId: string,
  canAccess: (doc: ShareLinkDoc) => boolean,
  mutate: (doc: ShareLinkDocWithEtag, now: number) => { ok: true; updated: ShareLinkDoc } | { ok: false; response: HttpResponseInit },
): Promise<{ ok: true; updated: ShareLinkDoc } | { ok: false; response: HttpResponseInit }> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { resource } = await container.item(linkId, linkId).read<ShareLinkDocWithEtag>();
    if (!resource) return { ok: false, response: json({ error: "Share link not found" }, 404) };
    if (!canAccess(resource)) return { ok: false, response: json({ error: "Forbidden" }, 403) };

    const result = mutate(resource, Date.now());
    if (!result.ok) return result;

    try {
      const replaceOptions = resource._etag
        ? {
          accessCondition: {
            type: "IfMatch" as const,
            condition: resource._etag,
          },
        }
        : undefined;
      const response = await container.item(linkId, linkId).replace(result.updated, replaceOptions);
      return { ok: true, updated: (response.resource as ShareLinkDoc | undefined) ?? result.updated };
    } catch (e) {
      if (isConcurrentConflict(e) && attempt < maxAttempts) continue;
      if (isConcurrentConflict(e)) {
        return { ok: false, response: json({ error: "Share link was modified concurrently, please retry" }, 409) };
      }
      throw e;
    }
  }

  return { ok: false, response: json({ error: "Share link update failed" }, 500) };
}

function json(body: unknown, status = 200): HttpResponseInit {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function resolvePublicBaseUrl(request: HttpRequest): string {
  // Use explicit share URL base only when configured.
  const shareBase = process.env.SHARE_PUBLIC_BASE_URL?.trim();
  if (shareBase) return normalizeBaseUrl(shareBase);

  // Default to current API origin to avoid frontend-auth interception.
  return normalizeBaseUrl(new URL(request.url).origin);
}

app.http("listShareLinks", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/share/links",
  handler: async (request: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
      if (!payload) return json({ error: "Unauthorized" }, 401);

      const container = await getShareLinksContainer();
      const { resources } = await container.items.query<ShareLinkDoc>({
        query: "SELECT * FROM c WHERE c.createdByUserId = @uid ORDER BY c.createdAt DESC",
        parameters: [{ name: "@uid", value: payload.userId }],
      }).fetchAll();

      const nowMs = Date.now();
      const normalized: ShareLinkDoc[] = [];
      for (const item of resources) {
        const displayName = (item.displayName ?? "").trim() || item.blobName?.split("/").pop() || item.id;
        const expiresMs = new Date(item.expiresAt).getTime();
        const isExpiredByTime = Number.isFinite(expiresMs) ? expiresMs <= nowMs : false;
        const status = item.status ?? (isExpiredByTime ? "expired" : "active");
        const normalizedItem: ShareLinkDoc = {
          ...item,
          displayName,
          status,
          viewCount: Number.isFinite(item.viewCount) ? item.viewCount : 0,
        };

        if (normalizedItem.status === "active" && isExpiredByTime) {
          const patched: ShareLinkDoc = { ...normalizedItem, status: "expired" };
          normalized.push(patched);
          try {
            await container.item(item.id, item.id).replace(patched);
          } catch {
            // Best-effort status sync; listing should still proceed.
          }
        } else {
          normalized.push(normalizedItem);
        }
      }

      const statusFilter = (request.query.get("status") ?? "all").toLowerCase();
      const q = (request.query.get("q") ?? "").trim().toLowerCase();
      const filtered = normalized.filter((item) => {
        if (statusFilter !== "all" && statusFilter !== item.status) return false;
        if (q && !item.displayName.toLowerCase().includes(q)) return false;
        return true;
      });

      const baseUrl = resolvePublicBaseUrl(request);
      const withUrl = filtered.map((item) => ({
        ...item,
        url: `${baseUrl}/api/photos/share/open/${encodeURIComponent(item.id)}`,
      }));

      return json(withUrl);
    } catch (e) {
      if (isCosmosAuthError(e)) {
        return json({
          items: [],
          managedUnavailable: true,
          message: "云端链接维护暂不可用（sharelinks 容器缺失或 Cosmos Data Plane 权限不足）",
        });
      }
      const message = e instanceof Error ? e.message : "Failed to fetch share links";
      return json({ error: message }, 500);
    }
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

    try {
      const container = await getShareLinksContainer();
      const result = await mutateShareLinkWithRetry(
        container,
        linkId,
        (resource) => resource.createdByUserId === payload.userId || payload.role === "admin",
        (resource, now) => {
          const effectiveStatus = resource.status === "active" && new Date(resource.expiresAt).getTime() <= now
            ? "expired"
            : resource.status;

          if (body.action === "revoke") {
            if (effectiveStatus === "revoked") {
              return { ok: true, updated: resource };
            }
            const nowIso = new Date().toISOString();
            return {
              ok: true,
              updated: {
                ...resource,
                status: "revoked",
                revokedAt: nowIso,
                expiresAt: nowIso,
              },
            };
          }

          if (effectiveStatus !== "active") {
            return { ok: false, response: json({ error: "Only active links can be extended" }, 400) };
          }
          const extendHoursRaw = Number(body.hours ?? 24);
          const extendHours = Number.isFinite(extendHoursRaw)
            ? Math.max(1, Math.min(24 * 30, Math.floor(extendHoursRaw)))
            : 24;
          const baseMs = Math.max(now, new Date(resource.expiresAt).getTime());
          return {
            ok: true,
            updated: {
              ...resource,
              expiresAt: new Date(baseMs + extendHours * 3600 * 1000).toISOString(),
            },
          };
        },
      );

      if (!result.ok) return result.response;
      return json(result.updated);
    } catch (e) {
      if (isCosmosAuthError(e)) {
        return json({ error: "云端链接维护暂不可用（sharelinks 容器缺失或 Cosmos Data Plane 权限不足）" }, 503);
      }
      const message = e instanceof Error ? e.message : "Failed to update share link";
      return json({ error: message }, 500);
    }
  },
});
