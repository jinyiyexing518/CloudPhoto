import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getGroupsContainer, isGroupAdmin } from "../../utils/cosmosClient";

app.http("deleteGroup", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "groups/{groupId}",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    const groupId = request.params.groupId;
    if (!await isGroupAdmin(groupId, payload.userId))
      return { status: 403, body: JSON.stringify({ error: "Only group admins can delete the group" }) };

    const container = await getGroupsContainer();
    try {
      await container.item(groupId, groupId).delete();
    } catch {
      return { status: 404, body: JSON.stringify({ error: "Group not found" }) };
    }
    context.log("Group deleted:", groupId);
    return { status: 204 };
  },
});
