import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getUsersContainer } from "../../utils/cosmosClient";
import { extractTokenFromHeader, signToken, signRefreshToken } from "../../utils/jwtUtils";
import { checkRateLimit, getClientIp } from "../../utils/rateLimit";

/**
 * PATCH /api/auth/me
 * Update the caller's displayName.
 * Returns fresh access + refresh tokens so the new name is reflected immediately.
 */
app.http("authUpdateProfile", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "auth/me",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    if (!checkRateLimit(`update-profile:${getClientIp(request)}`, 10, 60_000)) {
      return { status: 429, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Too many requests" }) };
    }

    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };

    try {
      const body = (await request.json()) as { displayName?: string };
      const displayName = body.displayName?.trim();
      if (!displayName) {
        return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "displayName is required" }) };
      }
      if (displayName.length > 40) {
        return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "displayName 最多 40 个字符" }) };
      }

      const container = await getUsersContainer();
      const { resource: user } = await container.item(payload.userId, payload.userId).read();
      if (!user) return { status: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "User not found" }) };

      await container.item(payload.userId, payload.userId).replace({ ...user, displayName });

      // Re-issue tokens so the new displayName is embedded immediately
      const tokenPayload = { userId: user.id, username: user.username, displayName, role: user.role };
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: { id: user.id, username: user.username, email: user.email, displayName, avatar: user.avatar, role: user.role },
          token: signToken(tokenPayload),
          refreshToken: signRefreshToken(tokenPayload),
        }),
      };
    } catch (error) {
      context.error("Update profile error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Failed to update profile" }) };
    }
  },
});
