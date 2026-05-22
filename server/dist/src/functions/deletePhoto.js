"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const functions_1 = require("@azure/functions");
const blobStorage_1 = require("../utils/blobStorage");
functions_1.app.http("deletePhoto", {
    methods: ["DELETE"],
    authLevel: "anonymous",
    route: "photos/{name}",
    handler: async (request, context) => {
        const blobName = request.params["name"];
        if (!blobName) {
            return {
                status: 400,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Photo name is required" }),
            };
        }
        try {
            const blobServiceClient = (0, blobStorage_1.getBlobServiceClient)();
            const containerClient = blobServiceClient.getContainerClient(blobStorage_1.containerName);
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            await blockBlobClient.deleteIfExists();
            return {
                status: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: "Photo deleted successfully" }),
            };
        }
        catch (error) {
            context.error("Delete error:", error);
            return {
                status: 500,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Failed to delete photo" }),
            };
        }
    },
});
//# sourceMappingURL=deletePhoto.js.map