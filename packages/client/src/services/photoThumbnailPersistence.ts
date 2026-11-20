const pendingVideoThumbnailPersistence = new Set<string>();
const videoThumbnailPersistenceListeners = new Set<
  (blobName: string, pending: boolean, thumbnailUrl?: string) => void
>();
const videoThumbnailResultListeners = new Set<
  (blobName: string, thumbnailUrl: string) => void
>();

export function markVideoThumbnailPersistencePending(
  blobName: string,
  pending: boolean,
  thumbnailUrl?: string,
): void {
  if (pending) pendingVideoThumbnailPersistence.add(blobName);
  else pendingVideoThumbnailPersistence.delete(blobName);
  for (const listener of videoThumbnailPersistenceListeners) {
    listener(blobName, pending, thumbnailUrl);
  }
}

export const markPhotoThumbnailPersistencePending =
  markVideoThumbnailPersistencePending;

export function isVideoThumbnailPersistencePending(blobName: string): boolean {
  return pendingVideoThumbnailPersistence.has(blobName);
}

export function subscribeToVideoThumbnailPersistence(
  listener: (blobName: string, pending: boolean, thumbnailUrl?: string) => void,
): () => void {
  videoThumbnailPersistenceListeners.add(listener);
  return () => videoThumbnailPersistenceListeners.delete(listener);
}

export function subscribeToVideoThumbnailResults(
  listener: (blobName: string, thumbnailUrl: string) => void,
): () => void {
  videoThumbnailResultListeners.add(listener);
  return () => videoThumbnailResultListeners.delete(listener);
}

export const subscribeToPhotoThumbnailResults =
  subscribeToVideoThumbnailResults;

export function publishPhotoThumbnailResult(
  blobName: string,
  thumbnailUrl: string,
): void {
  for (const listener of videoThumbnailResultListeners) {
    listener(blobName, thumbnailUrl);
  }
}
