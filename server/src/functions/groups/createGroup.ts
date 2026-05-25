import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getGroupsContainer, getUsersContainer, GroupDoc, GroupMember } from "../../utils/cosmosClient";

app.http("createGroup", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "groups",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    let body: { name?: string; description?: string };
    try { body = await request.json() as typeof body; } catch { body = {}; }

    const name = body.name?.trim();
    if (!name) return { status: 400, body: JSON.stringify({ error: "name is required" }) };

    const usersContainer = await getUsersContainer();
    const { resource: creator } = await usersContainer.item(payload.userId, payload.userId).read();
    const now = new Date().toISOString();

    const creatorMember: GroupMember = {
      userId: payload.userId,
      username: payload.username,
      email: creator?.email ?? "",
      displayName: payload.displayName,
      role: "admin",
      joinedAt: now,
      addedBy: payload.userId,
    };

    const group: GroupDoc = {
      id: crypto.randomUUID(),
      name,
      description: body.description?.trim(),
      createdBy: payload.userId,
      createdAt: now,
      members: [creatorMember],
      folders: [],
    };

    const groupsContainer = await getGroupsContainer();
    await groupsContainer.items.create(group);

    context.log("Group created:", group.id);
    return {
      status: 201,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...group, myRole: "admin" }),
    };
  },
});
