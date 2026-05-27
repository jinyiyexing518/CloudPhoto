import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { compare, hash } from "bcryptjs";
import { getUsersContainer } from "../../utils/cosmosClient";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { checkRateLimit, getClientIp } from "../../utils/rateLimit";

/**
 * POST /api/auth/change-password
 * Verifies current password then replaces it with a new bcrypt hash.
 */
app.http("authChangePassword", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/change-password",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    // 5 attempts per minute per IP — prevent brute-force probing
    if (!checkRateLimit(`change-pw:${getClientIp(request)}`, 5, 60_000)) {
      return { status: 429, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Too many attempts — please wait a minute" }) };
    }

    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };

    try {
      const body = (await request.json()) as { currentPassword?: string; newPassword?: string };
      const { currentPassword, newPassword } = body;

      if (!currentPassword || !newPassword) {
        return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "currentPassword 和 newPassword 不能为空" }) };
      }
      if (newPassword.length < 6) {
        return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "新密码至少 6 位" }) };
      }

      const container = await getUsersContainer();
      const { resource: user } = await container.item(payload.userId, payload.userId).read();
      if (!user) return { status: 404, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "User not found" }) };

      const valid = await compare(currentPassword, user.passwordHash);
      if (!valid) {
        return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "当前密码不正确" }) };
      }

      const passwordHash = await hash(newPassword, 12);
      await container.item(payload.userId, payload.userId).replace({ ...user, passwordHash });

      return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "密码已更新" }) };
    } catch (error) {
      context.error("Change password error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Failed to change password" }) };
    }
  },
});
