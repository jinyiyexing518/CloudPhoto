import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { getGroupsContainer, GroupDoc } from "../../utils/cosmosClient";

app.http("listGroups", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "groups",
  handler: async (request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    const container = await getGroupsContainer();
    const { resources: groups } = await container.items
      .query<GroupDoc>({
        query: `SELECT * FROM c WHERE ARRAY_CONTAINS(c.members, {"userId": @userId}, true)`,
        parameters: [{ name: "@userId", value: payload.userId }],
      })
      .fetchAll();

    const result = groups.map((g) => ({
      ...g,
      myRole: g.members.find((m) => m.userId === payload.userId)?.role ?? "member",
    }));

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };
  },
});
