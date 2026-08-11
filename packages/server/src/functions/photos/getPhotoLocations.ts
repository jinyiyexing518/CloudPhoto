import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember, getPhotoLocationsContainer, PhotoLocationDoc } from "../../utils/cosmos/cosmosClient";

interface LocationItem {
  name: string;
  lat: number;
  lon: number;
  sourceBlobEtag?: string;
  originalName?: string;
  contentType?: string;
}

/**
 * GET /api/photos/locations[?groupId=...]
 *
 * Returns GPS-tagged photo coordinates from the Cosmos `photoLocations` cache.
 * Much faster than full blob listing — O(1) indexed Cosmos query.
 *
 * Response: LocationItem[]  (no SAS URLs — caller cross-references with /photos for thumbnails)
 */
app.http("getPhotoLocations", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/locations",
  handler: async (
    req: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(req.headers.get("authorization") ?? "");
    if (!payload) {
      return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const groupId = req.query.get("groupId") ?? "";

    // Verify group membership
    if (groupId && !(await isGroupMember(groupId, payload.userId))) {
      return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not a member of this group" }) };
    }

    try {
      const container = await getPhotoLocationsContainer();

      let items: LocationItem[] = [];

      if (groupId) {
        // Group photos: query by scope = "groups/{groupId}"
        const scope = `groups/${groupId}`;
        const { resources } = await container.items
          .query<PhotoLocationDoc>({
            query: "SELECT c.name, c.lat, c.lon, c.sourceBlobEtag, c.originalName, c.contentType FROM c WHERE c.scope = @scope",
            parameters: [{ name: "@scope", value: scope }],
          })
          .fetchAll();
        items = resources;
      } else if (payload.role === "admin") {
        // Admin: all personal photos (cross-partition query)
        const { resources } = await container.items
          .query<PhotoLocationDoc>(
            {
              query: "SELECT c.name, c.lat, c.lon, c.sourceBlobEtag, c.originalName, c.contentType FROM c WHERE STARTSWITH(c.scope, 'personal/')",
            }
          )
          .fetchAll();
        items = resources;
      } else {
        // Personal photos: query by scope = "personal/{userId}"
        const scope = `personal/${payload.userId}`;
        const { resources } = await container.items
          .query<PhotoLocationDoc>({
            query: "SELECT c.name, c.lat, c.lon, c.sourceBlobEtag, c.originalName, c.contentType FROM c WHERE c.scope = @scope",
            parameters: [{ name: "@scope", value: scope }],
          })
          .fetchAll();
        items = resources;
      }

      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=60",
        },
        body: JSON.stringify(items),
      };
    } catch (error) {
      context.error("getPhotoLocations error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Failed to fetch locations" }) };
    }
  },
});
