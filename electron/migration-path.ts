import path from "node:path";
import { lstat, realpath } from "node:fs/promises";

export function normalizeMigrationPath(input: string): string {
  const value = input.trim().replaceAll("/", "\\");
  if (!/^[a-z]:\\/iu.test(value) || /[\u0000-\u001f<>"|?*]/u.test(value) || value.slice(2).includes(":")) {
    throw new Error("迁移路径必须是本地磁盘的完整绝对路径");
  }
  const parts = value.slice(3).split("\\").filter(Boolean);
  if (parts.some((part) => /[. ]$/u.test(part) && part !== "." && part !== "..")) throw new Error("迁移路径不能包含以点或空格结尾的目录名");
  const normalized = path.win32.normalize(value);
  return normalized.length > 3 ? normalized.replace(/\\+$/u, "") : normalized;
}

// realpath expands ordinary NTFS 8.3 names as well as following reparse points.
// Check each entry before expanding its name, so a short name is accepted without
// accepting a junction, a symlink, or a drive redirected by SUBST.
export async function canonicalizeMigrationPath(
  input: string,
  options: { allowMissingLeaf?: boolean; allowLeafLink?: boolean } = {}
): Promise<string> {
  const normalized = normalizeMigrationPath(input);
  const root = path.win32.parse(normalized).root;
  const equal = (left: string, right: string) => left.toLocaleLowerCase() === right.toLocaleLowerCase();
  const rootStats = await lstat(root);
  let current = normalizeMigrationPath(await realpath(root));
  if (rootStats.isSymbolicLink() || !equal(current, root)) {
    throw new Error(`路径的磁盘根目录已被重定向，请直接选择实际路径：${input}`);
  }
  const parts = normalized.slice(root.length).split("\\").filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const candidate = path.win32.join(current, parts[index]!);
    const last = index === parts.length - 1;
    let stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      if (last && options.allowMissingLeaf && (error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      if (last && options.allowLeafLink) return candidate;
      throw new Error(`路径包含目录联接或符号链接，请直接选择实际路径：${candidate}`);
    }
    if (!last && !stats.isDirectory()) throw new Error(`路径的父级不是目录：${candidate}`);
    const resolved = normalizeMigrationPath(await realpath(candidate));
    if (!equal(path.win32.dirname(resolved), current)) {
      throw new Error(`路径的父目录已被重定向，请直接选择实际路径：${candidate}`);
    }
    current = resolved;
  }
  return current;
}

export function migrationDestinationFor(
  source: string,
  destinationBase: string
): string {
  const normalizedSource = normalizeMigrationPath(source);
  const directoryName = path.win32.basename(normalizedSource);
  if (!directoryName || normalizedSource === path.win32.parse(normalizedSource).root) {
    throw new Error("无法从源路径确定目标目录名称");
  }
  return path.win32.join(normalizeMigrationPath(destinationBase), directoryName);
}
