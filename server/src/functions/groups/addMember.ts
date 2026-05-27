import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { randomUUID } from "crypto";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import {
  getGroupsContainer, getUsersContainer, getInvitesContainer,
  isGroupAdmin, GroupDoc, InviteDoc,
} from "../../utils/cosmosClient";
import { sendInviteEmail } from "../../utils/emailUtils";

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

    // Load group
    const groupsContainer = await getGroupsContainer();
    const { resource: group } = await groupsContainer.item(groupId, groupId).read<GroupDoc>();
    if (!group) return { status: 404, body: JSON.stringify({ error: "Group not found" }) };

    // Look up target user
    const usersContainer = await getUsersContainer();
    const { resources } = await usersContainer.items
      .query({ query: "SELECT * FROM c WHERE c.username = @u", parameters: [{ name: "@u", value: username }] })
      .fetchAll();
    const targetUser = resources[0];
    if (!targetUser) return { status: 404, body: JSON.stringify({ error: `用户 "${username}" 不存在` }) };

    // Already a member?
    if (group.members.some((m) => m.userId === targetUser.id))
      return { status: 409, body: JSON.stringify({ error: "该用户已是群组成员" }) };

    const email = targetUser.email?.toLowerCase();
    if (!email)
      return { status: 422, body: JSON.stringify({ error: "该用户没有绑定邮箱，无法发送邀请" }) };

    const inviter = group.members.find((m) => m.userId === payload.userId);
    const inviterName = inviter?.displayName ?? payload.userId;

    // Check for existing pending invite to this email for this group
    const invitesContainer = await getInvitesContainer();
    const { resources: existing } = await invitesContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.groupId = @gid AND c.email = @email AND c.status = 'pending'",
        parameters: [{ name: "@gid", value: groupId }, { name: "@email", value: email }],
      })
      .fetchAll();
    if (existing.length > 0)
      return { status: 409, body: JSON.stringify({ error: "该用户已有待处理的邀请，请等待对方接受" }) };

    // Create invite
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const invite: InviteDoc = {
      id: randomUUID(),
      groupId,
      groupName: group.name,
      email,
      invitedByUserId: payload.userId,
      invitedByName: inviterName,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt,
    };
    await invitesContainer.items.create(invite);

    const appUrl = process.env.APP_BASE_URL ?? "https://cloudphoto.azurestaticapps.net";
    void sendInviteEmail({
      toEmail: email,
      groupName: group.name,
      inviterName,
      inviteUrl: `${appUrl}?invite=${invite.id}`,
    });

    return {
      status: 202,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: invite.id, email, displayName: targetUser.displayName, groupName: group.name, expiresAt }),
    };
  },
});

