"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.containerName = exports.accountKey = exports.accountName = void 0;
exports.getCredential = getCredential;
exports.getBlobServiceClient = getBlobServiceClient;
exports.generateSasUrl = generateSasUrl;
const storage_blob_1 = require("@azure/storage-blob");
exports.accountName = process.env.STORAGE_ACCOUNT_NAME || "photostorage";
exports.accountKey = process.env.STORAGE_ACCOUNT_KEY;
exports.containerName = process.env.STORAGE_CONTAINER_NAME || "photos";
function getCredential() {
    return new storage_blob_1.StorageSharedKeyCredential(exports.accountName, exports.accountKey);
}
function getBlobServiceClient() {
    return new storage_blob_1.BlobServiceClient(`https://${exports.accountName}.blob.core.windows.net`, getCredential());
}
function generateSasUrl(blobName, expiryHours = 2) {
    const credential = getCredential();
    const expiresOn = new Date();
    expiresOn.setHours(expiresOn.getHours() + expiryHours);
    const sasParams = (0, storage_blob_1.generateBlobSASQueryParameters)({
        containerName: exports.containerName,
        blobName,
        permissions: storage_blob_1.BlobSASPermissions.parse("r"),
        expiresOn,
    }, credential);
    return `https://${exports.accountName}.blob.core.windows.net/${exports.containerName}/${encodeURIComponent(blobName)}?${sasParams}`;
}
//# sourceMappingURL=blobStorage.js.map