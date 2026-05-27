import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { randomUUID } from "crypto";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import {
  getGroupsContainer, getInvitesContainer, isGroupAdmin, GroupDoc, InviteDoc,
} from "../../utils/cosmosClient";
import { sendInviteEmail } from "../../utils/emailUtils";

app.http("createInvite", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "groups/{groupId}/invites",
  handler: async (request: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    const groupId = request.params.groupId;
    if (!await isGroupAdmin(groupId, payload.userId))
      return { status: 403, body: JSON.stringify({ error: "Only group admins can invite members" }) };

    let body: { email?: string };
    try { body = await request.json() as typeof body; } catch { body = {}; }
    const email = body.email?.trim().toLowerCase();
    if (!email || !email.includes("@"))
      return { status: 400, body: JSON.stringify({ error: "Valid email is required" }) };

    const groupsContainer = await getGroupsContainer();
    const { resource: group } = await groupsContainer.item(groupId, groupId).read<GroupDoc>();
    if (!group) return { status: 404, body: JSON.stringify({ error: "Group not found" }) };

    // Check if the email belongs to an existing member
    if (group.members.some((m) => m.email?.toLowerCase() === email))
      return { status: 409, body: JSON.stringify({ error: "该邮箱已是群组成员" }) };

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
      return { status: 409, body: JSON.stringify({ error: "该邮箱已有待处理的邀请" }) };

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

    const appUrl = process.env.APP_BASE_URL
      ?? request.headers.get("origin")
      ?? "https://cloudphoto.azurestaticapps.net";
    void sendInviteEmail({
      toEmail: email,
      groupName: group.name,
      inviterName,
      inviteUrl: `${appUrl}?invite=${invite.id}`,
    });

    return {
      status: 201,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: invite.id, email, groupName: group.name, expiresAt }),
    };
  },
});
