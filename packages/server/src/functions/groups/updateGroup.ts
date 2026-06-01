import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getGroupsContainer, isGroupAdmin } from "../../utils/cosmosClient";

app.http("updateGroup", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "groups/{groupId}",
  handler: async (request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    const groupId = request.params.groupId;
    if (!await isGroupAdmin(groupId, payload.userId))
      return { status: 403, body: JSON.stringify({ error: "Only group admins can update the group" }) };

    let body: { name?: string; description?: string };
    try { body = await request.json() as typeof body; } catch { body = {}; }

    const container = await getGroupsContainer();
    const { resource: group } = await container.item(groupId, groupId).read();
    if (!group) return { status: 404, body: JSON.stringify({ error: "Group not found" }) };

    const updated = {
      ...group,
      ...(body.name?.trim() && { name: body.name.trim() }),
      ...(body.description !== undefined && { description: body.description.trim() }),
    };
    await container.item(groupId, groupId).replace(updated);

    return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(updated) };
  },
});
