import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { summarizeDirectory } from "./analyzer";
import { hasSignificantAnalysisChange } from "./analysis-freshness";
import { canonicalizeMigrationPath, migrationDestinationFor, normalizeMigrationPath } from "./migration-path";
import type { AppStore } from "./store";
import type { MigrationRecord, PreflightResult } from "./types";
import { assertRecordedLink, relocateCopiedLinks, verifyMigrationCopy } from "./migration-copy";
import { copyMigrationPermissions } from "./migration-permissions";
export { normalizeReparseTarget } from "./migration-copy";
import {
  isHighRiskApplicationPath,
  getDriveInfo,
  isPathWithin,
  normalizeWindowsPath,
  protectedReason,
  samePath
} from "./system";

type ProgressHandler = (record: MigrationRecord, message: string) => void;

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const RENAME_RETRY_DELAYS_MS = [150, 300, 600, 1_000, 1_500, 2_000] as const;

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function entryExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalProtectionPath(candidate: string): Promise<string> {
  let current = normalizeMigrationPath(candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.win32.join(normalizeMigrationPath(await realpath(current)), ...missing);
    } catch (error) {
      const parent = path.win32.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || samePath(parent, current)) throw error;
      missing.unshift(path.win32.basename(current));
      current = parent;
    }
  }
}

export async function renameWithRetry(
  source: string,
  destination: string,
  options: {
    operation?: string;
    retryDelaysMs?: readonly number[];
    renameEntry?: typeof rename;
    destinationExists?: (candidate: string) => Promise<boolean>;
    wait?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<void> {
  const operation = options.operation ?? "目录切换";
  const retryDelaysMs = options.retryDelaysMs ?? RENAME_RETRY_DELAYS_MS;
  const renameEntry = options.renameEntry ?? rename;
  const destinationExists = options.destinationExists ?? entryExists;
  const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));

  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameEntry(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      if (!TRANSIENT_RENAME_CODES.has(code)) throw error;
      if (await destinationExists(destination)) {
        throw new Error(`${operation}失败：目标路径在迁移期间已被其他程序创建：${destination}`);
      }
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) {
        throw new Error(
          `${operation}失败：Windows 持续拒绝重命名（${code}）。` +
          "请关闭关联程序、资源管理器窗口、同步工具或实时防护后重试。"
        );
      }
      await wait(delay);
    }
  }
}

async function availableBytes(candidate: string): Promise<number> {
  const root = path.parse(candidate).root;
  const stats = await statfs(root);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function migrationRobocopyArguments(source: string, destination: string): string[] {
  return [
    source,
    destination,
    "/E",
    "/COPY:DATS",
    "/SECFIX",
    "/DCOPY:DAT",
    "/R:2",
    "/W:1",
    "/SJ",
    "/SL",
    "/MT:16",
    "/NP",
    "/NJH",
    "/NJS",
    "/NFL",
    "/NDL"
  ];
}

function robocopyPass(source: string, destination: string, dataOnly = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const argumentsList = migrationRobocopyArguments(source, destination);
    execFile(
      "robocopy.exe",
      dataOnly ? argumentsList.filter((argument) => argument !== "/SECFIX").map((argument) => argument === "/COPY:DATS" ? "/COPY:DAT" : argument) : argumentsList,
      {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 24 * 60 * 60_000
      },
      (error, stdout, stderr) => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? 16 : 0;
        // Robocopy can report an ACL error and still return 0 when it fails
        // before enumerating the root. The hexadecimal Win32 error is present
        // in localized output too; neither exit code nor empty totals suffice.
        const reportedError = /\(0x[0-9a-f]{8}\)/iu.test(`${stdout}\n${stderr}`);
        if (exitCode < 8 && !reportedError) resolve();
        else {
          reject(
            new Error(
              `Robocopy 复制失败（代码 ${exitCode}）：${(stderr || stdout || error?.message || "")
                .trim()
                .slice(-1200)}`
            )
          );
        }
      }
    );
  });
}

export async function runRobocopy(source: string, destination: string): Promise<void> {
  try {
    await robocopyPass(source, destination);
  } catch (error) {
    if (!/\(0x00000005\)/iu.test(error instanceof Error ? error.message : String(error))) throw error;
    await robocopyPass(source, destination, true);
    await copyMigrationPermissions(source, destination);
  }
}

async function removeTreeAtExactPath(candidate: string, expectedParent: string): Promise<void> {
  const normalized = normalizeWindowsPath(candidate);
  const parent = await canonicalizeMigrationPath(expectedParent);
  const candidateParent = await canonicalizeMigrationPath(path.dirname(normalized));
  if (!samePath(candidateParent, parent)) {
    throw new Error(`拒绝清理未验证路径：${normalized}`);
  }
  if (samePath(normalized, path.parse(normalized).root)) {
    throw new Error(`拒绝清理经过目录联接或根目录的路径：${normalized}`);
  }
  const canonical = await canonicalizeMigrationPath(normalized);
  if (!samePath(path.dirname(canonical), parent)) throw new Error(`拒绝清理未验证路径：${normalized}`);
  await rm(canonical, { recursive: true, force: false, maxRetries: 2, retryDelay: 250 });
}

export class MigrationService {
  private activeOperation?: Promise<unknown>;

  constructor(
    private readonly store: AppStore,
    private readonly onProgress: ProgressHandler,
    private readonly options: {
      protectedPaths?: readonly string[];
      copy?: typeof runRobocopy;
      removeTree?: typeof removeTreeAtExactPath;
      renameEntry?: typeof renameWithRetry;
    } = {}
  ) {}

  private copy(source: string, destination: string): Promise<void> {
    return (this.options.copy ?? runRobocopy)(source, destination);
  }

  private removeTree(candidate: string, parent: string): Promise<void> {
    return (this.options.removeTree ?? removeTreeAtExactPath)(candidate, parent);
  }

  private renameEntry(source: string, destination: string, operation: string): Promise<void> {
    return (this.options.renameEntry ?? renameWithRetry)(source, destination, { operation });
  }

  private async protectedPaths(): Promise<string[]> {
    const configured = this.options.protectedPaths ?? [];
    return [...configured, ...await Promise.all(configured.map(canonicalProtectionPath))];
  }

  isBusy(): boolean {
    return Boolean(this.activeOperation);
  }

  async whenIdle(): Promise<void> {
    await this.activeOperation?.catch(() => undefined);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeOperation) throw new Error("已有迁移或恢复操作正在执行，请等待完成后重试");
    const pending = Promise.resolve().then(operation);
    this.activeOperation = pending;
    try {
      return await pending;
    } finally {
      this.activeOperation = undefined;
    }
  }

  async preflight(sourceInput: string, destinationBaseInput: string): Promise<PreflightResult> {
    const base = await this.preflightCore(sourceInput, destinationBaseInput);
    let normalizedSource: string;
    try {
      normalizedSource = normalizeMigrationPath(sourceInput);
    } catch {
      return {
        ...base,
        analysisStatus: "not-analyzed",
        analysisMessage: "路径格式无效，无法读取已保存的目录分析。",
        reanalysisRecommended: true
      };
    }

    const saved = this.store.getAnalysis(normalizedSource);
    const sourceExists = await exists(normalizedSource);
    if (!sourceExists) {
      return {
        ...base,
        analysisStatus: "source-missing",
        analysisMessage: saved
          ? "上次分析的目录当前已找不到，可能已被移动、删除或改名。请重新选择并再次分析。"
          : "源目录当前不存在，无法分析或迁移。",
        reanalysisRecommended: true,
        lastAnalyzedAt: saved?.snapshot.analyzedAt
      };
    }
    if (saved) {
      const ranks = { low: 0, medium: 1, high: 2, blocked: 3 } as const;
      if (ranks[saved.risk] > ranks[base.risk]) base.risk = saved.risk;
      base.warnings = [
        ...new Set([
          saved.riskReason,
          `已保存分析：${saved.purpose}${
            saved.producedBy ? `（${saved.producedBy}）` : ""
          }`,
          ...base.warnings
        ])
      ];
      if (saved.risk === "blocked") {
        base.allowed = false;
        base.blockers = [
          ...new Set([
            "已保存的目录归属分析判定该路径禁止迁移。",
            ...base.blockers
          ])
        ];
      }
    }
    if (!saved) {
      return {
        ...base,
        analysisStatus: "not-analyzed",
        analysisMessage: "该目录尚无已保存的归属分析，建议先分析再迁移。",
        reanalysisRecommended: true
      };
    }
    if (
      base.blockers.length > 0 &&
      base.requiredBytes === 0 &&
      base.fileCount === 0 &&
      base.directoryCount === 0
    ) {
      return {
        ...base,
        analysisStatus: "current",
        analysisMessage:
          "上次分析仍已保存；当前预检因其他阻止项未扫描源目录，因此未判断目录变化。",
        reanalysisRecommended: false,
        lastAnalyzedAt: saved.snapshot.analyzedAt
      };
    }

    const snapshot = saved.snapshot;
    const significantChange = hasSignificantAnalysisChange(snapshot, {
      totalBytes: base.requiredBytes,
      fileCount: base.fileCount,
      directoryCount: base.directoryCount
    });
    return {
      ...base,
      analysisStatus: significantChange ? "changed" : "current",
      analysisMessage: significantChange
        ? "目录与上次保存的分析相比变化较大，归属、用途或迁移风险可能已经改变。建议重新分析。"
        : "目录规模与上次保存的分析基本一致。",
      reanalysisRecommended: significantChange,
      lastAnalyzedAt: snapshot.analyzedAt
    };
  }

  private async preflightCore(sourceInput: string, destinationBaseInput: string): Promise<PreflightResult> {
    const blockers: string[] = [];
    const warnings: string[] = [];
    let source: string;
    let destinationBase: string;

    try {
      source = normalizeMigrationPath(sourceInput);
      destinationBase = normalizeMigrationPath(destinationBaseInput);
      migrationDestinationFor(source, destinationBase);
    } catch {
      return {
        allowed: false,
        source: sourceInput,
        destinationBase: destinationBaseInput,
        finalDestination: "",
        requiredBytes: 0,
        availableBytes: 0,
        fileCount: 0,
        directoryCount: 0,
        reparsePointCount: 0,
        risk: "blocked",
        warnings,
        blockers: ["路径格式无效"]
      };
    }

    try {
      source = await canonicalizeMigrationPath(source, { allowMissingLeaf: true });
      destinationBase = await canonicalizeMigrationPath(destinationBase, { allowMissingLeaf: true });
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    const finalDestination = migrationDestinationFor(source, destinationBase);
    const protectedPaths = await this.protectedPaths();
    const protection = protectedReason(source);
    if (protection) blockers.push(protection);
    if (protectedPaths.some((candidate) => isPathWithin(candidate, source) || isPathWithin(source, candidate))) {
      blockers.push("不能迁移本程序的运行目录、配置数据目录或其父子目录");
    }
    if (protectedPaths.some((candidate) => isPathWithin(candidate, finalDestination) || isPathWithin(finalDestination, candidate))) {
      blockers.push("迁移目标不能位于本程序的运行或配置数据目录，也不能包含这些目录");
    }
    if (path.parse(source).root.toLocaleLowerCase() === path.parse(destinationBase).root.toLocaleLowerCase()) {
      blockers.push("目标目录必须位于其他磁盘，否则无法释放源盘空间");
    }
    if (isPathWithin(destinationBase, source) || isPathWithin(source, destinationBase)) {
      blockers.push("源目录和目标目录不能互相包含");
    }
    if (!(await exists(source))) blockers.push("源目录不存在");
    if (!(await exists(destinationBase))) blockers.push("目标基础目录不存在");
    if (await entryExists(finalDestination)) blockers.push(`目标位置已存在：${finalDestination}`);

    let requiredBytes = 0;
    let fileCount = 0;
    let directoryCount = 0;
    let reparsePointCount = 0;
    let free = 0;
    if (blockers.length === 0) {
      const stats = await lstat(source);
      if (!stats.isDirectory()) blockers.push("源路径不是目录");
      if (stats.isSymbolicLink()) blockers.push("源目录已经是符号链接或目录联接");
      const destinationStats = await lstat(destinationBase);
      if (!destinationStats.isDirectory()) blockers.push("目标基础路径不是目录");
      for (const candidate of [source, destinationBase]) await canonicalizeMigrationPath(candidate);
      const targetProtection = protectedReason(destinationBase);
      if (targetProtection && !samePath(destinationBase, path.parse(destinationBase).root)) blockers.push(`目标位置不安全：${targetProtection}`);
      const [sourceDrive, destinationDrive] = await Promise.all([
        getDriveInfo(path.parse(source).root), getDriveInfo(path.parse(destinationBase).root)
      ]);
      if ([sourceDrive, destinationDrive].some((drive) => drive.fileSystem.toUpperCase() !== "NTFS")) {
        blockers.push("迁移需要源盘和目标盘均为 NTFS，以保留应用权限、数据流和目录链接；无法识别的文件系统也不能迁移");
      }
    }
    if (blockers.length === 0) {
      const summary = await summarizeDirectory(source);
      requiredBytes = summary.totalBytes;
      fileCount = summary.fileCount;
      directoryCount = summary.directoryCount;
      reparsePointCount = summary.reparsePointCount;
      free = await availableBytes(destinationBase);
      const safetyMargin = Math.max(512 * 1024 ** 2, Math.ceil(requiredBytes * 0.03));
      if (free < requiredBytes + safetyMargin) {
        blockers.push("目标磁盘可用空间不足（已包含 3% 或 512 MB 的安全余量）");
      }
      if (summary.scanErrors.length > 0) {
        blockers.push(`源目录扫描不完整，无法保证完整迁移：${summary.scanErrors[0]}`);
      }
      if (reparsePointCount > 0) {
        warnings.push(
          `检测到 ${reparsePointCount.toLocaleString()} 个目录联接或符号链接；迁移时将复制链接本身，不会展开链接目标。`
        );
      }
      if (fileCount > 200_000) warnings.push("文件数量较多，复制和逐项校验会需要较长时间。");
    }

    if (source.toLocaleLowerCase().includes("\\appdata\\")) {
      warnings.push("这是应用数据目录；迁移前必须完全退出关联应用。");
    }
    if (isHighRiskApplicationPath(source)) {
      warnings.push("这是应用安装目录；更新器、服务或驱动可能绕过符号链接访问原始位置。");
      warnings.push("建议优先使用应用自己的移动/重装功能；如继续，请先确认没有关联服务运行。");
    }
    warnings.push("迁移期间请勿启动、更新或写入该目录所属的应用。");
    warnings.push("迁移将保留 NTFS 访问权限，并逐文件校验内容；含共享硬链接的目录不能跨盘迁移。");
    warnings.push("符号链接建立并校验成功后，源盘旧副本会被删除以释放空间。");

    const risk = blockers.length
      ? "blocked"
      : isHighRiskApplicationPath(source)
        ? "high"
        : source.toLocaleLowerCase().includes("\\appdata\\")
        ? "medium"
        : "low";
    return {
      allowed: blockers.length === 0,
      source,
      destinationBase,
      finalDestination,
      requiredBytes,
      availableBytes: free,
      fileCount,
      directoryCount,
      reparsePointCount,
      risk,
      warnings,
      blockers
    };
  }

  async execute(
    sourceInput: string,
    destinationBaseInput: string
  ): Promise<MigrationRecord> {
    return this.exclusive(() => this.executeInternal(sourceInput, destinationBaseInput));
  }

  async reapply(id: string): Promise<MigrationRecord> {
    return this.exclusive(async () => {
      const record = this.store.getMigration(id);
      if (!record) throw new Error("找不到迁移记录");
      if (record.stage !== "rolled-back") {
        throw new Error("只有已经撤回的迁移可以再次迁移");
      }
      if (record.error || record.stagingPath || record.backupPath || record.restorePath) {
        await this.cleanupRollback(record);
        if (record.error) throw new Error(record.error);
      }
      return await this.executeInternal(
        record.source,
        path.win32.dirname(record.destination),
        record
      );
    });
  }

  private async executeInternal(
    sourceInput: string,
    destinationBaseInput: string,
    previousRecord?: MigrationRecord
  ): Promise<MigrationRecord> {
    const preflight = await this.preflight(sourceInput, destinationBaseInput);
    if (!preflight.allowed) throw new Error(preflight.blockers.join("；"));
    if (
      previousRecord &&
      !samePath(
        await canonicalizeMigrationPath(preflight.finalDestination, { allowMissingLeaf: true }),
        await canonicalizeMigrationPath(previousRecord.destination, { allowMissingLeaf: true })
      )
    ) {
      throw new Error("再次迁移的目标路径与原迁移记录不一致");
    }

    const operationId = randomUUID();
    const id = previousRecord?.id ?? operationId;
    const now = new Date().toISOString();
    const operationSuffix = operationId.slice(0, 8);
    const stagingPath = `${preflight.finalDestination}.cdriveshift-partial-${operationSuffix}`;
    const backupPath = `${preflight.source}.cdriveshift-backup-${operationSuffix}`;
    const record: MigrationRecord = previousRecord
      ? {
          ...previousRecord,
          source: preflight.source,
          destination: preflight.finalDestination,
          stagingPath,
          backupPath,
          stage: "preflight",
          totalBytes: preflight.requiredBytes,
          copiedBytes: 0,
          updatedAt: now,
          warnings: [...new Set([...previousRecord.warnings, ...preflight.warnings])]
        }
      : {
          id,
          source: preflight.source,
          destination: preflight.finalDestination,
          stagingPath,
          backupPath,
          stage: "preflight",
          totalBytes: preflight.requiredBytes,
          copiedBytes: 0,
          migrationCount: 0,
          startedAt: now,
          updatedAt: now,
          warnings: preflight.warnings
        };
    delete record.completedAt;
    delete record.error;
    delete record.linkType;
    delete record.restorePath;
    await this.persist(record, "预检完成，准备复制");

    try {
      await mkdir(path.dirname(preflight.finalDestination), { recursive: true });
      if (await entryExists(stagingPath) || await entryExists(backupPath)) throw new Error("事务临时目录已存在，已停止迁移");
      record.stage = "copying";
      await this.persist(record, "正在复制到目标磁盘");
      await this.copy(preflight.source, stagingPath);
      await relocateCopiedLinks(preflight.source, stagingPath, preflight.source);

      record.stage = "verifying";
      record.copiedBytes = record.totalBytes;
      await this.persist(record, "正在逐文件核对内容、目录结构与链接目标");
      await verifyMigrationCopy(preflight.source, stagingPath);

      record.stage = "switching";
      await this.persist(record, "副本校验通过，正在执行原子切换");
      await this.renameEntry(preflight.source, backupPath, "切换源目录");
      // Rename can succeed while an application still owns writable file handles.
      // Verify the renamed original again before publishing the replacement.
      await verifyMigrationCopy(backupPath, stagingPath, preflight.source, { sourceRoot: preflight.source });
      await this.renameEntry(stagingPath, preflight.finalDestination, "发布目标目录");

      let linkType: MigrationRecord["linkType"] = "symbolic-link";
      try {
        await symlink(preflight.finalDestination, preflight.source, "dir");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES") throw error;
        await symlink(preflight.finalDestination, preflight.source, "junction");
        linkType = "junction";
        record.warnings.push(
          "当前权限无法创建目录符号链接，已使用 Windows 目录联接；两者均不复制数据。"
        );
      }

      const resolved = await realpath(preflight.source);
      if (!samePath(resolved, await canonicalizeMigrationPath(preflight.finalDestination))) {
        throw new Error(`链接指向异常：${resolved}`);
      }
      await access(path.join(preflight.source));

      delete record.stagingPath;
      record.linkType = linkType;
      record.stage = "linked";
      record.migrationCount += 1;
      record.completedAt = new Date().toISOString();
      await this.persist(record, "迁移完成，原路径已连接到新位置");
      await this.cleanupMigrationBackup(record);
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Once published, the destination is live and may already contain new app
      // writes. Never restore a backup after cleanup has started deleting it.
      if (record.stage === "linked") {
        record.error = `迁移已完成，但状态保存或旧副本清理失败：${message}`;
        await this.persist(record, record.error);
        return record;
      }
      let restored = true;
      await this.restoreAfterFailure(record).catch((restoreError) => {
        restored = false;
        record.warnings.push(
          `自动恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      });
      if ((record as MigrationRecord).stage === "linked") return record;
      if (restored) record.stage = "failed";
      record.error = message;
      await this.persist(record, "迁移失败，已尽力恢复原状态");
      throw new Error(message);
    }
  }

  private async cleanupMigrationBackup(record: MigrationRecord): Promise<void> {
    if (!record.backupPath) return;
    this.assertTransactionPath(record.backupPath, record.source, "backup");
    await assertRecordedLink(record.source, record.destination);
    try {
      if (await entryExists(record.backupPath)) await this.removeTree(record.backupPath, path.dirname(record.source));
      delete record.backupPath;
      delete record.error;
      await this.persist(record, "迁移完成，原路径已连接到新位置");
    } catch (error) {
      record.error = `迁移已完成，旧副本清理未完成：${error instanceof Error ? error.message : String(error)}`;
      record.warnings.push("应用继续通过原路径访问迁移后的完整目录；旧副本清理失败不会撤销迁移。");
      await this.persist(record, record.error);
    }
  }

  async rollback(id: string): Promise<MigrationRecord> {
    return this.exclusive(() => this.rollbackInternal(id));
  }

  private async rollbackInternal(id: string): Promise<MigrationRecord> {
    const record = this.store.getMigration(id);
    if (!record) throw new Error("找不到迁移记录");
    if (record.stage !== "linked") throw new Error("只有已完成的迁移可以回滚");
    await this.assertRecordPaths(record);
    await assertRecordedLink(record.source, record.destination);
    if (record.backupPath) {
      await this.cleanupMigrationBackup(record);
      if (record.backupPath) throw new Error(record.error ?? "迁移旧副本尚未清理，无法开始回滚");
    }
    if (!(await exists(record.destination))) throw new Error("目标目录已不存在");
    const targetSummary = await summarizeDirectory(record.destination);
    if (targetSummary.scanErrors.length) throw new Error(`目标目录扫描不完整，无法安全回滚：${targetSummary.scanErrors[0]}`);
    const free = await availableBytes(record.source);
    if (free < targetSummary.totalBytes + Math.max(512 * 1024 ** 2, targetSummary.totalBytes * 0.03)) {
      throw new Error("源盘空间不足，无法安全回滚");
    }

    const restorePath = `${record.source}.cdriveshift-restore-${randomUUID().slice(0, 8)}`;
    if (await entryExists(restorePath)) throw new Error("恢复临时目录已存在，已停止回滚");
    record.restorePath = restorePath;
    record.stage = "rolling-back";
    record.updatedAt = new Date().toISOString();
    await this.persist(record, "正在将数据复制回原始磁盘");

    try {
      await this.copy(record.destination, restorePath);
      await relocateCopiedLinks(record.destination, restorePath, record.source);
      await verifyMigrationCopy(record.destination, restorePath, record.source);
      // Revalidate immediately before unlinking. A user/updater may have replaced
      // this link while the copy was in progress.
      await assertRecordedLink(record.source, record.destination);
      await unlink(record.source);
      await this.renameEntry(restorePath, record.source, "恢复源目录");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (!(await entryExists(record.source))) await this.restoreRecordedLink(record);
        await assertRecordedLink(record.source, record.destination);
        // The destination is authoritative until the original path is a real
        // directory. Only discard the temporary copy after the link is usable.
        if (await entryExists(restorePath)) await this.removeTree(restorePath, path.dirname(record.source));
        delete record.restorePath;
        record.stage = "linked";
        record.error = message;
        await this.persist(record, "回滚失败，已恢复链接");
      } catch (restoreError) {
        record.stage = "rolling-back";
        record.error = `${message}；自动恢复尚未完成：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
        await this.persist(record, "回滚中断，已保留恢复副本，下次启动将重试恢复");
      }
      throw new Error(record.error ?? message);
    }

    // Persist the committed state before deleting anything in the old target.
    // If deletion is interrupted, startup must never treat that partial target
    // as the authoritative copy and redirect the application back to it.
    delete record.restorePath;
    record.stage = "rolled-back";
    record.completedAt = new Date().toISOString();
    delete record.error;
    await this.persist(record, "源目录已恢复，正在清理目标副本");
    await this.cleanupRollback(record);
    return record;
  }

  private async cleanupRollback(record: MigrationRecord): Promise<void> {
    try {
      await this.assertRecordPaths(record);
      const sourceStats = await lstat(record.source);
      if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) throw new Error("恢复后的源目录不再是实体目录，已保留目标副本");
      for (const key of ["backupPath", "restorePath"] as const) {
        if (record[key] && await entryExists(record[key]!)) await this.removeTree(record[key]!, path.dirname(record.source));
        delete record[key];
      }
      if (!record.stagingPath || !(await entryExists(record.stagingPath))) {
        delete record.stagingPath;
        if (await entryExists(record.destination)) {
          await verifyMigrationCopy(record.destination, record.source, record.source, { allowExtraDestinationEntries: true });
          // Rename the obsolete target to a journaled transaction path before
          // deleting it. A partial cleanup can then be retried without confusing
          // it with a newly created application directory at the destination.
          record.stagingPath = `${record.destination}.cdriveshift-partial-${randomUUID().slice(0, 8)}`;
          await this.persist(record, "源目录已恢复，正在隔离待清理的目标副本");
          await this.renameEntry(record.destination, record.stagingPath, "隔离待清理目标副本");
        }
      }
      if (record.stagingPath) {
        await this.removeTree(record.stagingPath, path.dirname(record.destination));
        delete record.stagingPath;
      }
      delete record.error;
      record.warnings.push("源目录恢复并复验成功后，目标磁盘迁移副本已删除。");
      await this.persist(record, "恢复完成，目标磁盘迁移副本已删除");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.error = `源目录已恢复，但目标副本清理未完成：${message}`;
      record.warnings.push(
        "源目录已经恢复为实体目录；由于复验或清理失败，目标副本可能仍然存在，请人工检查。"
      );
      await this.persist(record, "源目录已恢复，但目标副本清理未完成");
    }
  }

  async recoverIncomplete(): Promise<void> {
    return this.exclusive(async () => {
      const records = this.store
      .listMigrations()
      .filter((item) => !["linked", "rolled-back", "failed"].includes(item.stage) || Boolean(item.backupPath || item.restorePath || item.stagingPath) || (item.stage === "rolled-back" && Boolean(item.error)));
    for (const record of records) {
      try {
        await this.assertRecordPaths(record);
        if (record.stage === "rolling-back") {
          await this.recoverRollback(record);
        } else if (record.stage === "linked") {
          await this.cleanupMigrationBackup(record);
        } else if (record.stage === "rolled-back") {
          await this.cleanupRollback(record);
        } else {
          await this.restoreAfterFailure(record);
          if ((record as MigrationRecord).stage !== "linked") {
            record.stage = "failed";
            record.error = "应用上次退出时迁移未完成，原目录已恢复；保留的目标副本可在检查后清理";
          }
          await this.persist(record, "检测到未完成事务，已恢复");
        }
      } catch (error) {
        // Keep the transaction stage so a temporarily unavailable disk/permission
        // can be retried on the next startup; do not claim recovery succeeded.
        record.error = `未完成事务需要人工检查：${
          error instanceof Error ? error.message : String(error)
        }`;
        await this.persist(record, "未完成事务需要人工检查");
      }
    }
    });
  }

  private async restoreAfterFailure(record: MigrationRecord): Promise<void> {
    await this.assertRecordPaths(record);
    const sourceExists = await entryExists(record.source);
    const backupExists = record.backupPath ? await entryExists(record.backupPath) : false;
    const publishedWithoutLink = ["switching", "failed"].includes(record.stage) && Boolean(record.stagingPath) &&
      !(await entryExists(record.stagingPath!)) && await entryExists(record.destination);
    if (record.backupPath && !backupExists) delete record.backupPath;
    if (sourceExists && (await lstat(record.source)).isSymbolicLink()) {
      await assertRecordedLink(record.source, record.destination);
      const destinationStats = await lstat(record.destination);
      if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) throw new Error("迁移目标不再是实体目录，已保留所有副本");
      await access(record.source);
      // A published link means the destination has become live. In particular,
      // an old version may have crashed halfway through deleting its backup.
      record.stage = "linked";
      record.migrationCount = Math.max(1, record.migrationCount);
      record.completedAt = new Date().toISOString();
      delete record.stagingPath;
      await this.persist(record, "已确认迁移链接有效，保留迁移后的完整目录");
      await this.cleanupMigrationBackup(record);
      return;
    }
    if (!sourceExists && backupExists && record.backupPath) {
      await this.renameEntry(record.backupPath, record.source, "恢复迁移备份");
      delete record.backupPath;
    } else if (sourceExists && backupExists && record.backupPath) {
      throw new Error("原路径已被其他程序重建，已保留原路径和迁移备份，避免覆盖数据");
    } else if (!sourceExists) {
      throw new Error("原目录与迁移备份均不可用，已保留目标数据，需要人工恢复");
    }
    if (publishedWithoutLink && record.stagingPath) {
      await verifyMigrationCopy(record.destination, record.source, record.source, { allowExtraDestinationEntries: true });
      await this.renameEntry(record.destination, record.stagingPath, "回收尚未建立链接的迁移副本");
    }
    if (record.stagingPath) {
      if (await entryExists(record.stagingPath)) await this.removeTree(record.stagingPath, path.dirname(record.destination));
      delete record.stagingPath;
    }
  }

  private async recoverRollback(record: MigrationRecord): Promise<void> {
    if (!record.restorePath && /^[a-f0-9]{8}/iu.test(record.id)) {
      const legacyRestorePath = `${record.source}.cdriveshift-restore-${record.id.slice(0, 8)}`;
      if (await entryExists(legacyRestorePath)) record.restorePath = legacyRestorePath;
    }
    const sourceExists = await entryExists(record.source);
    if (sourceExists && !(await lstat(record.source)).isSymbolicLink()) {
      if (!(await lstat(record.source)).isDirectory()) throw new Error("恢复后的源路径不是目录，已保留目标副本");
      if (record.restorePath && await entryExists(record.restorePath)) throw new Error("原目录与恢复暂存目录同时存在，无法确认是否被其他程序重建；已保留全部副本");
      // This is the crash window immediately after restoring the original path.
      // Preserve both copies: either may contain writes made before restart.
      record.stage = "rolled-back";
      record.completedAt = new Date().toISOString();
      delete record.restorePath;
      record.error = "上次退出前源目录已恢复；目标副本已保留，请检查后清理";
      await this.persist(record, "已恢复源目录状态，目标副本已保留");
      return;
    }
    if (!sourceExists) await this.restoreRecordedLink(record);
    await assertRecordedLink(record.source, record.destination);
    await access(record.source);
    if (record.restorePath && await entryExists(record.restorePath)) {
      await this.removeTree(record.restorePath, path.dirname(record.source));
    }
    delete record.restorePath;
    record.stage = "linked";
    record.error = "上次回滚被中断，已恢复迁移链接，可以重新回滚";
    await this.persist(record, "回滚中断已恢复，应用可继续通过原路径访问");
  }

  private async restoreRecordedLink(record: MigrationRecord): Promise<void> {
    const stats = await lstat(record.destination);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("目标目录不可用，已保留恢复副本");
    try {
      await symlink(record.destination, record.source, record.linkType === "junction" ? "junction" : "dir");
    } catch (error) {
      if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await symlink(record.destination, record.source, "junction");
      record.linkType = "junction";
    }
  }

  private assertTransactionPath(candidate: string, root: string, kind: "backup" | "partial" | "restore"): void {
    const prefix = `${normalizeMigrationPath(root)}.cdriveshift-${kind}-`;
    const normalized = normalizeMigrationPath(candidate);
    if (!normalized.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()) || !/^[a-f0-9]{8}$/iu.test(normalized.slice(prefix.length))) {
      throw new Error(`事务路径与记录不匹配，拒绝修改：${candidate}`);
    }
  }

  private async assertRecordPaths(record: MigrationRecord): Promise<void> {
    // The source is intentionally a link after migration, and a final entry may
    // be missing between journaled rename steps. Canonicalize its parents without
    // replacing that logical source with the link's live destination.
    const source = await canonicalizeMigrationPath(record.source, { allowMissingLeaf: true, allowLeafLink: true });
    const destination = await canonicalizeMigrationPath(record.destination, { allowMissingLeaf: true });
    const transactionPaths = await Promise.all([record.stagingPath, record.backupPath, record.restorePath].map(async (entry) =>
      entry ? await canonicalizeMigrationPath(entry, { allowMissingLeaf: true }) : undefined
    ));
    const protectedPaths = await this.protectedPaths();
    if (protectedPaths.some((candidate) => [source, destination, ...transactionPaths].some((entry) => entry && (isPathWithin(entry, candidate) || isPathWithin(candidate, entry))))) {
      throw new Error("迁移记录涉及本程序的运行或配置数据目录，已停止操作");
    }
    if (protectedReason(source) || protectedReason(destination) || isPathWithin(source, destination) || isPathWithin(destination, source)) {
      throw new Error("迁移记录包含受保护或相互包含的路径，已停止操作");
    }
    if (record.backupPath) this.assertTransactionPath(record.backupPath, record.source, "backup");
    if (record.stagingPath) this.assertTransactionPath(record.stagingPath, record.destination, "partial");
    if (record.restorePath) this.assertTransactionPath(record.restorePath, record.source, "restore");
  }

  private async persist(record: MigrationRecord, message: string): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await this.store.saveMigration(record);
    // A closed renderer must never unwind a filesystem transaction.
    try { this.onProgress(structuredClone(record), message); } catch { /* UI detached */ }
  }
}
