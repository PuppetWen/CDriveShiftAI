import type { DirectoryDialogPurpose } from "./types";

export const DIRECTORY_DIALOG_PURPOSES = new Set<DirectoryDialogPurpose>([
  "migration-source",
  "migration-destination",
  "analysis",
  "search-scope",
  "content-index",
  "copy-destination",
  "general"
]);

export function normalizeDirectoryDialogPurpose(value: unknown): DirectoryDialogPurpose {
  return typeof value === "string" && DIRECTORY_DIALOG_PURPOSES.has(value as DirectoryDialogPurpose)
    ? (value as DirectoryDialogPurpose)
    : "general";
}

export function sanitizeDirectoryDialogPaths(
  value: unknown
): Partial<Record<DirectoryDialogPurpose, string>> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const result: Partial<Record<DirectoryDialogPurpose, string>> = {};
  for (const purpose of DIRECTORY_DIALOG_PURPOSES) {
    const candidate = input[purpose];
    if (typeof candidate === "string" && candidate.trim()) {
      result[purpose] = candidate.trim().slice(0, 32_768);
    }
  }
  return result;
}
