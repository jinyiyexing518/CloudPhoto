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

function decodeMeta(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return decoded || undefined;
  } catch {
    return raw || undefined;
  }
}

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function renderFolderSharePage(resource: ShareLinkDoc, items: Array<{
  id: string;
  name: string;
  relativePath: string;
  url: string;
  updatedAt: string;
}>): string {
  const title = escapeHtml(resource.displayName || "共享文件夹");
  const cards = items.map((item) => {
    const alt = escapeHtml(item.name);
    const relativePath = escapeHtml(item.relativePath);
    const updatedAt = escapeHtml(item.updatedAt);
    const url = escapeHtml(item.url);
    return `
      <article class="card">
        <a href="${url}" target="_blank" rel="noopener noreferrer">
          <img src="${url}" alt="${alt}" loading="lazy" />
        </a>
        <div class="card-body">
          <div class="card-title" title="${alt}">${alt}</div>
          <div class="card-meta">${relativePath}</div>
          <div class="card-meta">更新于 ${updatedAt}</div>
          <div class="card-actions">
            <a href="${url}" target="_blank" rel="noopener noreferrer">打开原图</a>
            <a href="${url}" download>下载</a>
          </div>
        </div>
      </article>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", "PingFang SC", sans-serif; background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%); color: #111827; }
    .page { max-width: 1180px; margin: 0 auto; padding: 24px 16px 40px; }
    .hero { background: rgba(255,255,255,0.92); border: 1px solid #e5e7eb; border-radius: 20px; padding: 20px; box-shadow: 0 12px 36px rgba(15, 23, 42, 0.08); }
    .hero h1 { margin: 0 0 8px; font-size: 1.8rem; }
    .hero p { margin: 4px 0; color: #4b5563; }
    .grid { margin-top: 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
    .card { overflow: hidden; background: rgba(255,255,255,0.95); border-radius: 18px; border: 1px solid #e5e7eb; box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06); }
    .card img { display: block; width: 100%; height: 220px; object-fit: cover; background: #e5e7eb; }
    .card-body { padding: 12px; }
    .card-title { font-size: 0.95rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-meta { margin-top: 6px; font-size: 0.8rem; color: #6b7280; word-break: break-word; }
    .card-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
    .card-actions a { text-decoration: none; border-radius: 999px; padding: 7px 12px; background: #eff6ff; color: #1d4ed8; font-size: 0.8rem; font-weight: 600; }
    .empty { margin-top: 18px; padding: 24px; text-align: center; background: rgba(255,255,255,0.92); border-radius: 18px; color: #6b7280; border: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <h1>${title}</h1>
      <p>共 ${items.length} 张照片</p>
      <p>链接到期时间：${escapeHtml(formatDate(resource.expiresAt))}</p>
    </section>
    ${items.length > 0 ? `<section class="grid">${cards}</section>` : `<section class="empty">这个共享文件夹里暂时没有可查看的照片。</section>`}
  </main>
</body>
</html>`;
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

      if ((resource.targetType ?? "photo") === "photo" && !resource.blobName) {
        return { status: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Shared photo not found" }) };
      }

      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);

      if ((resource.targetType ?? "photo") === "folder") {
        if (!resource.targetPrefix) {
          return { status: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Shared folder not found" }) };
        }

        const remainingHours = Math.max(1, Math.ceil((new Date(resource.expiresAt).getTime() - now) / (1000 * 60 * 60)));
        const key = await getUserDelegationKey(Math.min(remainingHours, 24));
        const items: Array<{ id: string; name: string; relativePath: string; url: string; updatedAt: string }> = [];

        for await (const blob of containerClient.listBlobsFlat({ prefix: resource.targetPrefix, includeMetadata: true })) {
          if (getMeta(blob.metadata, "deletedAt")) continue;
          const relativePath = blob.name.startsWith(resource.targetPrefix)
            ? blob.name.slice(resource.targetPrefix.length)
            : blob.name;
          items.push({
            id: blob.name,
            name: decodeMeta(getMeta(blob.metadata, "originalName"))
              || relativePath.split("/").pop()
              || relativePath,
            relativePath,
            url: generateSasUrlWithKey(blob.name, key, Math.min(remainingHours, 24)),
            updatedAt: blob.properties.lastModified?.toISOString() ?? new Date().toISOString(),
          });
        }

        items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

        try {
          await links.item(resource.id, resource.id).patch([
            { op: "incr", path: "/viewCount", value: 1 },
            { op: "set", path: "/lastViewedAt", value: new Date().toISOString() },
          ]);
        } catch (e) {
          context.warn("Share link stats update failed:", e);
        }

        return {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
          body: renderFolderSharePage(resource, items),
        };
      }

      const blobName = resource.blobName as string;
      const props = await containerClient.getBlobClient(blobName).getProperties();
      if (getMeta(props.metadata, "deletedAt")) {
        return { status: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Photo not found" }) };
      }

      const remainingHours = Math.max(1, Math.ceil((new Date(resource.expiresAt).getTime() - now) / (1000 * 60 * 60)));
      const key = await getUserDelegationKey(Math.min(remainingHours, 24));
      const sasUrl = generateSasUrlWithKey(blobName, key, Math.min(remainingHours, 24));

      // Use atomic patch to avoid lost updates under concurrent opens.
      try {
        await links.item(resource.id, resource.id).patch([
          { op: "incr", path: "/viewCount", value: 1 },
          { op: "set", path: "/lastViewedAt", value: new Date().toISOString() },
        ]);
      } catch (e) {
        context.warn("Share link stats update failed:", e);
      }

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
