import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { hash } from "bcryptjs";
import { getUsersContainer, UserDoc, isAdminCandidate } from "../../utils/cosmosClient";
import { signToken, signRefreshToken } from "../../utils/jwtUtils";
import { checkRateLimit, getClientIp } from "../../utils/rateLimit";

app.http("authRegister", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/register",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    // 5 registrations per minute per IP
    if (!checkRateLimit(`register:${getClientIp(request)}`, 5, 60_000)) {
      return { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" },
        body: JSON.stringify({ error: "Too many requests — please wait a minute" }) };
    }
    try {
      const body = (await request.json()) as {
        username?: string;
        email?: string;
        displayName?: string;
        password?: string;
        role?: string;
        avatar?: string;
      };

      const { username, email, displayName, password } = body;
      if (!username || !email || !displayName || !password) {
        return { status: 400, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "username, email, displayName and password are required" }) };
      }
      if (password.length < 6) {
        return { status: 400, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Password must be at least 6 characters" }) };
      }

      const container = await getUsersContainer();

      // Check for existing username
      const existing = await container.items
        .query({ query: "SELECT c.id FROM c WHERE c.username = @u OR c.email = @e",
          parameters: [{ name: "@u", value: username }, { name: "@e", value: email }] })
        .fetchAll();
      if (existing.resources.length > 0) {
        return { status: 409, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Username or email already taken" }) };
      }

      // Check admins container to decide role
      const adminCandidate = await isAdminCandidate(email, username);
      const role = adminCandidate ? "admin" : "viewer";

      const now = new Date().toISOString();
      const user: UserDoc = {
        id: crypto.randomUUID(),
        username,
        email,
        displayName,
        passwordHash: await hash(password, 10),
        avatar: body.avatar,
        role: role as "admin" | "viewer",
        privateFolders: [],
        createdAt: now,
        lastLoginAt: now,
      };

      await container.items.create(user);

      const tokenPayload = { userId: user.id, username: user.username, displayName: user.displayName, role: user.role };
      const token = signToken(tokenPayload);
      const refreshToken = signRefreshToken(tokenPayload);
      return {
        status: 201,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          refreshToken,
          user: { id: user.id, username: user.username, email: user.email, displayName: user.displayName, avatar: user.avatar, role: user.role },
        }),
      };
    } catch (error) {
      context.error("Register error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Registration failed" }) };
    }
  },
});
