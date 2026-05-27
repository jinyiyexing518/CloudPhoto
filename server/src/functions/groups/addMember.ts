import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getGroupsContainer, getUsersContainer, isGroupAdmin, GroupDoc, GroupMember } from "../../utils/cosmosClient";
import { sendGroupInviteEmail } from "../../utils/emailUtils";

app.http("addMember", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "groups/{groupId}/members",
  handler: async (request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    const groupId = request.params.groupId;
    if (!await isGroupAdmin(groupId, payload.userId))
      return { status: 403, body: JSON.stringify({ error: "Only group admins can add members" }) };

    let body: { username?: string };
    try { body = await request.json() as typeof body; } catch { body = {}; }

    const username = body.username?.trim();
    if (!username)
      return { status: 400, body: JSON.stringify({ error: "username is required" }) };

    const groupsContainer = await getGroupsContainer();
    const { resource: group } = await groupsContainer.item(groupId, groupId).read<GroupDoc>();
    if (!group) return { status: 404, body: JSON.stringify({ error: "Group not found" }) };

    const inviter = group.members.find((m) => m.userId === payload.userId);
    const inviterName = inviter?.displayName ?? payload.userId;

    const usersContainer = await getUsersContainer();
    const { resources } = await usersContainer.items
      .query({ query: "SELECT * FROM c WHERE c.username = @u", parameters: [{ name: "@u", value: username }] })
      .fetchAll();
    const user = resources[0];
    if (!user) return { status: 404, body: JSON.stringify({ error: `用户 "${username}" 不存在` }) };

    if (group.members.some((m) => m.userId === user!.id))
    if (group.members.some((m) => m.userId === user.id))
      return { status: 409, body: JSON.stringify({ error: "该用户已是群组成员" }) };

    const now = new Date().toISOString();
    const newMember: GroupMember = {
      userId: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      role: "member",
      joinedAt: now,
      addedBy: payload.userId,
    };

    const updated: GroupDoc = { ...group, members: [...group.members, newMember] };
    await groupsContainer.item(groupId, groupId).replace(updated);

    // Fire-and-forget email notification
    void sendGroupInviteEmail({
      toEmail: user.email,
      toName: user.displayName,
      groupName: group.name,
      inviterName,
    });

    return { status: 201, headers: { "Content-Type": "application/json" }, body: JSON.stringify(newMember) };
  },
});
