import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from "@azure/storage-blob";

export const accountName =
  process.env.STORAGE_ACCOUNT_NAME || "photostorage";
export const accountKey = process.env.STORAGE_ACCOUNT_KEY as string;
export const containerName =
  process.env.STORAGE_CONTAINER_NAME || "photos";

export function getCredential(): StorageSharedKeyCredential {
  return new StorageSharedKeyCredential(accountName, accountKey);
}

export function getBlobServiceClient(): BlobServiceClient {
  return new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    getCredential()
  );
}

export function generateSasUrl(blobName: string, expiryHours = 2): string {
  const credential = getCredential();
  const expiresOn = new Date();
  expiresOn.setHours(expiresOn.getHours() + expiryHours);

  const sasParams = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn,
    },
    credential
  );

  return `https://${accountName}.blob.core.windows.net/${containerName}/${encodeURIComponent(blobName)}?${sasParams}`;
}
