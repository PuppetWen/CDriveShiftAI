import { execFile } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { deleteWithElevation, deleteWithoutElevation, type ElevatedDeleteRequest } from "./elevated-delete";
import { listFileLockProcesses, sameProcessStartTime, type FileLockScan } from "./file-locks";
import { logger, serializeError } from "./logger";
import {
  isElevated,
  isHighRiskApplicationPath,
  isPathWithin,
  normalizeWindowsPath,
  protectedReason,
  samePath
} from "./system";
import type {
  ForceDeletePreview,
  ForceDeleteProcess,
  ForceDeleteResult
} from "./types";

const execFileAsync = promisify(execFile);
const VERIFICATION_TTL_MS = 2 * 60_000;
const NEVER_TERMINATE = new Set([
  "system",
  "registry",
  "smss.exe",
  "csrss.exe",
  "wininit.exe",
  "services.exe",
  "lsass.exe",
  "winlogon.exe",
  "dwm.exe",
  "explorer.exe",
  "svchost.exe"
]);

interface WindowsProcessRecord {
  pid: number;
  name: string;
  executablePath?: string;
  commandLine?: string;
  parentPid?: number;
  creationTime?: string;
  fileHandleMatch?: boolean;
  protectedProcess?: boolean;
}

interface VerificationRecord {
  path: string;
  canonicalPath: string;
  identity: string;
  processes: WindowsProcessRecord[];
  terminablePids: Set<number>;
  expiresAt: number;
}

interface ForceDeleteOperations {
  listProcesses: () => Promise<WindowsProcessRecord[]>;
  terminateProcess: (pid: number, creationTime: string) => Promise<boolean>;
  remove?: (targetPath: string, retry: boolean) => Promise<void>;
  removeDirect?: (request: ElevatedDeleteRequest) => Promise<void>;
  listFileLocks?: (targetPath: string) => Promise<FileLockScan>;
  removeElevated?: (request: ElevatedDeleteRequest) => Promise<void>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseProcessList(raw: string): WindowsProcessRecord[] {
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const pid = Number(item.pid ?? item.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) return [];
    return [{
      pid,
      name: optionalString(item.name ?? item.Name) ?? `PID ${pid}`,
      executablePath: optionalString(item.executablePath ?? item.ExecutablePath),
      commandLine: optionalString(item.commandLine ?? item.CommandLine),
      parentPid: Number(item.parentPid ?? item.ParentProcessId) || undefined,
      creationTime: optionalString(item.creationTime)
    }];
  });
}

function normalizeCommandLine(value: string): string {
  return value.replaceAll("/", "\\").toLocaleLowerCase();
}

export function normalizeForceDeletePath(targetPath: string): string {
  // Win32 device aliases bypass lexical path protections. Accept only ordinary
  // absolute paths and the long-path spellings that map to the same filesystem.
  let input = targetPath.trim().replaceAll("/", "\\");
  if (/^\\\\\?\\UNC\\/i.test(input)) input = `\\\\${input.slice(8)}`;
  else if (/^\\\\\?\\[a-z]:\\/i.test(input)) input = input.slice(4);
  if (
    !(/^[a-z]:\\/i.test(input) || /^\\\\[^\\]+\\[^\\]+\\.+/.test(input)) ||
    /^\\\\[?.]\\/.test(input) ||
    /[\x00-\x1f*?]/.test(input) ||
    input.slice(2).includes(":") ||
    input.split("\\").some((part) => part !== "." && part !== ".." && /[. ]$/.test(part))
  ) {
    throw new Error("强制删除需要明确的绝对文件路径，不能使用设备路径、盘符根目录或通配符");
  }
  const normalized = normalizeWindowsPath(input);
  if (samePath(normalized, path.win32.parse(normalized).root)) {
    throw new Error("受保护路径不能强制删除：不能删除盘符或共享根目录");
  }
  return normalized;
}

export function commandLineReferencesTarget(
  commandLine: string,
  targetPath: string
): boolean {
  const haystack = normalizeCommandLine(commandLine);
  const needle = normalizeWindowsPath(targetPath).toLocaleLowerCase();
  let offset = haystack.indexOf(needle);
  while (offset >= 0) {
    const before = offset === 0 ? "" : haystack[offset - 1];
    const after = haystack[offset + needle.length] ?? "";
    const beforeBoundary = before === "" || /[\s"'=]/u.test(before);
    const afterBoundary = after === "" || /[\\\s"']/u.test(after);
    if (beforeBoundary && afterBoundary) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}

export function matchProcessesForTarget(
  processes: WindowsProcessRecord[],
  targetPath: string,
  targetIsDirectory: boolean,
  excludedPids: ReadonlySet<number> = new Set()
): ForceDeleteProcess[] {
  return processes.flatMap((processRecord) => {
    const executableMatch = processRecord.executablePath
      ? targetIsDirectory
        ? isPathWithin(processRecord.executablePath, targetPath)
        : samePath(processRecord.executablePath, targetPath)
      : false;
    const commandLineMatch = processRecord.commandLine
      ? commandLineReferencesTarget(processRecord.commandLine, targetPath)
      : false;
    if (!executableMatch && !commandLineMatch && !processRecord.fileHandleMatch) return [];
    const protectedProcess =
      processRecord.pid <= 4 ||
      excludedPids.has(processRecord.pid) ||
      processRecord.protectedProcess ||
      NEVER_TERMINATE.has(processRecord.name.toLocaleLowerCase());
    return [{
      pid: processRecord.pid,
      name: processRecord.name,
      executablePath: processRecord.executablePath,
      matchReason: processRecord.fileHandleMatch ? "file-handle" : executableMatch ? "executable" : "command-line",
      canTerminate: !protectedProcess
    }];
  });
}

async function listWindowsProcesses(): Promise<WindowsProcessRecord[]> {
  if (process.platform !== "win32") return [];
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()",
    "$items=@(Get-CimInstance Win32_Process | ForEach-Object {",
    "[PSCustomObject]@{pid=[int]$_.ProcessId;name=[string]$_.Name;executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine;parentPid=[int]$_.ParentProcessId;creationTime=if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().Ticks.ToString()} else {''}}",
    "})",
    "ConvertTo-Json -Compress -InputObject $items"
  ].join("; ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 8_000, maxBuffer: 4 * 1024 * 1024 }
  );
  return parseProcessList(stdout);
}

async function terminateProcess(pid: number, creationTime: string): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 4 || !/^\d{2,}$/.test(creationTime)) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  try {
    // Hold the process handle while checking its start time and terminating it.
    // Killing by PID alone can race with PID reuse; /T also kills unlisted children.
    const script = [
      "$ErrorActionPreference='Stop'",
      `$target=[Diagnostics.Process]::GetProcessById(${pid})`,
      "try {",
      "$null=$target.Handle",
      "$ticks=$target.StartTime.ToUniversalTime().Ticks.ToString()",
      `if ($ticks.Substring(0,$ticks.Length-1) -ne '${creationTime.slice(0, -1)}') { exit 2 }`,
      "$target.Kill()",
      "if (-not $target.WaitForExit(5000)) { exit 3 }",
      "} finally { $target.Dispose() }"
    ].join("; ");
    await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 512 * 1024
    });
    return true;
  } catch {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
}

function identity(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}:${stats.isSymbolicLink()}:${stats.isDirectory()}`;
}

function sameProcess(previous: WindowsProcessRecord, current: WindowsProcessRecord): boolean {
  return Boolean(previous.creationTime && previous.creationTime === current.creationTime) &&
    previous.pid === current.pid && previous.name === current.name &&
    previous.executablePath === current.executablePath && previous.commandLine === current.commandLine;
}

function excludedProcesses(processes: WindowsProcessRecord[], applicationRoot: string): Set<number> {
  const excluded = new Set([process.pid, process.ppid]);
  // Protect this application's ancestors and helpers, including the native indexer.
  let ancestor = processes.find((item) => item.pid === process.ppid);
  while (ancestor?.parentPid && !excluded.has(ancestor.parentPid)) {
    excluded.add(ancestor.parentPid);
    ancestor = processes.find((item) => item.pid === ancestor!.parentPid);
  }
  const descendants = new Set([process.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of processes) {
      if (item.parentPid && descendants.has(item.parentPid) && !descendants.has(item.pid)) {
        descendants.add(item.pid);
        changed = true;
      }
    }
  }
  for (const item of processes) {
    if (descendants.has(item.pid) && (!item.executablePath || isPathWithin(item.executablePath, applicationRoot))) {
      excluded.add(item.pid);
    }
  }
  return excluded;
}

export class ForceDeleteService {
  private readonly verifications = new Map<string, VerificationRecord>();
  private readonly activeExecutions = new Set<Promise<ForceDeleteResult>>();
  private readonly activePaths = new Set<string>();

  constructor(
    private readonly options: {
      applicationExecutable: string;
      applicationDataRoot: string;
      createVerificationId: () => string;
      assertPathAllowed?: (targetPath: string) => void | Promise<void>;
    },
    private readonly operations: ForceDeleteOperations = {
      listProcesses: listWindowsProcesses,
      listFileLocks: listFileLockProcesses,
      terminateProcess,
      removeDirect: deleteWithoutElevation,
      removeElevated: deleteWithElevation
    }
  ) {}

  private validateTarget(targetPath: string): string {
    const normalized = normalizeForceDeletePath(targetPath);
    const protection = protectedReason(normalized);
    if (protection) throw new Error(`受保护路径不能强制删除：${protection}`);
    if (
      [path.dirname(this.options.applicationExecutable), this.options.applicationDataRoot].some(
        (protectedPath) => isPathWithin(protectedPath, normalized) || isPathWithin(normalized, protectedPath)
      )
    ) {
      throw new Error("不能强制删除 CDriveShiftAI 当前程序或数据所在目录");
    }
    return normalized;
  }

  private async inspectTarget(targetPath: string) {
    const normalized = this.validateTarget(targetPath);
    await this.options.assertPathAllowed?.(normalized);
    const stats = await lstat(normalized, { bigint: true });
    // Resolve ancestors, but deliberately do not follow the selected link itself.
    const canonicalPath = this.validateTarget(stats.isSymbolicLink()
      ? path.join(await realpath(path.dirname(normalized)), path.basename(normalized))
      : await realpath(normalized));
    for (const protectedPath of [path.dirname(this.options.applicationExecutable), this.options.applicationDataRoot]) {
      const canonicalProtectedPath = await realpath(protectedPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return protectedPath;
        throw error;
      });
      if (isPathWithin(canonicalPath, canonicalProtectedPath) || isPathWithin(canonicalProtectedPath, canonicalPath)) {
        throw new Error("不能强制删除 CDriveShiftAI 当前程序或数据所在目录");
      }
    }
    await this.options.assertPathAllowed?.(canonicalPath);
    return { normalized, canonicalPath, stats };
  }

  private async discoverProcesses(targetPath: string): Promise<{ records: WindowsProcessRecord[]; warnings: string[] }> {
    const [processResult, lockResult] = await Promise.allSettled([
      this.operations.listProcesses(),
      this.operations.listFileLocks?.(targetPath) ?? Promise.resolve({ processes: [], warnings: [] })
    ]);
    const warnings: string[] = [];
    const records = processResult.status === "fulfilled" ? processResult.value.map((record) => ({ ...record })) : [];
    if (processResult.status === "rejected") {
      logger.warn("force_delete.process_discovery_failed", { error: serializeError(processResult.reason) });
      warnings.push("无法读取进程身份信息；仍可尝试删除，但不会结束无法确认身份的进程。");
    }
    if (lockResult.status === "rejected") {
      logger.warn("force_delete.file_lock_discovery_failed", { error: serializeError(lockResult.reason) });
      warnings.push("Windows 文件占用查询失败；仅能按启动路径和命令行识别相关进程。");
    } else {
      warnings.push(...lockResult.value.warnings);
      for (const lock of lockResult.value.processes) {
        const record = records.find((item) => item.pid === lock.pid);
        if (record && sameProcessStartTime(record.creationTime, lock.creationTime)) {
          record.fileHandleMatch = true;
          record.protectedProcess = lock.protected;
        } else if (!record) {
          records.push({ pid: lock.pid, name: `PID ${lock.pid}`, creationTime: lock.creationTime, fileHandleMatch: true, protectedProcess: true });
        }
      }
    }
    return { records, warnings };
  }

  private async revalidate(verification: VerificationRecord): Promise<boolean> {
    try {
      const current = await this.inspectTarget(verification.path);
      if (!samePath(current.canonicalPath, verification.canonicalPath) || identity(current.stats) !== verification.identity) {
        throw new Error("目标在预检后已被替换或路径发生变化，请重新预检");
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private cleanExpiredVerifications(): void {
    const now = Date.now();
    for (const [id, verification] of this.verifications) {
      if (verification.expiresAt <= now) this.verifications.delete(id);
    }
  }

  async preview(targetPath: string): Promise<ForceDeletePreview> {
    this.cleanExpiredVerifications();
    const { normalized, canonicalPath, stats } = await this.inspectTarget(targetPath);
    const { records, warnings } = stats.isSymbolicLink() ? { records: [], warnings: [] } : await this.discoverProcesses(normalized);
    const processes = matchProcessesForTarget(
      records,
      normalized,
      stats.isDirectory(),
      excludedProcesses(records, path.dirname(this.options.applicationExecutable))
    );
    const verificationId = this.options.createVerificationId();
    this.verifications.set(verificationId, {
      path: normalized,
      canonicalPath,
      identity: identity(stats),
      processes: records,
      terminablePids: new Set(processes.filter((item) => item.canTerminate).map((item) => item.pid)),
      expiresAt: Date.now() + VERIFICATION_TTL_MS
    });
    logger.info("force_delete.preview", {
      targetPath: normalized,
      isDirectory: stats.isDirectory(),
      relatedProcesses: processes.length,
      terminableProcesses: processes.filter((item) => item.canTerminate).length
    });
    return {
      verificationId,
      path: normalized,
      name: path.basename(normalized),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      highRisk: isHighRiskApplicationPath(normalized),
      elevated: await isElevated(),
      processes,
      processWarnings: warnings
    };
  }

  isBusy(): boolean {
    return this.activeExecutions.size > 0;
  }

  async whenIdle(): Promise<void> {
    while (this.activeExecutions.size) await Promise.allSettled([...this.activeExecutions]);
  }

  async execute(verificationId: string): Promise<ForceDeleteResult> {
    const targetPath = this.verifications.get(verificationId)?.canonicalPath;
    if (targetPath && [...this.activePaths].some((active) => isPathWithin(targetPath, active) || isPathWithin(active, targetPath))) {
      this.verifications.delete(verificationId);
      throw new Error("该目标或其父子目录正在强制删除，请等待完成后重新预检");
    }
    if (targetPath) this.activePaths.add(targetPath);
    const execution = this.executeVerified(verificationId);
    this.activeExecutions.add(execution);
    try { return await execution; }
    finally {
      this.activeExecutions.delete(execution);
      if (targetPath) this.activePaths.delete(targetPath);
    }
  }

  private async executeVerified(verificationId: string): Promise<ForceDeleteResult> {
    this.cleanExpiredVerifications();
    const verification = this.verifications.get(verificationId);
    if (!verification) throw new Error("强制删除确认已过期，请重新预检");
    this.verifications.delete(verificationId);
    const normalized = verification.path;
    const terminated: ForceDeleteProcess[] = [];
    const failed: ForceDeleteProcess[] = [];
    let usedElevation = false;
    const deleteRequest: ElevatedDeleteRequest = {
      path: normalized,
      canonicalPath: verification.canonicalPath,
      expectedIdentity: verification.identity,
      applicationExecutable: this.options.applicationExecutable,
      applicationDataRoot: this.options.applicationDataRoot
    };
    const remove = (retry: boolean) => {
      // The same identity confirmed in the preview reaches the native helper.
      // fs.rm's read-only fallback chmod can modify external hard links.
      if (this.operations.removeDirect) return this.operations.removeDirect(deleteRequest);
      if (this.operations.remove) return this.operations.remove(normalized, retry);
      throw new Error("删除操作未配置");
    };
    try {
      if (!await this.revalidate(verification)) return { deleted: true, terminatedProcesses: [] };
      try {
        await remove(false);
      } catch (firstError) {
        if (!["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes((firstError as NodeJS.ErrnoException).code ?? "")) throw firstError;
        if (!await this.revalidate(verification)) return { deleted: true, terminatedProcesses: [] };
        const { records } = await this.discoverProcesses(normalized);
        const stats = await lstat(normalized);
        const matches = stats.isSymbolicLink() ? [] : matchProcessesForTarget(records, normalized, stats.isDirectory(), excludedProcesses(records, path.dirname(this.options.applicationExecutable)));
        for (const processRecord of matches.filter((item) => item.canTerminate)) {
          const previous = verification.processes.find((item) => item.pid === processRecord.pid);
          const current = records.find((item) => item.pid === processRecord.pid)!;
          if (!verification.terminablePids.has(processRecord.pid) || !previous || !sameProcess(previous, current)) continue;
          if (!await this.revalidate(verification)) return { deleted: true, terminatedProcesses: terminated };
          if (await this.operations.terminateProcess(processRecord.pid, current.creationTime!)) terminated.push(processRecord);
          else failed.push(processRecord);
        }
        // An unkillable process may not hold a file open; retry deletion anyway.
        if (!await this.revalidate(verification)) return { deleted: true, terminatedProcesses: terminated };
        try {
          await remove(true);
        } catch (retryError) {
          if (!this.operations.removeElevated || !["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes((retryError as NodeJS.ErrnoException).code ?? "")) throw retryError;
          if (!await this.revalidate(verification)) return { deleted: true, terminatedProcesses: terminated };
          logger.info("force_delete.elevation_requested", { targetPath: normalized });
          await this.operations.removeElevated({
            ...deleteRequest,
            processes: failed.flatMap((item) => {
              const previous = verification.processes.find((record) => record.pid === item.pid);
              return previous?.creationTime ? [{ pid: previous.pid, name: previous.name,
                creationTime: previous.creationTime, executablePath: previous.executablePath }] : [];
            })
          });
          usedElevation = true;
        }
      }
      try {
        await lstat(normalized);
        throw new Error("目标仍然存在或已被其他程序重新创建，请重新预检");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      logger.info("force_delete.completed", {
        targetPath: normalized,
        usedElevation,
        terminatedProcesses: terminated.map(({ pid, name }) => ({ pid, name }))
      });
      return { deleted: true, terminatedProcesses: terminated, ...(usedElevation ? { usedElevation: true } : {}) };
    } catch (error) {
      logger.error("force_delete.failed", {
        targetPath: normalized,
        terminatedProcesses: terminated.map(({ pid, name }) => ({ pid, name })),
        error: serializeError(error)
      });
      const code = (error as NodeJS.ErrnoException).code;
      const errorPath = (error as NodeJS.ErrnoException).path;
      const details = `${code ? `（${code}）` : ""}${errorPath ? `：${errorPath}` : ""}`;
      const processDetails = failed.length ? `；未能结束：${failed.map((item) => `${item.name} (PID ${item.pid})`).join("、")}` : "";
      throw new Error(
        code === "EPERM" || code === "EACCES" || code === "EBUSY"
          ? `强制删除失败${details}：目标可能被文件句柄占用或访问控制权限拒绝。文件占用查询有范围限制，目录句柄、驱动锁或新启动进程可能未列出；管理员权限也不能解除所有文件锁或受保护进程。请关闭占用程序并检查目标权限后重新预检${processDetails}`
          : code === "ENOTEMPTY"
            ? `强制删除失败${details}：目录仍有文件，可能有后台程序持续写入；请停止写入后重新预检${processDetails}`
          : `强制删除失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
