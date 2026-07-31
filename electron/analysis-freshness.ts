import type { AnalysisSnapshot } from "./types";

export interface CurrentDirectoryMetrics {
  totalBytes: number;
  fileCount: number;
  directoryCount: number;
}

export function hasSignificantAnalysisChange(
  snapshot: AnalysisSnapshot,
  current: CurrentDirectoryMetrics
): boolean {
  const bytesChanged = Math.abs(current.totalBytes - snapshot.totalBytes);
  const filesChanged = Math.abs(current.fileCount - snapshot.fileCount);
  const directoriesChanged = Math.abs(
    current.directoryCount - snapshot.directoryCount
  );
  return (
    bytesChanged > Math.max(64 * 1024 ** 2, snapshot.totalBytes * 0.1) ||
    filesChanged > Math.max(100, snapshot.fileCount * 0.1) ||
    directoriesChanged > Math.max(20, snapshot.directoryCount * 0.1)
  );
}
