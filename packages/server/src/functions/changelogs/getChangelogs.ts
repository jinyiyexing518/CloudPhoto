import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getChangelogsContainer } from "../../utils/cosmos/cosmosClient";

interface ChangelogEntry {
  id: string;
  date: string;
  icon: string;
  title: string;
  desc: string;
  details?: string;
}

app.http("getChangelogs", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "changelogs",
  handler: async (
    req: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    try {
      const daysParam = req.query.get("days");
      const days = daysParam ? Math.min(parseInt(daysParam, 10), 365) : 30;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const container = await getChangelogsContainer();
      const { resources } = await container.items
        .query<ChangelogEntry>({
          query:
            "SELECT c.id, c.date, c.icon, c.title, c.desc, c.details FROM c WHERE c.date >= @cutoff",
          parameters: [{ name: "@cutoff", value: cutoffStr }],
        })
        .fetchAll();

      // Sort newest-first in application code (avoids needing a composite index)
      resources.sort((a, b) => b.date.localeCompare(a.date));

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
