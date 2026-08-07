import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getChangelogsContainer } from "../../utils/cosmos/cosmosClient";
import {
  CHANGELOG_QUERY,
  ChangelogQueryRow,
  parseChangelogDays,
  toChangelogEntries,
} from "./changelogResponse";

app.http("getChangelogs", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "changelogs",
  handler: async (
    req: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    try {
      const days = parseChangelogDays(req.query.get("days"));

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const container = await getChangelogsContainer();
      const { resources: queryRows } = await container.items
        .query<ChangelogQueryRow>({
          query: CHANGELOG_QUERY,
          parameters: [{ name: "@cutoff", value: cutoffStr }],
        })
        .fetchAll();

      const resources = toChangelogEntries(queryRows);

      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
        },
        body: JSON.stringify(resources),
      };
    } catch (error) {
      context.error("getChangelogs error:", error);
      return { status: 500, body: "Internal server error" };
    }
  },
});
