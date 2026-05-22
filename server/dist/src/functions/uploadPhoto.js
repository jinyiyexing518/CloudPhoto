"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const functions_1 = require("@azure/functions");
const blobStorage_1 = require("../utils/blobStorage");
functions_1.app.http("uploadPhoto", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "photos/upload",
    handler: async (request, context) => {
        try {
            const filename = request.query.get("filename") ?? `photo-${Date.now()}.jpg`;
            const contentType = request.headers.get("content-type") ?? "image/jpeg";
            const sanitizedName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
            const blobName = `${Date.now()}-${sanitizedName}`;
            const blobServiceClient = (0, blobStorage_1.getBlobServiceClient)();
            const containerClient = blobServiceClient.getContainerClient(blobStorage_1.containerName);
            await containerClient.createIfNotExists();
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            const arrayBuffer = await request.arrayBuffer();
            await blockBlobClient.uploadData(Buffer.from(arrayBuffer), {
                blobHTTPHeaders: { blobContentType: contentType },
            });
            return {
                status: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: blobName,
                    url: (0, blobStorage_1.generateSasUrl)(blobName),
                    size: arrayBuffer.byteLength,
                    contentType,
                }),
            };
        }
        catch (error) {
            context.error("Upload error:", error);
            return {
                status: 500,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Upload failed" }),
            };
        }
    },
});
//# sourceMappingURL=uploadPhoto.js.map