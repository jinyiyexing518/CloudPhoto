import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import {
  getInvitesContainer, getGroupsContainer, getUsersContainer,
  InviteDoc, GroupDoc, GroupMember,
} from "../../utils/cosmosClient";

/** POST /api/invites/{token}/respond  body: { action: "accept" | "decline" } */
app.http("respondInvite", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "invites/{token}/respond",
  handler: async (request: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    const token = request.params.token;
    let body: { action?: string };
    try { body = await request.json() as typeof body; } catch { body = {}; }
    const action = body.action;
    if (action !== "accept" && action !== "decline")
      return { status: 400, body: JSON.stringify({ error: "action must be 'accept' or 'decline'" }) };

    const invitesContainer = await getInvitesContainer();
    let invite: InviteDoc | undefined;
    try {
      const { resource } = await invitesContainer.item(token, token).read<InviteDoc>();
      invite = resource;
    } catch { /* not found */ }

    if (!invite) return { status: 404, body: JSON.stringify({ error: "邀请不存在" }) };
    if (invite.status !== "pending") return { status: 409, body: JSON.stringify({ error: `邀请已${invite.status === "accepted" ? "接受" : invite.status === "declined" ? "拒绝" : "取消"}` }) };
    if (new Date(invite.expiresAt) < new Date()) return { status: 410, body: JSON.stringify({ error: "邀请已过期" }) };

    // Verify the logged-in user's email matches the invite
    const usersContainer = await getUsersContainer();
    const { resource: user } = await usersContainer.item(payload.userId, payload.userId).read();
    if (!user) return { status: 404, body: JSON.stringify({ error: "User not found" }) };
    if (user.email?.toLowerCase() !== invite.email)
      return { status: 403, body: JSON.stringify({ error: `此邀请发送给 ${invite.email}，请用该邮箱对应的账号登录` }) };

    const now = new Date().toISOString();

    if (action === "decline") {
      await invitesContainer.item(token, token).patch([
        { op: "replace", path: "/status", value: "declined" },
        { op: "add", path: "/respondedAt", value: now },
      ]);
      return { status: 200, body: JSON.stringify({ message: "已拒绝邀请" }) };
    }

    // Accept: add user to group
    const groupsContainer = await getGroupsContainer();
    const { resource: group } = await groupsContainer.item(invite.groupId, invite.groupId).read<GroupDoc>();
    if (!group) return { status: 404, body: JSON.stringify({ error: "群组不存在" }) };

    if (group.members.some((m) => m.userId === payload.userId))
      return { status: 409, body: JSON.stringify({ error: "你已经是该群组成员" }) };

    const newMember: GroupMember = {
      userId: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      role: "member",
      joinedAt: now,
      addedBy: invite.invitedByUserId,
    };

    const updated: GroupDoc = { ...group, members: [...group.members, newMember] };
    await groupsContainer.item(invite.groupId, invite.groupId).replace(updated);

    await invitesContainer.item(token, token).patch([
      { op: "replace", path: "/status", value: "accepted" },
      { op: "add", path: "/respondedAt", value: now },
    ]);

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `已成功加入群组「${group.name}」`, member: newMember }),
    };
  },
});
