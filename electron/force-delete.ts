import { execFile } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
}

interface VerificationRecord {
  path: string;
  expiresAt: number;
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
      commandLine: optionalString(item.commandLine ?? item.CommandLine)
    }];
  });
}

function normalizeCommandLine(value: string): string {
  return value.replaceAll("/", "\\").toLocaleLowerCase();
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
    if (!executableMatch && !commandLineMatch) return [];
    const protectedProcess =
      processRecord.pid <= 4 ||
      excludedPids.has(processRecord.pid) ||
      NEVER_TERMINATE.has(processRecord.name.toLocaleLowerCase());
    return [{
      pid: processRecord.pid,
      name: processRecord.name,
      executablePath: processRecord.executablePath,
      matchReason: executableMatch ? "executable" : "command-line",
      canTerminate: !protectedProcess
    }];
  });
}

async function listWindowsProcesses(): Promise<WindowsProcessRecord[]> {
  if (process.platform !== "win32") return [];
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()",
    "$items=@(Get-CimInstance Win32_Process | ForEach-Object {",
    "[PSCustomObject]@{pid=[int]$_.ProcessId;name=[string]$_.Name;executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine}",
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

async function terminateProcessTree(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 512 * 1024
    });
    return true;
  } catch {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }
}

async function removePermanently(targetPath: string): Promise<void> {
  try {
    await rm(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 300
    });
    return;
  } catch (firstError) {
    if (process.platform === "win32") {
      await execFileAsync(
        "attrib.exe",
        ["-R", "-S", "-H", targetPath, "/S", "/D"],
        { windowsHide: true, timeout: 15_000, maxBuffer: 512 * 1024 }
      ).catch(() => undefined);
      try {
        await rm(targetPath, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 400
        });
        return;
      } catch (secondError) {
        throw secondError;
      }
    }
    throw firstError;
  }
}

export class ForceDeleteService {
  private readonly verifications = new Map<string, VerificationRecord>();

  constructor(
    private readonly options: {
      applicationExecutable: string;
      applicationDataRoot: string;
      createVerificationId: () => string;
    }
  ) {}

  private validateTarget(targetPath: string): string {
    const normalized = normalizeWindowsPath(targetPath);
    const protection = protectedReason(normalized);
    if (protection) throw new Error(`受保护路径不能强制删除：${protection}`);
    if (
      isPathWithin(this.options.applicationExecutable, normalized) ||
      isPathWithin(this.options.applicationDataRoot, normalized)
    ) {
      throw new Error("不能强制删除 CDriveShiftAI 当前程序或数据所在目录");
    }
    return normalized;
  }

  private cleanExpiredVerifications(): void {
    const now = Date.now();
    for (const [id, verification] of this.verifications) {
      if (verification.expiresAt <= now) this.verifications.delete(id);
    }
  }

  async preview(targetPath: string): Promise<ForceDeletePreview> {
    this.cleanExpiredVerifications();
    const normalized = this.validateTarget(targetPath);
    const stats = await lstat(normalized);
    const processes = matchProcessesForTarget(
      await listWindowsProcesses(),
      normalized,
      stats.isDirectory(),
      new Set([process.pid, process.ppid])
    );
    const verificationId = this.options.createVerificationId();
    this.verifications.set(verificationId, {
      path: normalized,
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
      processes
    };
  }

  async execute(verificationId: string): Promise<ForceDeleteResult> {
    this.cleanExpiredVerifications();
    const verification = this.verifications.get(verificationId);
    if (!verification) throw new Error("强制删除确认已过期，请重新预检");
    this.verifications.delete(verificationId);
    const normalized = this.validateTarget(verification.path);
    const stats = await lstat(normalized);
    const processes = matchProcessesForTarget(
      await listWindowsProcesses(),
      normalized,
      stats.isDirectory(),
      new Set([process.pid, process.ppid])
    );
    const terminated: ForceDeleteProcess[] = [];
    const failed: ForceDeleteProcess[] = [];
    for (const processRecord of processes.filter((item) => item.canTerminate)) {
      if (await terminateProcessTree(processRecord.pid)) terminated.push(processRecord);
      else failed.push(processRecord);
    }
    if (failed.length > 0) {
      logger.warn("force_delete.process_termination_failed", {
        targetPath: normalized,
        processes: failed.map(({ pid, name }) => ({ pid, name }))
      });
      throw new Error(
        `无法结束 ${failed.map((item) => `${item.name} (PID ${item.pid})`).join("、")}；请以管理员身份运行后重试`
      );
    }
    try {
      await removePermanently(normalized);
      logger.info("force_delete.completed", {
        targetPath: normalized,
        terminatedProcesses: terminated.map(({ pid, name }) => ({ pid, name }))
      });
      return { deleted: true, terminatedProcesses: terminated };
    } catch (error) {
      logger.error("force_delete.failed", {
        targetPath: normalized,
        terminatedProcesses: terminated.map(({ pid, name }) => ({ pid, name })),
        error: serializeError(error)
      });
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        code === "EPERM" || code === "EACCES" || code === "EBUSY"
          ? "目标仍被其他程序占用或当前权限不足；请关闭未列出的占用程序，或以管理员身份运行后重试"
          : `强制删除失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
