interface UploadProgressSnapshot {
  bytesLoaded: number;
  bytesTotal: number;
  filesTotal: number;
  succeededCount: number;
}

export function getUploadProgressPercent(
  progress: UploadProgressSnapshot,
): number {
  const ratio = progress.bytesTotal > 0
    ? progress.bytesLoaded / progress.bytesTotal
    : progress.filesTotal > 0
      ? progress.succeededCount / progress.filesTotal
      : 0;
  const boundedRatio = Math.min(1, Math.max(0, ratio));
  return boundedRatio === 1 ? 100 : Math.min(99, Math.round(boundedRatio * 100));
}
