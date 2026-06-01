import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getInvitesContainer, InviteDoc } from "../../utils/cosmosClient";

/** Public endpoint — returns invite summary for the accept/decline page. */
app.http("getInvite", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "invites/{token}",
  handler: async (request: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> => {
    const token = request.params.token;
    const container = await getInvitesContainer();

    let invite: InviteDoc | undefined;
    try {
      const { resource } = await container.item(token, token).read<InviteDoc>();
      invite = resource;
    } catch { /* not found */ }

    if (!invite) return { status: 404, body: JSON.stringify({ error: "邀请不存在或已失效" }) };

    // Check expiry
    if (invite.status === "pending" && new Date(invite.expiresAt) < new Date()) {
      await container.item(token, token).patch([{ op: "replace", path: "/status", value: "cancelled" }]);
      return { status: 410, body: JSON.stringify({ error: "邀请链接已过期" }) };
    }

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: invite.id,
        groupId: invite.groupId,
        groupName: invite.groupName,
        email: invite.email,
        invitedByName: invite.invitedByName,
        status: invite.status,
        expiresAt: invite.expiresAt,
      }),
    };
  },
});
