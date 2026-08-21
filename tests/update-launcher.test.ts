import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  await rm(fixtureRoot, { recursive: true, force: true });
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
    const fakeSpawn = ((executable: string) => {
      calls.push(executable);
      return spawnedChild(4242);
    }) as never;
    const result = await launchUpdaterHelper({
      primaryPath: "D:\\tools\\.cdriveshiftai-update\\helper.exe",
      fallbackPath:
        "D:\\tools\\CDriveShiftAI\\.cdriveshiftai-update-runner\\helper.exe",
      planPath: "D:\\tools\\.cdriveshiftai-update\\plan.json",
      forcePrimaryFailure: true,
      retryDelaysMs: [0],
      spawnProcess: fakeSpawn
    });
    expect(result.strategy).toBe("fallback-direct");
    expect(calls).toEqual([
      "D:\\tools\\CDriveShiftAI\\.cdriveshiftai-update-runner\\helper.exe"
    ]);
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
        planPath: "plan.json",
        retryDelaysMs: [0],
        spawnProcess: fakeSpawn
      })
    ).rejects.toThrow(/EACCES.*诊断报告/);
    expect(calls).toEqual(["primary.exe", "fallback.exe", "powershell.exe"]);
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
