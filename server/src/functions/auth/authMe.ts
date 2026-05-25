import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getUsersContainer } from "../../utils/cosmosClient";
import { extractTokenFromHeader } from "../../utils/jwtUtils";

app.http("authMe", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "auth/me",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const payload = extractTokenFromHeader(request.headers.get("authorization"));
      if (!payload) {
        return { status: 401, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Unauthorized" }) };
      }

      const container = await getUsersContainer();
      const { resource: user } = await container.item(payload.userId, payload.userId).read();
      if (!user) {
        return { status: 404, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "User not found" }) };
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: user.id, username: user.username, email: user.email,
          displayName: user.displayName, avatar: user.avatar, role: user.role,
          createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
        }),
      };
    } catch (error) {
      context.error("Me error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Failed to fetch user" }) };
    }
  },
});
