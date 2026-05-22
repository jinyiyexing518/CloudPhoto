"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const functions_1 = require("@azure/functions");
const blobStorage_1 = require("../utils/blobStorage");
functions_1.app.http("listPhotos", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "photos",
    handler: async (_request, context) => {
        try {
            const blobServiceClient = (0, blobStorage_1.getBlobServiceClient)();
            const containerClient = blobServiceClient.getContainerClient(blobStorage_1.containerName);
            await containerClient.createIfNotExists();
            const photos = [];
            for await (const blob of containerClient.listBlobsFlat()) {
                photos.push({
                    name: blob.name,
                    url: (0, blobStorage_1.generateSasUrl)(blob.name),
                    size: blob.properties.contentLength,
                    lastModified: blob.properties.lastModified,
                    contentType: blob.properties.contentType,
                });
            }
            photos.sort((a, b) => {
                const timeA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
                const timeB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
                return timeB - timeA;
            });
            return {
                status: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(photos),
            };
        }
        catch (error) {
            context.error("List photos error:", error);
            return {
                status: 500,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Failed to list photos" }),
            };
        }
    },
});
//# sourceMappingURL=listPhotos.js.map