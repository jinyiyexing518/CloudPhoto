import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { hash } from "bcryptjs";
import { getUsersContainer, UserDoc, isAdminCandidate } from "../../utils/cosmosClient";
import { signToken } from "../../utils/jwtUtils";

app.http("authRegister", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/register",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
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

      const token = signToken({ userId: user.id, username: user.username, displayName: user.displayName, role: user.role });
      return {
        status: 201,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
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
