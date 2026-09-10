import path from "node:path";

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
