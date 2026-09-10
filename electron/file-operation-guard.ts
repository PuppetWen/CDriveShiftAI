import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathWithin, protectedReason } from "./system";
import type { MigrationRecord } from "./types";

const terminalStages = new Set<MigrationRecord["stage"]>(["rolled-back", "failed"]);

export function migrationRecordDeletionReason(record: MigrationRecord): string | undefined {
  if (!terminalStages.has(record.stage)) return "请先将该迁移恢复到原位置，再删除记录";
  if (record.backupPath || record.restorePath || record.stagingPath) {
    return "该记录仍包含恢复或清理路径，处理完成前不能删除";
  }
  return undefined;
}

export function migrationPathMutationReason(candidate: string, records: MigrationRecord[]): string | undefined {
  for (const record of records) {
    const live = !terminalStages.has(record.stage);
    const protectedPaths = [
      ...(live ? [record.source, record.destination] : []),
      record.backupPath, record.restorePath, record.stagingPath
    ].filter((value): value is string => Boolean(value));
    if (protectedPaths.some((value) => isPathWithin(candidate, value) || isPathWithin(value, candidate))) {
      return `该路径属于迁移或恢复事务，直接删除或重命名会导致应用不可用：${record.source}。请先在迁移历史中恢复。`;
    }
  }
  return undefined;
}

export async function assertNoMigrationPathMutation(candidate: string, records: MigrationRecord[], protectedPaths: readonly string[] = []): Promise<void> {
  const protection = protectedReason(candidate);
  if (protection) throw new Error(protection);
  const reason = migrationPathMutationReason(candidate, records);
  if (reason) throw new Error(reason);
  // Resolve ancestors, but do not follow a final link: deleting a standalone
  // link removes that link, whereas traversing a parent junction edits its target.
  const parent = await realpath(path.dirname(candidate));
  const resolved = path.join(parent, path.basename(candidate));
  const resolvedProtection = protectedReason(resolved);
  if (resolvedProtection) throw new Error(resolvedProtection);
  for (const protectedPath of protectedPaths) {
    const canonical = await realpath(protectedPath);
    if ([candidate, resolved].some((value) => [protectedPath, canonical].some((root) => isPathWithin(value, root) || isPathWithin(root, value)))) {
      throw new Error("不能删除或重命名 CDriveShiftAI 当前程序或数据所在目录");
    }
  }
  const aliases = await Promise.all(records.filter((record) => !terminalStages.has(record.stage) || record.backupPath || record.restorePath || record.stagingPath).map(async (record) => {
    const resolve = async (value?: string) => {
      if (!value) return value;
      return path.join(await realpath(path.dirname(value)).catch(() => path.dirname(value)), path.basename(value));
    };
    return { ...record, source: (await resolve(record.source))!, destination: (await resolve(record.destination))!,
      backupPath: await resolve(record.backupPath), restorePath: await resolve(record.restorePath), stagingPath: await resolve(record.stagingPath) };
  }));
  const resolvedReason = migrationPathMutationReason(resolved, aliases);
  if (resolvedReason) throw new Error(resolvedReason);
}

export async function assertRenameDestinationAvailable(source: string, destination: string): Promise<void> {
  if (source.toLowerCase() === destination.toLowerCase()) return;
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`目标名称已存在，不能覆盖：${destination}`);
}
