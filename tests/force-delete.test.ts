import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectLockScanFiles, sameProcessStartTime } from "../electron/file-locks";
import {
  commandLineReferencesTarget,
  ForceDeleteService,
  matchProcessesForTarget,
  normalizeForceDeletePath
} from "../electron/force-delete";

describe("controlled force deletion", () => {
  it("matches executables launched from the selected directory", () => {
    const matches = matchProcessesForTarget(
      [{
        pid: 4100,
        name: "tool.exe",
        executablePath: "E:\\Tools\\Example\\bin\\tool.exe",
        commandLine: "\"E:\\Tools\\Example\\bin\\tool.exe\" --serve"
      }],
      "E:\\Tools\\Example",
      true
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ pid: 4100, matchReason: "executable", canTerminate: true });
  });

  it("does not match sibling paths that merely share a prefix", () => {
    expect(
      commandLineReferencesTarget(
        "\"E:\\Tools\\Example-Backup\\tool.exe\"",
        "E:\\Tools\\Example"
      )
    ).toBe(false);
  });

  it("matches quoted and option-assigned target paths", () => {
    expect(
      commandLineReferencesTarget(
        "worker.exe --data=\"E:\\App Data\\Target\" --quiet",
        "E:\\App Data\\Target"
      )
    ).toBe(true);
  });

  it("never marks protected Windows processes as terminable", () => {
    const matches = matchProcessesForTarget(
      [{
        pid: 812,
        name: "explorer.exe",
        executablePath: "C:\\Windows\\explorer.exe",
        commandLine: "explorer.exe \"E:\\Target\""
      }],
      "E:\\Target",
      true
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.canTerminate).toBe(false);
  });

  it("canonicalizes long-path prefixes before applying protection", () => {
    expect(normalizeForceDeletePath("\\\\?\\C:\\Windows\\System32")).toBe("C:\\Windows\\System32");
    expect(normalizeForceDeletePath("\\\\?\\UNC\\server\\share\\folder")).toBe("\\\\server\\share\\folder");
  });

  it.each(["", ".", "E:relative", "E:\\", "\\\\server\\share", "\\\\server\\share\\folder\\..", "\\\\.\\PhysicalDrive0", "E:\\target:stream", "E:\\tar*", "E:\\target."])(
    "rejects ambiguous or protected target %s",
    (target) => expect(() => normalizeForceDeletePath(target)).toThrow()
  );
});

const fixtureRoots: string[] = [];
const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

afterEach(async () => {
  vi.restoreAllMocks();
  const workspace = path.resolve(".");
  for (const root of fixtureRoots.splice(0)) {
    if (!root.startsWith(`${workspace}${path.sep}.force-delete-test-`)) throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function createFixture() {
  const root = await mkdtemp(path.join(path.resolve("."), ".force-delete-test-"));
  fixtureRoots.push(root);
  const target = path.join(root, "target");
  const applicationRoot = path.join(root, "application");
  const dataRoot = path.join(root, "application-data");
  await Promise.all([mkdir(target), mkdir(applicationRoot), mkdir(dataRoot)]);
  await writeFile(path.join(target, "test.txt"), "payload");
  const records = [{ pid: 541001, name: "editor.exe", commandLine: `editor.exe "${target}"`, creationTime: "123" }];
  const operations = {
    listProcesses: vi.fn(async () => records),
    terminateProcess: vi.fn(async (_pid: number, _creationTime: string) => true),
    remove: vi.fn(async (entry: string, _retry: boolean) => { await rm(entry, { recursive: true, force: true }); })
  };
  const options = {
    applicationExecutable: path.join(applicationRoot, "main.exe"),
    applicationDataRoot: dataRoot,
    createVerificationId: () => "test-verification"
  };
  return { root, target, applicationRoot, dataRoot, records, operations, options, service: new ForceDeleteService(options, operations) };
}

function busyError(target: string, code = "EBUSY") {
  return Object.assign(new Error("locked"), { code, path: target });
}

windowsDescribe("force deletion filesystem and process boundaries", () => {
  it("requests elevation only after ordinary deletion and its retry fail", async () => {
    const fixture = await createFixture();
    const removeElevated = vi.fn(async (request: { path: string }) => { await rm(request.path, { recursive: true }); });
    fixture.operations.remove.mockRejectedValue(busyError(fixture.target, "EACCES"));
    fixture.operations.terminateProcess.mockResolvedValue(false);
    const service = new ForceDeleteService(fixture.options, { ...fixture.operations, removeElevated });
    const preview = await service.preview(fixture.target);
    const result = await service.execute(preview.verificationId);
    expect(result).toMatchObject({ deleted: true, usedElevation: true });
    expect(fixture.operations.remove).toHaveBeenCalledTimes(2);
    expect(removeElevated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: fixture.target,
      expectedIdentity: expect.any(String), processes: [expect.objectContaining({ pid: fixture.records[0].pid, creationTime: "123" })] }));
    await expect(service.execute(preview.verificationId)).rejects.toThrow("确认已过期");
  });

  it("never requests UAC after successful ordinary deletion", async () => {
    const fixture = await createFixture();
    const removeElevated = vi.fn(async () => undefined);
    const service = new ForceDeleteService(fixture.options, { ...fixture.operations, removeElevated });
    await service.execute((await service.preview(fixture.target)).verificationId);
    expect(removeElevated).not.toHaveBeenCalled();
  });

  it.each(["EIO", "ENOSPC"])("does not escalate unrelated filesystem errors (%s)", async (code) => {
    const fixture = await createFixture();
    fixture.operations.remove.mockRejectedValue(busyError(fixture.target, code));
    const removeElevated = vi.fn(async () => undefined);
    const service = new ForceDeleteService(fixture.options, { ...fixture.operations, removeElevated });
    await expect(service.execute((await service.preview(fixture.target)).verificationId)).rejects.toThrow();
    expect(removeElevated).not.toHaveBeenCalled();
  });

  it("keeps UAC cancellation distinct, consumes confirmation and releases the operation lock", async () => {
    const fixture = await createFixture();
    fixture.operations.remove.mockRejectedValue(busyError(fixture.target));
    const removeElevated = vi.fn(async () => { throw new Error("DELETE_ELEVATION_CANCELLED：已取消管理员权限授权"); });
    const service = new ForceDeleteService(fixture.options, { ...fixture.operations, removeElevated });
    const preview = await service.preview(fixture.target);
    await expect(service.execute(preview.verificationId)).rejects.toThrow("DELETE_ELEVATION_CANCELLED");
    await expect(service.execute(preview.verificationId)).rejects.toThrow("确认已过期");
    expect(service.isBusy()).toBe(false);
    expect(await lstat(fixture.target)).toBeDefined();
  });

  it("does not trust a successful elevated command when the file is still present", async () => {
    const fixture = await createFixture();
    fixture.operations.remove.mockRejectedValue(busyError(fixture.target));
    const service = new ForceDeleteService(fixture.options, { ...fixture.operations, removeElevated: async () => undefined });
    await expect(service.execute((await service.preview(fixture.target)).verificationId)).rejects.toThrow("目标仍然存在");
  });

  it("waits for the elevated operation before allowing exit or another overlapping deletion", async () => {
    const fixture = await createFixture();
    fixture.operations.remove.mockRejectedValue(busyError(fixture.target));
    let release = () => {};
    let entered = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const service = new ForceDeleteService(fixture.options, { ...fixture.operations, removeElevated: async () => {
      entered(); await pending; await rm(fixture.target, { recursive: true });
    } });
    const execution = service.execute((await service.preview(fixture.target)).verificationId);
    await started;
    expect(service.isBusy()).toBe(true);
    let idle = false;
    const waiting = service.whenIdle().then(() => { idle = true; });
    await Promise.resolve(); expect(idle).toBe(false);
    release(); await Promise.all([execution, waiting]);
    expect(idle).toBe(true);
  });
  it("deletes an unlocked target without killing a merely related process", async () => {
    const { service, target, operations } = await createFixture();
    const preview = await service.preview(target);
    expect(preview.processes).toHaveLength(1);
    await expect(service.execute(preview.verificationId)).resolves.toEqual({ deleted: true, terminatedProcesses: [] });
    expect(operations.terminateProcess).not.toHaveBeenCalled();
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not depend on CIM being available to remove an unlocked file", async () => {
    const { service, target, operations } = await createFixture();
    operations.listProcesses.mockRejectedValue(new Error("CIM unavailable"));
    const preview = await service.preview(target);
    expect(preview.processes).toEqual([]);
    await expect(service.execute(preview.verificationId)).resolves.toMatchObject({ deleted: true });
  });

  it("stops an approved, unchanged process only after deletion fails and retries", async () => {
    const { service, target, operations } = await createFixture();
    operations.remove.mockRejectedValueOnce(busyError(target));
    const preview = await service.preview(target);
    const result = await service.execute(preview.verificationId);
    expect(result.terminatedProcesses.map((item) => item.pid)).toEqual([541001]);
    expect(operations.terminateProcess).toHaveBeenCalledExactlyOnceWith(541001, "123");
    expect(operations.remove.mock.calls.map((call) => call[1])).toEqual([false, true]);
  });

  it("does not kill a reused PID or a process absent from the confirmation", async () => {
    const { service, target, operations, records } = await createFixture();
    const preview = await service.preview(target);
    operations.listProcesses.mockResolvedValue([
      { ...records[0], creationTime: "different-process" },
      { ...records[0], pid: 541002 }
    ]);
    operations.remove.mockRejectedValue(busyError(target));
    await expect(service.execute(preview.verificationId)).rejects.toThrow("EBUSY");
    expect(operations.terminateProcess).not.toHaveBeenCalled();
    expect(await readFile(path.join(target, "test.txt"), "utf8")).toBe("payload");
  });

  it("retries deletion even if an unrelated listed process could not be stopped", async () => {
    const { service, target, operations } = await createFixture();
    operations.remove.mockRejectedValueOnce(busyError(target));
    operations.terminateProcess.mockResolvedValue(false);
    const preview = await service.preview(target);
    await expect(service.execute(preview.verificationId)).resolves.toMatchObject({ deleted: true, terminatedProcesses: [] });
  });

  it("protects this application's helper processes", async () => {
    const { service, target, operations, records } = await createFixture();
    operations.listProcesses.mockResolvedValue([{ ...records[0], parentPid: process.pid }]);
    const preview = await service.preview(target);
    expect(preview.processes[0]?.canTerminate).toBe(false);
  });

  it("refuses to delete a replacement inserted after preview", async () => {
    const { service, target, root, operations } = await createFixture();
    const preview = await service.preview(target);
    await rename(target, path.join(root, "original"));
    await mkdir(target);
    await writeFile(path.join(target, "replacement.txt"), "keep me");
    await expect(service.execute(preview.verificationId)).rejects.toThrow("目标在预检后已被替换");
    expect(operations.remove).not.toHaveBeenCalled();
    expect(await readFile(path.join(target, "replacement.txt"), "utf8")).toBe("keep me");
  });

  it("treats an already removed target as success and consumes the confirmation once", async () => {
    const { service, target, operations } = await createFixture();
    const preview = await service.preview(target);
    await rm(target, { recursive: true });
    await expect(service.execute(preview.verificationId)).resolves.toMatchObject({ deleted: true });
    await expect(service.execute(preview.verificationId)).rejects.toThrow("确认已过期");
    expect(operations.terminateProcess).not.toHaveBeenCalled();
  });

  it("does not report success if a writer recreates the target during deletion", async () => {
    const { service, target, operations } = await createFixture();
    operations.remove.mockImplementation(async (entry) => {
      await rm(entry, { recursive: true });
      await mkdir(entry);
    });
    const preview = await service.preview(target);
    await expect(service.execute(preview.verificationId)).rejects.toThrow("仍然存在或已被其他程序重新创建");
  });

  it("protects application data children through directory junction aliases", async () => {
    const { service, root, dataRoot } = await createFixture();
    const alias = path.join(root, "data-alias");
    await writeFile(path.join(dataRoot, "settings.json"), "{}");
    await symlink(dataRoot, alias, "junction");
    await expect(service.preview(path.join(dataRoot, "settings.json"))).rejects.toThrow("当前程序或数据");
    await expect(service.preview(path.join(alias, "settings.json"))).rejects.toThrow("当前程序或数据");
  });

  it("deletes a junction itself without touching the linked files or stopping their processes", async () => {
    const { service, root, target, operations } = await createFixture();
    const alias = path.join(root, "alias");
    await symlink(target, alias, "junction");
    const preview = await service.preview(alias);
    expect(preview.isSymbolicLink).toBe(true);
    expect(preview.processes).toEqual([]);
    await service.execute(preview.verificationId);
    expect(await readFile(path.join(target, "test.txt"), "utf8")).toBe("payload");
    expect(operations.listProcesses).not.toHaveBeenCalled();
  });

  it("preserves an external junction target when removing a directory with read-only files", async () => {
    const { service, root, target } = await createFixture();
    const external = path.join(root, "external");
    await mkdir(external);
    const externalFile = path.join(external, "must-stay.txt");
    await writeFile(externalFile, "keep");
    await chmod(externalFile, 0o444);
    await chmod(path.join(target, "test.txt"), 0o444);
    await symlink(external, path.join(target, "external-link"), "junction");
    const before = (await lstat(externalFile)).mode;
    const preview = await service.preview(target);
    await service.execute(preview.verificationId);
    expect(await readFile(externalFile, "utf8")).toBe("keep");
    expect((await lstat(externalFile)).mode).toBe(before);
  });

  it("preserves the target when migration protection changes after preview", async () => {
    const { target, options, operations } = await createFixture();
    let protectedNow = false;
    const assertPathAllowed = vi.fn(() => { if (protectedNow) throw new Error("正在迁移"); });
    const service = new ForceDeleteService({ ...options, assertPathAllowed }, operations);
    const preview = await service.preview(target);
    protectedNow = true;
    await expect(service.execute(preview.verificationId)).rejects.toThrow("正在迁移");
    expect(operations.remove).not.toHaveBeenCalled();
    expect(operations.terminateProcess).not.toHaveBeenCalled();
  });

  it("checks migration protection again before stopping a process", async () => {
    const { target, options, operations } = await createFixture();
    let protectedNow = false;
    const service = new ForceDeleteService({ ...options, assertPathAllowed: () => { if (protectedNow) throw new Error("正在迁移"); } }, operations);
    const preview = await service.preview(target);
    operations.remove.mockRejectedValueOnce(busyError(target));
    operations.listProcesses.mockImplementation(async () => {
      protectedNow = true;
      return [{ pid: 541001, name: "editor.exe", commandLine: `editor.exe "${target}"`, creationTime: "123" }];
    });
    await expect(service.execute(preview.verificationId)).rejects.toThrow("正在迁移");
    expect(operations.terminateProcess).not.toHaveBeenCalled();
  });

  it("reports permission code and the failing child path instead of promising elevation fixes it", async () => {
    const { service, target, operations } = await createFixture();
    operations.remove.mockRejectedValue(busyError(path.join(target, "test.txt"), "EACCES"));
    const preview = await service.preview(target);
    await expect(service.execute(preview.verificationId)).rejects.toThrow(`（EACCES）：${path.join(target, "test.txt")}`);
  });

  it("matches actual file handles even when the process command line has no target path", async () => {
    const { target, options, operations } = await createFixture();
    operations.listProcesses.mockResolvedValue([{ pid: 541001, name: "editor.exe", commandLine: "editor.exe", creationTime: "1230" }]);
    const service = new ForceDeleteService(options, {
      ...operations,
      listFileLocks: async () => ({ processes: [{ pid: 541001, creationTime: "1237", protected: false }], warnings: [] })
    });
    operations.remove.mockRejectedValueOnce(busyError(target));
    const preview = await service.preview(target);
    expect(preview.processes).toEqual([expect.objectContaining({ pid: 541001, matchReason: "file-handle", canTerminate: true })]);
    await service.execute(preview.verificationId);
    expect(operations.terminateProcess).toHaveBeenCalledExactlyOnceWith(541001, "1230");
  });

  it("rejects a stale lock-holder PID with a different process start time", async () => {
    const { target, options, operations } = await createFixture();
    operations.listProcesses.mockResolvedValue([{ pid: 541001, name: "editor.exe", commandLine: "editor.exe", creationTime: "1230" }]);
    const service = new ForceDeleteService(options, {
      ...operations,
      listFileLocks: async () => ({ processes: [{ pid: 541001, creationTime: "2230", protected: false }], warnings: [] })
    });
    expect((await service.preview(target)).processes).toEqual([]);
  });

  it("never marks Restart Manager services or critical processes as terminable", async () => {
    const { target, options, operations } = await createFixture();
    const service = new ForceDeleteService(options, {
      ...operations,
      listFileLocks: async () => ({ processes: [{ pid: 541001, creationTime: "123", protected: true }], warnings: [] })
    });
    const preview = await service.preview(target);
    expect(preview.processes[0]).toMatchObject({ matchReason: "file-handle", canTerminate: false });
  });

  it("displays lock holders without readable identity as protected", async () => {
    const { target, options, operations } = await createFixture();
    operations.listProcesses.mockRejectedValue(new Error("CIM unavailable"));
    const service = new ForceDeleteService(options, {
      ...operations,
      listFileLocks: async () => ({ processes: [{ pid: 541001, creationTime: "123", protected: false }], warnings: [] })
    });
    const preview = await service.preview(target);
    expect(preview.processes[0]).toMatchObject({ pid: 541001, canTerminate: false });
    expect(preview.processWarnings?.join("")).toContain("无法读取进程身份");
  });

  it("falls back to command-line matching with a visible warning if handle queries fail", async () => {
    const { target, options, operations } = await createFixture();
    const service = new ForceDeleteService(options, { ...operations, listFileLocks: async () => { throw new Error("Restart Manager unavailable"); } });
    const preview = await service.preview(target);
    expect(preview.processes[0]?.matchReason).toBe("command-line");
    expect(preview.processWarnings?.join("")).toContain("文件占用查询失败");
    await expect(service.execute(preview.verificationId)).resolves.toMatchObject({ deleted: true });
  });

  it("does not scan through external junctions and bounds the visited entry count", async () => {
    const { target, root } = await createFixture();
    const external = path.join(root, "external");
    await mkdir(external);
    await writeFile(path.join(external, "outside.txt"), "keep");
    await symlink(external, path.join(target, "alias"), "junction");
    const scan = await collectLockScanFiles(target);
    expect(scan.files).toEqual([path.join(target, "test.txt")]);
    expect(scan.incomplete).toBe(false);
    for (let index = 0; index < 8; index += 1) await writeFile(path.join(target, `${index}.txt`), "test");
    const bounded = await collectLockScanFiles(target, 4);
    expect(bounded.incomplete).toBe(true);
    expect(bounded.files.length).toBeLessThanOrEqual(3);
  });

  it("treats file names containing script syntax as literal scan data", async () => {
    const { target } = await createFixture();
    const literalFile = path.join(target, "[中文] a'$().txt");
    await writeFile(literalFile, "literal");
    expect((await collectLockScanFiles(target)).files).toContain(literalFile);
  });

  it("waits for executing deletion before reporting idle", async () => {
    const { service, target, operations } = await createFixture();
    let release: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    operations.remove.mockImplementation(async (entry) => { await paused; await rm(entry, { recursive: true }); });
    const preview = await service.preview(target);
    const execution = service.execute(preview.verificationId);
    expect(service.isBusy()).toBe(true);
    let idle = false;
    const waiting = service.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await Promise.all([execution, waiting]);
    expect(service.isBusy()).toBe(false);
  });

  it("blocks concurrent deletions of overlapping targets", async () => {
    const { target, options, operations } = await createFixture();
    let verification = 0;
    const service = new ForceDeleteService({ ...options, createVerificationId: () => String(++verification) }, operations);
    let release: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    operations.remove.mockImplementation(async (entry) => { await paused; await rm(entry, { recursive: true }); });
    const first = await service.preview(target);
    const second = await service.preview(path.join(target, "test.txt"));
    const execution = service.execute(first.verificationId);
    await expect(service.execute(second.verificationId)).rejects.toThrow("正在强制删除");
    release();
    await execution;
  });
});

describe("Restart Manager process identities", () => {
  it("compares file-time precision without losing integer precision", () => {
    expect(sameProcessStartTime("639200000000000000", "639200000000000009")).toBe(true);
    expect(sameProcessStartTime("639200000000000000", "639200000000000010")).toBe(false);
    expect(sameProcessStartTime(undefined, "639200000000000000")).toBe(false);
    expect(sameProcessStartTime("invalid", "639200000000000000")).toBe(false);
  });
});
