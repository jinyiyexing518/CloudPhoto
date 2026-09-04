import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  getBlobServiceClient,
  containerName,
  generateSasUrl,
} from "../../utils/blob/blobStorage";
import {
  canAccessPhotoPath,
  isPhotoPathWithinSameScope,
} from "../../utils/auth/photoAccess";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import {
  beginPhotoCatalogMutation,
  finishPhotoCatalogMutation,
  renewPhotoCatalogMutation,
} from "../../utils/cosmos/photoCatalog";
import {
  copyBlobForMove,
  MoveDestinationChangedError,
  MoveCopyProperties,
  removeCompletedMoveDestination,
  withVerifiedCompletedMoveDestination,
} from "./movePhotoSafety";

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: number }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function isPreconditionFailed(error: unknown): boolean {
  return getStatusCode(error) === 412;
}

function isNotFound(error: unknown): boolean {
  return getStatusCode(error) === 404;
}

app.http("movePhoto", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/move",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(
      request.headers.get("authorization") ?? ""
    );
    if (!payload)
      return {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };

    try {
      const body = (await request.json()) as {
        name?: string;
        toFolder?: string;
      };
      const { name, toFolder } = body;

      if (!name || toFolder === undefined) {
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "name and toFolder are required" }),
        };
      }
      if (!await canAccessPhotoPath(name, payload, isGroupMember)) {
        return {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Forbidden" }),
        };
      }

      // Path: {scope}/{ownerId}/{folderPath...}/{filename}  (4+ segments)
      // filename is always the last segment; folderPath can span multiple segments for sub-folders
      const segs = name.split("/");
      if (segs.length < 4) {
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Invalid blob path" }),
        };
      }

      const scope = segs[0];
      const ownerId = segs[1];
      const filename = segs[segs.length - 1]; // last segment is always the file
      // Sanitise each segment of the target folder path (allow "/" as path separator)
      const safeFolderPath = toFolder
        ? toFolder
            .split("/")
            .map((seg) => seg.replace(/[\\\0<>"|?*:]/g, "_").trim())
            .filter(Boolean)
            .join("/")
        : "_";
      const newBlobName = `${scope}/${ownerId}/${safeFolderPath}/${filename}`;
      if (!isPhotoPathWithinSameScope(name, newBlobName)) {
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Invalid destination folder" }),
        };
      }

      if (newBlobName === name) {
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newName: name }),
        };
      }

      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      const sourceBlob = containerClient.getBlockBlobClient(name);
      const destBlob = containerClient.getBlockBlobClient(newBlobName);

      const sourceProps = await sourceBlob.getProperties();
      const sourceEtag = sourceProps.etag;
      if (!sourceEtag) {
        throw new Error("Photo move source is missing an ETag");
      }
      const catalogScope = name.split("/").slice(0, 2).join("/");
      const catalogMutation = await beginPhotoCatalogMutation(
        catalogScope,
        [name, newBlobName],
      );

      try {
      // Server-side copy using a short-lived SAS on the source blob
      const sourceSasUrl = await generateSasUrl(name, 1);
      const completedCopy = await copyBlobForMove({
        destinationBlob: destBlob,
        sourceUrl: sourceSasUrl,
        sourceEtag,
        sourceMetadata: sourceProps.metadata,
        renewCatalogMutation: () => renewPhotoCatalogMutation(catalogMutation),
      });

      const conflictResponse = async (
        error: string,
        completed: MoveCopyProperties,
      ): Promise<HttpResponseInit> => {
        try {
          await removeCompletedMoveDestination({
            destinationBlob: destBlob,
            completedCopy: completed,
            renewCatalogMutation: () => renewPhotoCatalogMutation(catalogMutation),
          });
          return {
            status: 409,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error }),
          };
        } catch (cleanupError) {
          context.error(
            "Photo move conflict left a destination that requires recovery:",
            cleanupError,
          );
          return {
            status: 409,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              error: "Move conflict requires destination recovery before retry",
              code: "move-destination-recovery-required",
            }),
          };
        }
      };

      // Remove the original blob
      try {
        await withVerifiedCompletedMoveDestination({
          destinationBlob: destBlob,
          completedCopy,
          renewCatalogMutation: () => renewPhotoCatalogMutation(catalogMutation),
          onLeaseReleaseError: (error) => {
            context.error("Photo move destination lease release failed:", error);
          },
          operation: async (abortSignal) => {
            await renewPhotoCatalogMutation(catalogMutation);
            try {
              return await sourceBlob.deleteIfExists({
                abortSignal,
                conditions: { ifMatch: sourceEtag },
              });
            } catch (error) {
              if (isNotFound(error)) return { succeeded: false };
              throw error;
            }
          },
        });
      } catch (e) {
        if (isPreconditionFailed(e)) {
          const response = await conflictResponse(
            "Photo changed during move, please retry",
            completedCopy,
          );
          return response;
        }
        if (e instanceof MoveDestinationChangedError || getStatusCode(e) === 409) {
          context.error("Photo move destination could not be secured:", e);
          return {
            status: 409,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              error: "Move destination requires recovery before retry",
              code: "move-destination-recovery-required",
            }),
          };
        }
        throw e;
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: newBlobName }),
      };
      } finally {
        try {
          await finishPhotoCatalogMutation(catalogMutation);
        } catch (error) {
          context.error("Photo catalog finalization failed after move:", error);
        }
      }
    } catch (error) {
      if (isPreconditionFailed(error)) {
        return {
          status: 409,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Move conflict detected, please retry" }),
        };
      }
      context.error("Move photo error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Move failed" }),
      };
    }
  },
});
