import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { signToken, signRefreshToken, verifyRefreshToken } from "../../utils/jwtUtils";
import { getUsersContainer } from "../../utils/cosmosClient";

/**
 * POST /api/auth/refresh
 * Accepts a valid refresh token in the Authorization header.
 * Returns a new access token + rotated refresh token.
 * No credentials needed — the refresh token acts as proof of identity.
 */
app.http("authRefresh", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/refresh",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return { status: 401, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Refresh token required" }) };
    }

    const payload = verifyRefreshToken(authHeader.slice(7));
    if (!payload) {
      return { status: 401, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid or expired refresh token — please log in again" }) };
    }

    try {
      // Re-fetch user to pick up any role/displayName changes
      const container = await getUsersContainer();
      const { resource: user } = await container.item(payload.userId, payload.userId).read();
      if (!user) {
        return { status: 401, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Account not found" }) };
      }

      const tokenPayload = {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      };

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: signToken(tokenPayload),
          // Rotate the refresh token so each usage extends the 30-day window
          refreshToken: signRefreshToken(tokenPayload),
        }),
      };
    } catch (error) {
      context.error("Token refresh error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Refresh failed" }) };
    }
  },
});
