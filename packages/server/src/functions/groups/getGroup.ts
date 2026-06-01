import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getGroupsContainer, isGroupMember, GroupDoc } from "../../utils/cosmosClient";

app.http("getGroup", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "groups/{groupId}",
  handler: async (request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    const groupId = request.params.groupId;
    const canAccess = payload.role === "admin" || await isGroupMember(groupId, payload.userId);
    if (!canAccess) return { status: 403, body: JSON.stringify({ error: "Not a member of this group" }) };

    const container = await getGroupsContainer();
    const { resource: group } = await container.item(groupId, groupId).read<GroupDoc>();
    if (!group) return { status: 404, body: JSON.stringify({ error: "Group not found" }) };

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...group,
        myRole: group.members.find((m) => m.userId === payload.userId)?.role
          ?? (payload.role === "admin" ? "admin" : "member"),
      }),
    };
  },
});
