import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { compare } from "bcryptjs";
import { getUsersContainer, UserDoc } from "../../utils/cosmosClient";
import { signToken, signRefreshToken } from "../../utils/jwtUtils";

app.http("authLogin", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/login",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const body = (await request.json()) as { username?: string; password?: string };
      const { username, password } = body;

      if (!username || !password) {
        return { status: 400, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "username and password are required" }) };
      }

      const container = await getUsersContainer();
      const result = await container.items
        .query<UserDoc>({ query: "SELECT * FROM c WHERE c.username = @u",
          parameters: [{ name: "@u", value: username }] })
        .fetchAll();

      const user = result.resources[0];
      if (!user) {
        return { status: 404, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "该账号不存在，请先注册" }) };
      }

      const valid = await compare(password, user.passwordHash);
      if (!valid) {
        return { status: 401, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Invalid username or password" }) };
      }

      // Update lastLoginAt
      await container.items.upsert({ ...user, lastLoginAt: new Date().toISOString() });

      const tokenPayload = { userId: user.id, username: user.username, displayName: user.displayName, role: user.role };
      const token = signToken(tokenPayload);
      const refreshToken = signRefreshToken(tokenPayload);
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          refreshToken,
          user: { id: user.id, username: user.username, email: user.email, displayName: user.displayName, avatar: user.avatar, role: user.role },
        }),
      };
    } catch (error) {
      context.error("Login error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Login failed" }) };
    }
  },
});
