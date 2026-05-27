import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  UserDelegationKey,
} from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

export const accountName =
  process.env.STORAGE_ACCOUNT_NAME || "photostorage";
export const containerName =
  process.env.STORAGE_CONTAINER_NAME || "photos";

// Single credential instance reused across the process lifetime.
// On Azure Functions: uses the Function App's System-assigned Managed Identity.
// Locally: falls back to Azure CLI credentials (az login).
const credential = new DefaultAzureCredential();

export function getBlobServiceClient(): BlobServiceClient {
  return new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential
  );
}

/**
 * Fetches a User Delegation Key from Azure Storage.
 * One call per request is sufficient — pass the result to generateSasUrlWithKey()
 * for each blob to avoid repeated network round-trips.
 *
 * Required Azure role: "Storage Blob Delegator" on the Storage Account.
 */
export async function getUserDelegationKey(expiryHours = 2): Promise<UserDelegationKey> {
  const client = getBlobServiceClient();
  // 5-minute back-date to absorb clock-skew between Azure nodes
  const startsOn = new Date(Date.now() - 5 * 60 * 1000);
  const expiresOn = new Date(Date.now() + expiryHours * 3600 * 1000);
  return client.getUserDelegationKey(startsOn, expiresOn);
}

/**
 * Synchronous SAS generation once a delegation key is already in hand.
 * Use this inside loops (e.g. listPhotos) to avoid fetching a new key per blob.
 */
export function generateSasUrlWithKey(
  blobName: string,
  delegationKey: UserDelegationKey,
  expiryHours = 2
): string {
  const startsOn = new Date(Date.now() - 5 * 60 * 1000);
  const expiresOn = new Date(Date.now() + expiryHours * 3600 * 1000);
  const sasParams = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      startsOn,
      expiresOn,
    },
    delegationKey,
    accountName
  );
  // Encode each path segment separately to preserve virtual-directory slashes
  const encodedPath = blobName.split("/").map(encodeURIComponent).join("/");
  return `https://${accountName}.blob.core.windows.net/${containerName}/${encodedPath}?${sasParams}`;
}

/** Convenience async wrapper for single-blob callers (upload, move, etc.). */
export async function generateSasUrl(blobName: string, expiryHours = 2): Promise<string> {
  const key = await getUserDelegationKey(expiryHours);
  return generateSasUrlWithKey(blobName, key, expiryHours);
}
