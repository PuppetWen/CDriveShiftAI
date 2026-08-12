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
import { migrationDestinationFor } from "./migration-path";
import { AppStore } from "./store";
import type { DirectorySummary, MigrationRecord, PreflightResult } from "./types";
import {
  isHighRiskApplicationPath,
  isPathWithin,
  normalizeWindowsPath,
  protectedReason,
  samePath
} from "./system";

type ProgressHandler = (record: MigrationRecord, message: string) => void;

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
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
    "/COPY:DAT",
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

export function runRobocopy(source: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "robocopy.exe",
      migrationRobocopyArguments(source, destination),
      {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 24 * 60 * 60_000
      },
      (error, stdout, stderr) => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? 16 : 0;
        if (exitCode < 8) resolve();
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

function normalizedReparsePoints(summary: DirectorySummary): string[] {
  return (summary.reparsePoints ?? [])
    .map(({ relativePath, target }) =>
      `${relativePath.replaceAll("/", "\\").toLocaleLowerCase()}\u0000${target
        .replaceAll("/", "\\")
        .toLocaleLowerCase()}`
    )
    .sort();
}

async function verifyCopy(source: string, destination: string) {
  const [sourceSummary, destinationSummary] = await Promise.all([
    summarizeDirectory(source, { includeReparsePoints: true }),
    summarizeDirectory(destination, { includeReparsePoints: true })
  ]);
  if (sourceSummary.scanErrors.length > 0) {
    throw new Error(`源目录复验失败：${sourceSummary.scanErrors[0]}`);
  }
  if (destinationSummary.scanErrors.length > 0) {
    throw new Error(`目标目录复验失败：${destinationSummary.scanErrors[0]}`);
  }
  const sourceReparsePoints = normalizedReparsePoints(sourceSummary);
  const destinationReparsePoints = normalizedReparsePoints(destinationSummary);
  const matches =
    sourceSummary.totalBytes === destinationSummary.totalBytes &&
    sourceSummary.fileCount === destinationSummary.fileCount &&
    sourceSummary.directoryCount === destinationSummary.directoryCount &&
    sourceSummary.reparsePointCount === destinationSummary.reparsePointCount &&
    sourceReparsePoints.length === destinationReparsePoints.length &&
    sourceReparsePoints.every((entry, index) => entry === destinationReparsePoints[index]);
  if (!matches) {
    throw new Error(
      `副本校验不一致：源目录 ${sourceSummary.fileCount} 个文件 / ${sourceSummary.totalBytes} 字节，` +
        `${sourceSummary.reparsePointCount} 个重解析点；目标目录 ${destinationSummary.fileCount} 个文件 / ` +
        `${destinationSummary.totalBytes} 字节，${destinationSummary.reparsePointCount} 个重解析点`
    );
  }
  return destinationSummary;
}

async function removeTreeAtExactPath(candidate: string, expectedParent: string): Promise<void> {
  const normalized = normalizeWindowsPath(candidate);
  if (!samePath(path.dirname(normalized), expectedParent)) {
    throw new Error(`拒绝清理未验证路径：${normalized}`);
  }
  await rm(normalized, { recursive: true, force: false, maxRetries: 2, retryDelay: 250 });
}

export class MigrationService {
  private readonly activeMigrationIds = new Set<string>();

  constructor(
    private readonly store: AppStore,
    private readonly onProgress: ProgressHandler
  ) {}

  async preflight(sourceInput: string, destinationBaseInput: string): Promise<PreflightResult> {
    const base = await this.preflightCore(sourceInput, destinationBaseInput);
    let normalizedSource: string;
    try {
      normalizedSource = normalizeWindowsPath(sourceInput);
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
      source = normalizeWindowsPath(sourceInput);
      destinationBase = normalizeWindowsPath(destinationBaseInput);
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

    const finalDestination = migrationDestinationFor(source, destinationBase);
    const protection = protectedReason(source);
    if (protection) blockers.push(protection);
    if (path.parse(source).root.toLocaleLowerCase() === path.parse(destinationBase).root.toLocaleLowerCase()) {
      blockers.push("目标目录必须位于其他磁盘，否则无法释放源盘空间");
    }
    if (isPathWithin(destinationBase, source) || isPathWithin(source, destinationBase)) {
      blockers.push("源目录和目标目录不能互相包含");
    }
    if (!(await exists(source))) blockers.push("源目录不存在");
    if (!(await exists(destinationBase))) blockers.push("目标基础目录不存在");
    if (await exists(finalDestination)) blockers.push(`目标位置已存在：${finalDestination}`);

    let requiredBytes = 0;
    let fileCount = 0;
    let directoryCount = 0;
    let reparsePointCount = 0;
    let free = 0;
    if (blockers.length === 0) {
      const stats = await lstat(source);
      if (!stats.isDirectory()) blockers.push("源路径不是目录");
      if (stats.isSymbolicLink()) blockers.push("源目录已经是符号链接或目录联接");
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
    return this.executeInternal(sourceInput, destinationBaseInput);
  }

  async reapply(id: string): Promise<MigrationRecord> {
    if (this.activeMigrationIds.has(id)) {
      throw new Error("这条迁移记录正在执行其他操作");
    }
    this.activeMigrationIds.add(id);
    try {
      const record = this.store.getMigration(id);
      if (!record) throw new Error("找不到迁移记录");
      if (record.stage !== "rolled-back") {
        throw new Error("只有已经撤回的迁移可以再次迁移");
      }
      return await this.executeInternal(
        record.source,
        path.win32.dirname(record.destination),
        record
      );
    } finally {
      this.activeMigrationIds.delete(id);
    }
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
      !samePath(preflight.finalDestination, previousRecord.destination)
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
    await this.persist(record, "预检完成，准备复制");

    try {
      await mkdir(path.dirname(preflight.finalDestination), { recursive: true });
      record.stage = "copying";
      await this.persist(record, "正在复制到目标磁盘");
      await runRobocopy(preflight.source, stagingPath);

      record.stage = "verifying";
      record.copiedBytes = record.totalBytes;
      await this.persist(record, "正在核对文件数、目录数与总字节数");
      await verifyCopy(preflight.source, stagingPath);

      record.stage = "switching";
      await this.persist(record, "副本校验通过，正在执行原子切换");
      await rename(preflight.source, backupPath);
      await rename(stagingPath, preflight.finalDestination);

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
      if (!samePath(resolved, preflight.finalDestination)) {
        throw new Error(`链接指向异常：${resolved}`);
      }
      await access(path.join(preflight.source));

      await removeTreeAtExactPath(backupPath, path.dirname(preflight.source));
      delete record.backupPath;
      delete record.stagingPath;
      record.linkType = linkType;
      record.stage = "linked";
      record.migrationCount += 1;
      record.completedAt = new Date().toISOString();
      await this.persist(record, "迁移完成，原路径已连接到新位置");
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.restoreAfterFailure(record).catch((restoreError) => {
        record.warnings.push(
          `自动恢复失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      });
      record.stage = "failed";
      record.error = message;
      await this.persist(record, "迁移失败，已尽力恢复原状态");
      throw new Error(message);
    }
  }

  async rollback(id: string): Promise<MigrationRecord> {
    if (this.activeMigrationIds.has(id)) {
      throw new Error("这条迁移记录正在执行其他操作");
    }
    this.activeMigrationIds.add(id);
    try {
    const record = this.store.getMigration(id);
    if (!record) throw new Error("找不到迁移记录");
    if (record.stage !== "linked") throw new Error("只有已完成的迁移可以回滚");

    const sourceStat = await lstat(record.source);
    if (!sourceStat.isSymbolicLink()) {
      const resolved = await realpath(record.source).catch(() => record.source);
      if (!samePath(resolved, record.destination)) {
        throw new Error("原路径不再指向记录中的目标，已停止回滚");
      }
    }
    if (!(await exists(record.destination))) throw new Error("目标目录已不存在");
    const targetSummary = await summarizeDirectory(record.destination);
    const free = await availableBytes(record.source);
    if (free < targetSummary.totalBytes + Math.max(512 * 1024 ** 2, targetSummary.totalBytes * 0.03)) {
      throw new Error("源盘空间不足，无法安全回滚");
    }

    const restorePath = `${record.source}.cdriveshift-restore-${record.id.slice(0, 8)}`;
    record.stage = "rolling-back";
    record.updatedAt = new Date().toISOString();
    await this.persist(record, "正在将数据复制回原始磁盘");

    let sourceRestored = false;
    try {
      await runRobocopy(record.destination, restorePath);
      await verifyCopy(record.destination, restorePath);
      await unlink(record.source);
      await rename(restorePath, record.source);
      sourceRestored = true;
    } catch (error) {
      if (!sourceRestored) {
        if (!(await exists(record.source)) && (await exists(record.destination))) {
          await symlink(
            record.destination,
            record.source,
            record.linkType === "junction" ? "junction" : "dir"
          );
        }
        if (await exists(restorePath)) {
          await removeTreeAtExactPath(restorePath, path.dirname(record.source)).catch(
            () => undefined
          );
        }
        record.stage = "linked";
        record.error = error instanceof Error ? error.message : String(error);
        await this.persist(record, "回滚失败，已恢复链接");
        throw error;
      }
    }

    try {
      await verifyCopy(record.destination, record.source);
      await removeTreeAtExactPath(
        record.destination,
        path.dirname(record.destination)
      );
      record.stage = "rolled-back";
      record.completedAt = new Date().toISOString();
      delete record.error;
      record.warnings.push("源目录恢复并复验成功后，目标磁盘迁移副本已删除。");
      await this.persist(record, "恢复完成，目标磁盘迁移副本已删除");
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.stage = "rolled-back";
      record.completedAt = new Date().toISOString();
      record.error = `源目录已恢复，但目标副本清理未完成：${message}`;
      record.warnings.push(
        "源目录已经恢复为实体目录；由于复验或清理失败，目标副本可能仍然存在，请人工检查。"
      );
      await this.persist(record, "源目录已恢复，但目标副本清理未完成");
      throw new Error(record.error);
    }
    } finally {
      this.activeMigrationIds.delete(id);
    }
  }

  async recoverIncomplete(): Promise<void> {
    const records = this.store
      .listMigrations()
      .filter((item) => !["linked", "rolled-back", "failed"].includes(item.stage));
    for (const record of records) {
      try {
        await this.restoreAfterFailure(record);
        record.stage = "failed";
        record.error = "应用上次退出时迁移未完成，已自动恢复可用状态";
        await this.persist(record, "检测到未完成事务，已恢复");
      } catch (error) {
        record.stage = "failed";
        record.error = `未完成事务需要人工检查：${
          error instanceof Error ? error.message : String(error)
        }`;
        await this.persist(record, "未完成事务需要人工检查");
      }
    }
  }

  private async restoreAfterFailure(record: MigrationRecord): Promise<void> {
    const sourceExists = await exists(record.source);
    const backupExists = record.backupPath ? await exists(record.backupPath) : false;
    if (!sourceExists && backupExists && record.backupPath) {
      await rename(record.backupPath, record.source);
    } else if (sourceExists && backupExists && record.backupPath) {
      const sourceStat = await lstat(record.source);
      if (sourceStat.isSymbolicLink()) {
        await unlink(record.source);
        await rename(record.backupPath, record.source);
      }
    }
    if (record.stagingPath && (await exists(record.stagingPath))) {
      await removeTreeAtExactPath(record.stagingPath, path.dirname(record.destination));
    }
  }

  private async persist(record: MigrationRecord, message: string): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await this.store.saveMigration(record);
    this.onProgress(structuredClone(record), message);
  }
}
