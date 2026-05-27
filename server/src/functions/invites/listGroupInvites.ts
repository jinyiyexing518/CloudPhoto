import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getInvitesContainer, isGroupAdmin, InviteDoc } from "../../utils/cosmosClient";

/** GET /api/groups/{groupId}/invites — list pending invites (admin only) */
app.http("listGroupInvites", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "groups/{groupId}/invites",
  handler: async (request: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    const groupId = request.params.groupId;
    if (!await isGroupAdmin(groupId, payload.userId))
      return { status: 403, body: JSON.stringify({ error: "Admin only" }) };

    const container = await getInvitesContainer();
    const { resources } = await container.items
      .query<InviteDoc>({
        query: "SELECT * FROM c WHERE c.groupId = @gid AND c.status = 'pending' ORDER BY c.createdAt DESC",
        parameters: [{ name: "@gid", value: groupId }],
      })
      .fetchAll();

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resources.map((inv) => ({
        id: inv.id,
        email: inv.email,
        invitedByName: inv.invitedByName,
        createdAt: inv.createdAt,
        expiresAt: inv.expiresAt,
      }))),
    };
  },
});
