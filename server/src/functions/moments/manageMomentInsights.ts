import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  getMomentsContainer,
  isGroupMember,
  MomentInsightDoc,
} from "../../utils/cosmosClient";
import { extractTokenFromHeader } from "../../utils/jwtUtils";

type MomentInsightDocWithEtag = MomentInsightDoc & { _etag?: string };

function json(body: unknown, status = 200): HttpResponseInit {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (typeof statusCode === "number") return statusCode;
  const code = (error as { code?: number | string }).code;
  return typeof code === "number" ? code : undefined;
}

function isCosmosUnavailable(error: unknown): boolean {
  const statusCode = getStatusCode(error);
  if (statusCode === 401 || statusCode === 403 || statusCode === 404) return true;
  const message = (error as { message?: string } | undefined)?.message ?? "";
  return /Request blocked by Auth|cosmos-native-rbac|cannot be authorized by AAD token|Authorization|NotFound|Resource Not Found|Owner resource does not exist|moments/i.test(message);
}

function isConcurrentConflict(error: unknown): boolean {
  const statusCode = getStatusCode(error);
  return statusCode === 409 || statusCode === 412;
}

function isNotFound(error: unknown): boolean {
  const statusCode = getStatusCode(error);
  if (statusCode === 404) return true;
  const message = (error as { message?: string } | undefined)?.message ?? "";
  return /NotFound|Resource Not Found|owner resource does not exist/i.test(message);
}

function normalizeViewerName(viewerName: string | undefined): string {
  const value = viewerName?.trim() || "匿名用户";
  return value.slice(0, 80);
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function toMomentInsightId(photoName: string): string {
  const encoded = Buffer.from(photoName, "utf8").toString("base64");
  return `moment:${encoded}`;
}

function decodeMomentInsightId(id: string): string | null {
  if (!id.startsWith("moment:")) return null;
  try {
    return Buffer.from(id.slice("moment:".length), "base64").toString("utf8");
  } catch {
    return null;
  }
}

function getScopeFromPhotoName(photoName: string):
  | { ok: true; scopeType: "personal" | "group"; scopeId: string }
  | { ok: false; response: HttpResponseInit } {
  const segs = photoName.split("/");
  if (segs[0] === "personal" && segs.length >= 3) {
    return { ok: true, scopeType: "personal", scopeId: segs[1] };
  }
  if (segs[0] === "groups" && segs.length >= 3) {
    return { ok: true, scopeType: "group", scopeId: segs[1] };
  }
  return { ok: false, response: json({ error: "Invalid photo path" }, 400) };
}

async function canAccessPhotoScope(
  photoName: string,
  userId: string,
  role: string,
): Promise<boolean> {
  const scope = getScopeFromPhotoName(photoName);
  if (!scope.ok) return false;
  if (scope.scopeType === "personal") {
    return scope.scopeId === userId || role === "admin";
  }
  return isGroupMember(scope.scopeId, userId);
}

app.http("listMomentInsights", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "photos/moments/insights",
  handler: async (request: HttpRequest): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return json({ error: "Unauthorized" }, 401);

    const body = request.method === "POST"
      ? (await request.json().catch(() => ({})) as { photoNames?: string[] })
      : undefined;

    const names = request.method === "POST"
      ? (Array.isArray(body?.photoNames) ? body.photoNames : [])
          .map((value) => value.trim())
          .filter(Boolean)
      : request.query
          .getAll("name")
          .map((value) => value.trim())
          .filter(Boolean);

    if (names.length === 0) return json({ items: [] });

    const uniqueNames = [...new Set(names)];
    const allowedNames: string[] = [];
    for (const photoName of uniqueNames) {
      if (await canAccessPhotoScope(photoName, payload.userId, payload.role)) {
        allowedNames.push(photoName);
      }
    }

    if (allowedNames.length === 0) {
      return json({ items: [] });
    }

    const ids = allowedNames.map(toMomentInsightId);

    try {
      const container = await getMomentsContainer();
      const query = {
        query: "SELECT * FROM c WHERE ARRAY_CONTAINS(@ids, c.id)",
        parameters: [
          { name: "@ids", value: ids },
        ],
      };
      const { resources } = await container.items.query<MomentInsightDoc>(query).fetchAll();

      return json({
        items: resources
          .map((item) => ({
            photoName: item.photoName || decodeMomentInsightId(item.id) || "",
            totalViews: Number.isFinite(item.totalViews) ? item.totalViews : 0,
            lastViewedAt: item.lastViewedAt,
            lastViewedBy: item.lastViewedBy,
            viewers: item.viewers ?? {},
            dailyViews: item.dailyViews ?? {},
            updatedAt: item.updatedAt,
          }))
          .filter((item) => !!item.photoName),
      });
    } catch (e) {
      if (isCosmosUnavailable(e)) {
        return json({
          items: [],
          managedUnavailable: true,
          message: "Moments insights unavailable (moments container missing or Cosmos Data Plane permission insufficient)",
        });
      }
      const message = e instanceof Error ? e.message : "Failed to load moment insights";
      return json({ error: message }, 500);
    }
  },
});

app.http("recordMomentView", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/moments/view",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return json({ error: "Unauthorized" }, 401);

    const body = (await request.json().catch(() => ({}))) as {
      photoName?: string;
      viewerName?: string;
    };
    const photoName = body.photoName?.trim();
    if (!photoName) return json({ error: "photoName required" }, 400);

    const scope = getScopeFromPhotoName(photoName);
    if (!scope.ok) return scope.response;

    const allowed =
      scope.scopeType === "personal"
        ? scope.scopeId === payload.userId || payload.role === "admin"
        : await isGroupMember(scope.scopeId, payload.userId);

    if (!allowed) {
      return json({ error: "Forbidden" }, 403);
    }

    const id = toMomentInsightId(photoName);
    const viewer = normalizeViewerName(body.viewerName ?? payload.displayName ?? payload.username);
    const today = new Date().toISOString().slice(0, 10);
    const maxAttempts = 3;

    try {
      const container = await getMomentsContainer();
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const now = new Date().toISOString();

        try {
          const patchOperations: Array<{ op: "set" | "incr"; path: string; value: unknown }> = [
            { op: "incr", path: "/totalViews", value: 1 },
            { op: "set", path: "/lastViewedAt", value: now },
            { op: "set", path: "/lastViewedBy", value: viewer },
            { op: "set", path: "/updatedAt", value: now },
          ];

          const { resource } = await container.item(id, id).patch<MomentInsightDoc>(patchOperations);
          if (resource) {
            return json({ ok: true, item: resource });
          }

          const { resource: afterPatch } = await container.item(id, id).read<MomentInsightDoc>();
          return json({ ok: true, item: afterPatch ?? { id, photoName, scopeType: scope.scopeType, scopeId: scope.scopeId, totalViews: 1, lastViewedAt: now, lastViewedBy: viewer, viewers: {}, dailyViews: {}, createdAt: now, updatedAt: now } });
        } catch (patchErr) {
          if (isNotFound(patchErr)) {
            const doc: MomentInsightDoc = {
              id,
              photoName,
              scopeType: scope.scopeType,
              scopeId: scope.scopeId,
              totalViews: 1,
              lastViewedAt: now,
              lastViewedBy: viewer,
              viewers: { [viewer]: 1 },
              dailyViews: { [today]: 1 },
              createdAt: now,
              updatedAt: now,
            };
            try {
              await container.items.create(doc);
              return json({ ok: true, item: doc });
            } catch (createErr) {
              if (isConcurrentConflict(createErr) && attempt < maxAttempts) continue;
              throw createErr;
            }
          }
          if (isConcurrentConflict(patchErr) && attempt < maxAttempts) continue;
          throw patchErr;
        }
      }
      return json({ error: "Moment insight update conflict, please retry" }, 409);
    } catch (e) {
      if (isCosmosUnavailable(e)) {
        return json({
          ok: false,
          managedUnavailable: true,
          message: "Moments insights unavailable (moments container missing or Cosmos Data Plane permission insufficient)",
        });
      }
      context.error("Record moment view error:", e);
      const message = e instanceof Error ? e.message : "Failed to record moment view";
      return json({ error: message }, 500);
    }
  },
});
