import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, stat, symlink, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isPathWithin, samePath } from "./system";
import { canonicalizeMigrationPath } from "./migration-path";

export function normalizeReparseTarget(target: string): string {
  return plainReparseTarget(target).toLocaleLowerCase();
}

function plainReparseTarget(target: string): string {
  let normalized = target.replaceAll("/", "\\");
  if (/^\\\\\?\\unc\\/iu.test(normalized)) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^\\\?\?\\unc\\/iu.test(normalized)) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^(?:\\\\\?\\|\\\?\?\\)[a-z]:\\/iu.test(normalized)) normalized = normalized.slice(4);
  normalized = path.win32.normalize(normalized);
  const root = path.win32.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith("\\")) normalized = normalized.slice(0, -1);
  return normalized;
}

// Keep internal relative links relative. External relative links must retain their
// original target after moving to a different parent/drive. On rollback, absolute
// links that applications created beneath the migrated root must move back too.
export function relocatedReparseTarget(
  target: string,
  relativePath: string,
  sourceRoot: string,
  restoredRoot: string
): string {
  const normalized = plainReparseTarget(target);
  if (!path.win32.isAbsolute(normalized)) {
    const resolved = path.win32.resolve(sourceRoot, path.win32.dirname(relativePath), normalized);
    return isPathWithin(resolved, sourceRoot) ? normalized : resolved;
  }
  return isPathWithin(normalized, sourceRoot)
    ? path.win32.join(restoredRoot, path.win32.relative(sourceRoot, normalized))
    : normalized;
}

function relocatedTargetWithSourceAlias(
  target: string,
  relativePath: string,
  sourceRoot: string,
  canonicalSourceRoot: string,
  restoredRoot: string
): string {
  const normalized = plainReparseTarget(target);
  // Legacy journals can use an 8.3 parent while an application writes a link
  // using its long name. Recognize both spellings of that verified logical root;
  // do not resolve the link target through other links or require it to exist.
  const logicalSource = path.win32.isAbsolute(normalized) &&
    !isPathWithin(normalized, sourceRoot) && isPathWithin(normalized, canonicalSourceRoot)
    ? canonicalSourceRoot : sourceRoot;
  return relocatedReparseTarget(target, relativePath, logicalSource, restoredRoot);
}

export async function relocateCopiedLinks(
  source: string,
  destination: string,
  restoredRoot: string
): Promise<void> {
  const canonicalSource = await canonicalizeMigrationPath(source);
  const queue = [""];
  for (let index = 0; index < queue.length; index += 1) {
    const relativeDirectory = queue[index]!;
    for (const entry of await readdir(path.join(source, relativeDirectory), { withFileTypes: true })) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const sourcePath = path.join(source, relativePath);
      const stats = await lstat(sourcePath);
      if (stats.isSymbolicLink()) {
        const target = await readlink(sourcePath);
        const relocated = relocatedTargetWithSourceAlias(target, relativePath, source, canonicalSource, restoredRoot);
        if (normalizeReparseTarget(target) === normalizeReparseTarget(relocated)) continue;
        const targetStats = await stat(sourcePath).catch(() => {
          throw new Error(`链接目标不可访问，无法安全调整迁移后的链接：${sourcePath}`);
        });
        const copiedLink = path.join(destination, relativePath);
        if (!(await lstat(copiedLink)).isSymbolicLink()) throw new Error(`副本链接类型不一致：${copiedLink}`);
        await unlink(copiedLink);
        try {
          await symlink(relocated, copiedLink, targetStats.isDirectory() ? "dir" : "file");
        } catch (error) {
          if (!targetStats.isDirectory() || !["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await symlink(relocated, copiedLink, "junction");
        }
      } else if (stats.isDirectory()) queue.push(relativePath);
    }
  }
}

async function fileHash(candidate: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(candidate)) hash.update(chunk);
  return hash.digest("hex");
}

// Aggregate sizes cannot detect substituted files, same-length corruption, or
// writes while Robocopy is running. Verify each path and its actual contents.
export async function verifyMigrationCopy(
  source: string,
  destination: string,
  restoredRoot = source,
  options: { allowExtraDestinationEntries?: boolean; sourceRoot?: string } = {}
): Promise<void> {
  const logicalSource = options.sourceRoot ?? source;
  const canonicalSource = await canonicalizeMigrationPath(logicalSource, { allowMissingLeaf: true, allowLeafLink: true });
  const queue = [""];
  const snapshots: Array<{ source: string; destination: string; size: number; mtime: number; ctime: number; destinationMtime: number; destinationCtime: number }> = [];
  for (const root of [source, destination]) {
    const stats = await lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`副本校验需要实体目录：${root}`);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const relativeDirectory = queue[index]!;
    const [sourceEntries, destinationEntries] = await Promise.all([
      readdir(path.join(source, relativeDirectory)),
      readdir(path.join(destination, relativeDirectory))
    ]);
    sourceEntries.sort();
    destinationEntries.sort();
    if (options.allowExtraDestinationEntries
      ? sourceEntries.some((name) => !destinationEntries.includes(name))
      : sourceEntries.length !== destinationEntries.length || sourceEntries.some((name, i) => name !== destinationEntries[i])) {
      const missing = sourceEntries.filter((name) => !destinationEntries.includes(name)).slice(0, 3).join("、");
      const extra = destinationEntries.filter((name) => !sourceEntries.includes(name)).slice(0, 3).join("、");
      throw new Error(`副本目录条目不一致：${relativeDirectory || "目录根"}（缺少：${missing || "无"}；多出：${extra || "无"}）`);
    }
    for (const name of sourceEntries) {
      const relativePath = path.join(relativeDirectory, name);
      const sourcePath = path.join(source, relativePath);
      const destinationPath = path.join(destination, relativePath);
      const [sourceStat, destinationStat] = await Promise.all([lstat(sourcePath), lstat(destinationPath)]);
      if (sourceStat.isSymbolicLink()) {
        if (!destinationStat.isSymbolicLink()) throw new Error(`副本链接类型不一致：${relativePath}`);
        const [sourceTarget, destinationTarget] = await Promise.all([readlink(sourcePath), readlink(destinationPath)]);
        const expected = relocatedTargetWithSourceAlias(sourceTarget, relativePath, logicalSource, canonicalSource, restoredRoot);
        if (normalizeReparseTarget(expected) !== normalizeReparseTarget(destinationTarget) && !samePath(
          path.win32.resolve(path.win32.dirname(destinationPath), plainReparseTarget(expected)),
          path.win32.resolve(path.win32.dirname(destinationPath), plainReparseTarget(destinationTarget))
        )) throw new Error(`副本链接目标不一致：${relativePath}`);
      } else if (sourceStat.isDirectory()) {
        if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) throw new Error(`副本目录类型不一致：${relativePath}`);
        queue.push(relativePath);
      } else if (sourceStat.isFile()) {
        if (!destinationStat.isFile() || destinationStat.isSymbolicLink() || sourceStat.size !== destinationStat.size) throw new Error(`副本文件大小或类型不一致：${relativePath}`);
        if (sourceStat.nlink > 1) throw new Error(`文件包含硬链接，跨盘复制无法保持共享写入关系：${relativePath}`);
        const [sourceHash, destinationHash] = await Promise.all([fileHash(sourcePath), fileHash(destinationPath)]);
        if (sourceHash !== destinationHash) throw new Error(`副本文件内容不一致，请关闭正在写入的应用后重试：${relativePath}`);
        snapshots.push({ source: sourcePath, destination: destinationPath, size: sourceStat.size, mtime: sourceStat.mtimeMs, ctime: sourceStat.ctimeMs, destinationMtime: destinationStat.mtimeMs, destinationCtime: destinationStat.ctimeMs });
      } else throw new Error(`无法安全复制特殊文件：${relativePath}`);
    }
  }
  // A writer can modify a file after that file was hashed but before the last
  // file is checked. Check the complete set again before authorizing a switch.
  for (const snapshot of snapshots) {
    const [before, after] = await Promise.all([lstat(snapshot.source), lstat(snapshot.destination)]);
    if (!before.isFile() || !after.isFile() || before.size !== snapshot.size || after.size !== snapshot.size || before.mtimeMs !== snapshot.mtime || before.ctimeMs !== snapshot.ctime || after.mtimeMs !== snapshot.destinationMtime || after.ctimeMs !== snapshot.destinationCtime) {
      throw new Error(`校验期间目录仍被写入，请关闭关联应用后重试：${snapshot.source}`);
    }
  }
  for (const relativeDirectory of queue) {
    const [before, after] = await Promise.all([readdir(path.join(source, relativeDirectory)), readdir(path.join(destination, relativeDirectory))]);
    before.sort();
    after.sort();
    if (options.allowExtraDestinationEntries
      ? before.some((name) => !after.includes(name))
      : before.length !== after.length || before.some((name, index) => name !== after[index])) throw new Error(`校验期间目录条目发生变化：${relativeDirectory || "目录根"}`);
  }
}

export async function assertRecordedLink(source: string, destination: string): Promise<void> {
  if (!(await lstat(source)).isSymbolicLink()) throw new Error("原路径已不是迁移链接，已停止操作");
  const target = plainReparseTarget(await readlink(source));
  const resolved = path.win32.resolve(path.win32.dirname(source), target);
  const [canonicalTarget, canonicalDestination] = await Promise.all([
    canonicalizeMigrationPath(resolved, { allowMissingLeaf: true }),
    canonicalizeMigrationPath(destination, { allowMissingLeaf: true })
  ]);
  if (!samePath(canonicalTarget, canonicalDestination)) throw new Error("原路径不再指向记录中的目标，已停止操作");
}
