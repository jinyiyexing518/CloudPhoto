import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getAdminsContainer } from "../../utils/cosmosClient";

// Only this account can manage the admins list
const SUPER_ADMIN_USERNAME = "zhangchi";

app.http("authAddAdmin", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/admins",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const payload = extractTokenFromHeader(request.headers.get("authorization"));
      if (!payload) {
        return { status: 401, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Unauthorized" }) };
      }
      if (payload.username !== SUPER_ADMIN_USERNAME) {
        return { status: 403, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Forbidden: only zhangchi can manage admins" }) };
      }

      const body = (await request.json()) as { email?: string; username?: string };
      if (!body.email && !body.username) {
        return { status: 400, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Provide at least email or username" }) };
      }

      const container = await getAdminsContainer();

      // Check for duplicates
      const { resources } = await container.items
        .query({
          query: "SELECT VALUE COUNT(1) FROM c WHERE c.email = @email OR c.username = @username",
          parameters: [
            { name: "@email", value: body.email ?? "" },
            { name: "@username", value: body.username ?? "" },
          ],
        })
        .fetchAll();
      if ((resources[0] as number) > 0) {
        return { status: 409, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Already in admin list" }) };
      }

      const doc = {
        id: crypto.randomUUID(),
        email: body.email ?? "",
        username: body.username ?? "",
        addedAt: new Date().toISOString(),
        addedBy: payload.username,
      };
      await container.items.create(doc);

      return {
        status: 201,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Admin added", admin: doc }),
      };
    } catch (error) {
      context.error("AddAdmin error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Failed to add admin" }) };
    }
  },
});
