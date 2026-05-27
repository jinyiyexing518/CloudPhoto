import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getInvitesContainer, isGroupAdmin, InviteDoc } from "../../utils/cosmosClient";

/** DELETE /api/invites/{token} — cancel a pending invite (admin only) */
app.http("cancelInvite", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "invites/{token}",
  handler: async (request: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    const token = request.params.token;
    const container = await getInvitesContainer();

    let invite: InviteDoc | undefined;
    try {
      const { resource } = await container.item(token, token).read<InviteDoc>();
      invite = resource;
    } catch { /* not found */ }

    if (!invite) return { status: 404, body: JSON.stringify({ error: "邀请不存在" }) };
    if (invite.status !== "pending") return { status: 409, body: JSON.stringify({ error: "邀请已处理" }) };

    if (!await isGroupAdmin(invite.groupId, payload.userId))
      return { status: 403, body: JSON.stringify({ error: "Admin only" }) };

    await container.item(token, token).patch([
      { op: "replace", path: "/status", value: "cancelled" },
      { op: "add", path: "/respondedAt", value: new Date().toISOString() },
    ]);

    return { status: 200, body: JSON.stringify({ message: "邀请已取消" }) };
  },
});
