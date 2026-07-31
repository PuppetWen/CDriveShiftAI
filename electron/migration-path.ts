import path from "node:path";

export function migrationDestinationFor(
  source: string,
  destinationBase: string
): string {
  const directoryName = path.win32.basename(source.replace(/[\\/]+$/, ""));
  if (!directoryName) {
    throw new Error("无法从源路径确定目标目录名称");
  }
  return path.win32.join(destinationBase, directoryName);
}
