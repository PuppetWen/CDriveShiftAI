import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { logger, serializeError } from "./logger";

const RETRY_DELAYS_MS = [0, 300, 900];
const INTERNAL_RUNNER_DIRECTORY = ".cdriveshiftai-update-runner";

type SpawnProcess = typeof spawn;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function updateRunnerDirectoryForExecutable(
  executablePath: string
): string {
  return path.join(
    path.dirname(path.resolve(executablePath)),
    INTERNAL_RUNNER_DIRECTORY
  );
}

async function sha512(candidate: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha512");
    const stream = createReadStream(candidate);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

export async function prepareUpdaterExecutable(
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await rm(destinationPath, { force: true });
  await copyFile(sourcePath, destinationPath);
  await chmod(destinationPath, 0o755).catch(() => undefined);
  if (process.platform === "win32") {
    await rm(`${destinationPath}:Zone.Identifier`, { force: true }).catch(
      () => undefined
    );
  }
  const [sourceHash, destinationHash] = await Promise.all([
    sha512(sourcePath),
    sha512(destinationPath)
  ]);
  if (sourceHash !== destinationHash) {
    await rm(destinationPath, { force: true }).catch(() => undefined);
    throw new Error("更新助手复制后校验失败");
  }
}

function spawnAndConfirm(
  executable: string,
  args: string[],
  spawnProcess: SpawnProcess,
  environment?: NodeJS.ProcessEnv
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(executable, args, {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: environment ?? process.env
      });
    } catch (error) {
      reject(error);
      return;
    }
    const onSpawn = () => {
      child.removeListener("error", onError);
      resolve(child);
    };
    const onError = (error: Error) => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function spawnAndWait(
  executable: string,
  args: string[],
  spawnProcess: SpawnProcess,
  environment: NodeJS.ProcessEnv
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(executable, args, {
        windowsHide: true,
        stdio: "ignore",
        env: environment
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(child);
      else reject(new Error(`${path.basename(executable)} exited with code ${code}`));
    });
  });
}

async function directLaunch(
  candidate: string,
  planPath: string,
  spawnProcess: SpawnProcess,
  forcedFailure: boolean,
  retryDelaysMs: number[]
): Promise<ChildProcess> {
  let lastError: unknown;
  for (let index = 0; index < retryDelaysMs.length; index += 1) {
    if (retryDelaysMs[index] > 0) await delay(retryDelaysMs[index]);
    try {
      if (forcedFailure) {
        const simulated = new Error("Simulated primary helper EACCES") as NodeJS.ErrnoException;
        simulated.code = "EACCES";
        throw simulated;
      }
      const child = await spawnAndConfirm(
        candidate,
        ["--plan", planPath],
        spawnProcess
      );
      logger.info("update.helper_spawned", {
        strategy: "direct",
        candidate,
        attempt: index + 1,
        childPid: child.pid
      });
      return child;
    } catch (error) {
      lastError = error;
      logger.warn("update.helper_spawn_failed", {
        strategy: "direct",
        candidate,
        attempt: index + 1,
        error: serializeError(error)
      });
    }
  }
  throw lastError;
}

async function powershellLaunch(
  candidate: string,
  planPath: string,
  spawnProcess: SpawnProcess
): Promise<ChildProcess> {
  const environment = {
    ...process.env,
    CDRIVESHIFTAI_UPDATE_HELPER: candidate,
    CDRIVESHIFTAI_UPDATE_PLAN: planPath
  };
  const script = [
    "$ErrorActionPreference='Stop'",
    "$plan='\"'+$env:CDRIVESHIFTAI_UPDATE_PLAN.Replace('\"','\\\"')+'\"'",
    "$p=Start-Process -FilePath $env:CDRIVESHIFTAI_UPDATE_HELPER -ArgumentList @('--plan',$plan) -WindowStyle Hidden -PassThru",
    "if($null -eq $p){exit 7}"
  ].join(";");
  const child = await spawnAndWait(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    spawnProcess,
    environment
  );
  logger.info("update.helper_spawned", {
    strategy: "powershell-start-process",
    candidate,
    childPid: child.pid
  });
  return child;
}

export interface LaunchUpdaterOptions {
  primaryPath: string;
  fallbackPath: string;
  planPath: string;
  spawnProcess?: SpawnProcess;
  forcePrimaryFailure?: boolean;
  forceAllDirectFailures?: boolean;
  retryDelaysMs?: number[];
}

export async function launchUpdaterHelper(
  options: LaunchUpdaterOptions
): Promise<{ child: ChildProcess; strategy: string; executable: string }> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const retryDelaysMs = options.retryDelaysMs?.length
    ? options.retryDelaysMs
    : RETRY_DELAYS_MS;
  const failures: unknown[] = [];
  for (const [index, candidate] of [options.primaryPath, options.fallbackPath].entries()) {
    try {
      const child = await directLaunch(
        candidate,
        options.planPath,
        spawnProcess,
        options.forceAllDirectFailures === true ||
          (index === 0 && options.forcePrimaryFailure === true),
        retryDelaysMs
      );
      child.on("error", (error) => {
        logger.error("update.helper_post_spawn_error", {
          candidate,
          error: serializeError(error)
        });
      });
      child.unref();
      return {
        child,
        strategy: index === 0 ? "primary-direct" : "fallback-direct",
        executable: candidate
      };
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    const child = await powershellLaunch(
      options.fallbackPath,
      options.planPath,
      spawnProcess
    );
    child.unref();
    return {
      child,
      strategy: "fallback-powershell",
      executable: options.fallbackPath
    };
  } catch (error) {
    failures.push(error);
    logger.error("update.helper_launch_exhausted", {
      primaryPath: options.primaryPath,
      fallbackPath: options.fallbackPath,
      failures: failures.map(serializeError)
    });
    const codes = failures
      .map((failure) => (failure as NodeJS.ErrnoException)?.code)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `无法启动更新助手${codes ? `（${codes}）` : ""}；更新包与旧版本均已保留，请导出诊断报告后手动安装`
    );
  }
}
