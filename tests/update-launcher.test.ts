import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  launchUpdaterHelper,
  prepareUpdaterExecutable,
  updateRunnerDirectoryForExecutable
} from "../electron/update-launcher";

const fixtureRoot = path.join(
  process.cwd(),
  ".cdriveshiftai-data",
  "test-temp",
  "update-launcher-tests"
);

function spawnedChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref: () => void;
  };
  child.pid = pid;
  child.unref = () => undefined;
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function failedChild(code: string) {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    unref: () => void;
  };
  child.unref = () => undefined;
  queueMicrotask(() => {
    const error = new Error(`spawn failed: ${code}`) as NodeJS.ErrnoException;
    error.code = code;
    child.emit("error", error);
  });
  return child;
}

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("update helper launcher", () => {
  it("keeps the fallback runner inside the application directory", () => {
    expect(
      updateRunnerDirectoryForExecutable(
        "D:\\tools\\CDriveShiftAI\\CDriveShiftAI.exe"
      )
    ).toBe("D:\\tools\\CDriveShiftAI\\.cdriveshiftai-update-runner");
  });

  it("copies the native helper and validates its bytes", async () => {
    const source = path.join(fixtureRoot, "source.exe");
    const destination = path.join(fixtureRoot, "runner", "helper.exe");
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(source, Buffer.from("native-updater-fixture"));
    await prepareUpdaterExecutable(source, destination);
    expect(await readFile(destination)).toEqual(await readFile(source));
  });

  it("uses the visible fallback runner when the primary path is denied", async () => {
    const calls: string[] = [];
    const contexts: SpawnOptions[] = [];
    const staging = path.join(fixtureRoot, ".cdriveshiftai-update", "0.2.1");
    const primaryPath = path.join(staging, "helper.exe");
    const fallbackPath = path.join(fixtureRoot, "application", ".cdriveshiftai-update-runner", "helper.exe");
    const fakeSpawn = ((executable: string, _args: string[], options: SpawnOptions) => {
      calls.push(executable);
      contexts.push(options);
      return spawnedChild(4242);
    }) as never;
    const result = await launchUpdaterHelper({
      primaryPath,
      fallbackPath,
      planPath: path.join(staging, "plan.json"),
      forcePrimaryFailure: true,
      retryDelaysMs: [0],
      spawnProcess: fakeSpawn
    });
    expect(result.strategy).toBe("fallback-direct");
    expect(calls).toEqual([fallbackPath]);
    expect(contexts[0].cwd).toBe(staging);
    expect(contexts[0].env?.TEMP).toBe(path.join(staging, "temp"));
    expect(contexts[0].env?.TMP).toBe(path.join(staging, "temp"));
  });

  it("reports a useful error after direct and PowerShell launch methods fail", async () => {
    const calls: string[] = [];
    const fakeSpawn = ((executable: string) => {
      calls.push(executable);
      return failedChild("EACCES");
    }) as never;
    await expect(
      launchUpdaterHelper({
        primaryPath: "primary.exe",
        fallbackPath: "fallback.exe",
        planPath: path.join(fixtureRoot, "plan.json"),
        retryDelaysMs: [0],
        spawnProcess: fakeSpawn
      })
    ).rejects.toThrow(/EACCES.*诊断报告/);
    expect(calls).toEqual(["primary.exe", "fallback.exe", "powershell.exe"]);
  });

  it("launches an actual child in staging with local temporary paths without changing the parent", async () => {
    const staging = path.join(fixtureRoot, ".cdriveshiftai-update", "0.2.1");
    const probePath = path.join(fixtureRoot, "probe.cjs");
    const reportPath = path.join(fixtureRoot, "environment.json");
    const parent = { cwd: process.cwd(), TEMP: process.env.TEMP, TMP: process.env.TMP };
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(probePath, `require('node:fs').writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ cwd: process.cwd(), TEMP: process.env.TEMP, TMP: process.env.TMP }));`);
    const probeSpawn = ((_executable: string, _args: string[], options: SpawnOptions) =>
      spawn(process.execPath, [probePath], options)) as typeof spawn;
    const result = await launchUpdaterHelper({
      primaryPath: process.execPath,
      fallbackPath: process.execPath,
      planPath: path.join(staging, "update-plan.json"),
      spawnProcess: probeSpawn,
      retryDelaysMs: [0]
    });
    if (result.child.exitCode === null) await once(result.child, "exit");
    expect(result.child.exitCode).toBe(0);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual({
      cwd: staging,
      TEMP: path.join(staging, "temp"),
      TMP: path.join(staging, "temp")
    });
    expect((await stat(path.join(staging, "temp"))).isDirectory()).toBe(true);
    expect({ cwd: process.cwd(), TEMP: process.env.TEMP, TMP: process.env.TMP }).toEqual(parent);
  });

  it("passes the same staging context through PowerShell and its helper launch", async () => {
    const staging = path.join(fixtureRoot, "path with spaces");
    const parent = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    const calls: { executable: string; args: string[]; options: SpawnOptions }[] = [];
    const fakeSpawn = ((executable: string, args: string[], options: SpawnOptions) => {
      calls.push({ executable, args, options });
      const child = spawnedChild(4243);
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    }) as never;
    const result = await launchUpdaterHelper({
      primaryPath: "primary.exe",
      fallbackPath: path.join(fixtureRoot, "fallback.exe"),
      planPath: path.join(staging, "update-plan.json"),
      forceAllDirectFailures: true,
      retryDelaysMs: [0],
      spawnProcess: fakeSpawn
    });
    expect(result.strategy).toBe("fallback-powershell");
    expect(calls).toHaveLength(1);
    expect(calls[0].options.cwd).toBe(staging);
    expect(calls[0].options.env).toMatchObject({
      TEMP: path.join(staging, "temp"),
      TMP: path.join(staging, "temp"),
      CDRIVESHIFTAI_UPDATE_WORKDIR: staging,
      CDRIVESHIFTAI_UPDATE_PLAN: path.join(staging, "update-plan.json")
    });
    expect(calls[0].args.at(-1)).toContain("-WorkingDirectory $env:CDRIVESHIFTAI_UPDATE_WORKDIR");
    expect({ TEMP: process.env.TEMP, TMP: process.env.TMP }).toEqual(parent);
  });

  it.runIf(process.platform === "win32")(
    "passes a plan path containing spaces through the PowerShell fallback",
    async () => {
      const result = await launchUpdaterHelper({
        primaryPath: process.execPath,
        fallbackPath: process.execPath,
        planPath: path.join(fixtureRoot, "path with spaces", "update-plan.json"),
        forceAllDirectFailures: true,
        retryDelaysMs: [0]
      });
      expect(result.strategy).toBe("fallback-powershell");
    }
  );
});
