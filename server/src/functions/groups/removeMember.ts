import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getGroupsContainer, isGroupAdmin, GroupDoc } from "../../utils/cosmosClient";

app.http("removeMember", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "groups/{groupId}/members/{memberId}",
  handler: async (request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    const { groupId, memberId } = request.params;
    const isSelf = payload.userId === memberId;
    if (!isSelf && !await isGroupAdmin(groupId, payload.userId))
      return { status: 403, body: JSON.stringify({ error: "Only group admins can remove other members" }) };

    const container = await getGroupsContainer();
    const { resource: group } = await container.item(groupId, groupId).read<GroupDoc>();
    if (!group) return { status: 404, body: JSON.stringify({ error: "Group not found" }) };

    if (!group.members.some((m) => m.userId === memberId))
      return { status: 404, body: JSON.stringify({ error: "Member not found" }) };

    const remaining = group.members.filter((m) => m.userId !== memberId);
    if (!isSelf && remaining.filter((m) => m.role === "admin").length === 0)
      return { status: 400, body: JSON.stringify({ error: "Cannot remove the last admin" }) };

    const updated: GroupDoc = { ...group, members: remaining };
    await container.item(groupId, groupId).replace(updated);
    return { status: 204 };
  },
});
