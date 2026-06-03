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
  seq?: number;
  _ts?: number;
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
            "SELECT c.id, c.date, c.icon, c.title, c.desc, c.details, c.type, c.seq, c._ts FROM c WHERE c.date >= @cutoff",
          parameters: [{ name: "@cutoff", value: cutoffStr }],
        })
        .fetchAll();

      // Sort newest-first by date, then by seq (stable creation timestamp written
      // into each change file) within the same date.  Fall back to id alphabetical
      // for old entries that pre-date the seq field, and finally to _ts.
      resources.sort((a, b) => {
        const dateCmp = b.date.localeCompare(a.date);
        if (dateCmp !== 0) return dateCmp;
        // seq present on both → use it
        if (a.seq != null && b.seq != null) return b.seq - a.seq;
        // seq present on one side only → seq'd entry sorts first (it's newer)
        if (a.seq != null) return 1;
        if (b.seq != null) return -1;
        // neither has seq → fall back to _ts, then id
        const tsCmp = (b._ts ?? 0) - (a._ts ?? 0);
        if (tsCmp !== 0) return tsCmp;
        return b.id.localeCompare(a.id);
      });

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
