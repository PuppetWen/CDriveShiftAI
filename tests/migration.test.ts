import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  migrationRobocopyArguments,
  normalizeReparseTarget,
  renameWithRetry,
  runRobocopy
} from "../electron/migration";
import { MigrationService } from "../electron/migration";
import { assertRecordedLink, relocatedReparseTarget, verifyMigrationCopy } from "../electron/migration-copy";
import { copyMigrationPermissions } from "../electron/migration-permissions";
import type { AppStore } from "../electron/store";
import type { MigrationRecord, PreflightResult } from "../electron/types";

describe("migration copy options", () => {
  it("copies junctions and symbolic links as links instead of expanding or excluding them", () => {
    const argumentsList = migrationRobocopyArguments("C:\\source", "D:\\destination");

    expect(argumentsList).toContain("/SJ");
    expect(argumentsList).toContain("/SL");
    expect(argumentsList).not.toContain("/XJ");
    expect(argumentsList).toContain("/COPY:DATS");
    expect(argumentsList).toContain("/SECFIX");
  });

  it("retries a transient Windows rename error and then succeeds", async () => {
    const attempts: string[] = [];
    const waits: number[] = [];
    await renameWithRetry("C:\\source", "D:\\destination", {
      retryDelaysMs: [10, 20],
      renameEntry: async () => {
        attempts.push("rename");
        if (attempts.length < 3) {
          const error = new Error("temporarily busy") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
      },
      destinationExists: async () => false,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      }
    });

    expect(attempts).toHaveLength(3);
    expect(waits).toEqual([10, 20]);
  });

  it("does not retry when another process creates the destination", async () => {
    const error = new Error("destination conflict") as NodeJS.ErrnoException;
    error.code = "EPERM";

    await expect(
      renameWithRetry("C:\\source", "D:\\destination", {
        operation: "发布目标目录",
        retryDelaysMs: [10],
        renameEntry: async () => {
          throw error;
        },
        destinationExists: async () => true,
        wait: async () => undefined
      })
    ).rejects.toThrow("目标路径在迁移期间已被其他程序创建");
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("preserves a directory junction when robocopy runs", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "cdriveshift-copy-"));
    try {
      const source = path.join(temporaryRoot, "source");
      const target = path.join(source, "versioned");
      const destination = path.join(temporaryRoot, "destination");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "manifest.json"), "{}", "utf8");
      await symlink(target, path.join(source, "latest"), "junction");

      await runRobocopy(source, destination);

      const copiedLink = path.join(destination, "latest");
      expect((await lstat(copiedLink)).isSymbolicLink()).toBe(true);
      expect(normalizeReparseTarget(await readlink(copiedLink))).toBe(
        normalizeReparseTarget(target)
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("migration link relocation", () => {
  it("keeps internal relative links and anchors external relative links to their original parent", () => {
    expect(relocatedReparseTarget("version1", "latest", "C:\\Apps\\App", "C:\\Apps\\App")).toBe("version1");
    expect(relocatedReparseTarget("..\\shared", "shared", "C:\\Apps\\App", "C:\\Apps\\App")).toBe("C:\\Apps\\shared");
  });

  it("moves absolute links created inside the migrated directory back to the restored root", () => {
    expect(relocatedReparseTarget("\\??\\D:\\Moved\\App\\versions\\1", "latest", "D:\\Moved\\App", "C:\\Apps\\App")).toBe("C:\\Apps\\App\\versions\\1");
    expect(normalizeReparseTarget("\\\\?\\UNC\\server\\share\\App")).toBe("\\\\server\\share\\app");
  });
});

function memoryStore(initial: MigrationRecord[] = []) {
  const records = new Map(initial.map((record) => [record.id, structuredClone(record)]));
  return {
    store: {
      getAnalysis: () => undefined,
      saveMigration: async (record: MigrationRecord) => { records.set(record.id, structuredClone(record)); },
      getMigration: (id: string) => records.has(id) ? structuredClone(records.get(id)) : undefined,
      listMigrations: () => [...records.values()].map((record) => structuredClone(record))
    } as unknown as AppStore,
    records
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cdriveshift-transaction-"));
  const source = path.join(root, "App");
  const destinationBase = path.join(root, "moved");
  const destination = path.join(destinationBase, "App");
  await mkdir(source);
  await mkdir(destinationBase);
  await writeFile(path.join(source, "app.json"), '{"ready":true}', "utf8");
  await writeFile(path.join(source, "state.json"), "user data", "utf8");
  const preflight: PreflightResult = {
    allowed: true, source, destinationBase, finalDestination: destination,
    requiredBytes: 23, availableBytes: 1024 ** 4, fileCount: 2, directoryCount: 1,
    reparsePointCount: 0, risk: "low", warnings: [], blockers: []
  };
  return {
    root, source, destinationBase, destination, preflight,
    cleanup: async () => {
      const resolved = await realpath(root);
      const expectedParent = await realpath(os.tmpdir());
      if (path.dirname(resolved).toLowerCase() !== expectedParent.toLowerCase() || !path.basename(resolved).startsWith("cdriveshift-transaction-")) throw new Error("Unsafe test cleanup path");
      await rm(resolved, { recursive: true, force: true });
    }
  };
}

function recordFor(source: string, destination: string, extra: Partial<MigrationRecord> = {}): MigrationRecord {
  return {
    id: "12345678-1234-1234-1234-123456789abc", source, destination,
    stage: "linked", linkType: "junction", totalBytes: 23, copiedBytes: 23,
    migrationCount: 1, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), warnings: [], ...extra
  };
}

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;
windowsDescribe("migration filesystem transaction regressions", () => {
  it("keeps child ACL inheritance and leaves external junction targets untouched in the permission fallback", async () => {
    const f = await fixture();
    const execFileAsync = promisify(execFile);
    try {
      const external = path.join(f.root, "external");
      await mkdir(external);
      await mkdir(path.join(f.source, "child"));
      await writeFile(path.join(f.source, "child", "data.txt"), "data", "utf8");
      await symlink(external, path.join(f.source, "external-link"), "junction");
      await runRobocopy(f.source, f.destination);
      const env = { ...process.env, CDRIVE_TEST_DESTINATION: f.destination, CDRIVE_TEST_EXTERNAL: external };
      const readExternalAcl = async () => (await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[IO.Directory]::GetAccessControl($env:CDRIVE_TEST_EXTERNAL).Sddl"], { env, windowsHide: true })).stdout.trim();
      const externalBefore = await readExternalAcl();
      await copyMigrationPermissions(f.source, f.destination);
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$acl = [IO.Directory]::GetAccessControl($env:CDRIVE_TEST_DESTINATION)
$sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-546')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($env:CDRIVE_TEST_DESTINATION, $acl)
$child = [IO.File]::GetAccessControl([IO.Path]::Combine($env:CDRIVE_TEST_DESTINATION, 'child\\data.txt'))
$inherited = @($child.GetAccessRules($false, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-546' })
@{ protected = $child.AreAccessRulesProtected; inheritsNewGrant = ($inherited.Count -gt 0) } | ConvertTo-Json -Compress
`], { env, windowsHide: true });
      expect(JSON.parse(stdout.trim())).toEqual({ protected: false, inheritsNewGrant: true });
      expect(await readExternalAcl()).toBe(externalBefore);
    } finally { await f.cleanup(); }
  }, 20_000);

  it("preserves explicit NTFS directory access permissions", async () => {
    const f = await fixture();
    const execFileAsync = promisify(execFile);
    const env = { ...process.env, CDRIVE_TEST_SOURCE: f.source, CDRIVE_TEST_DESTINATION: f.destination };
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$acl = [IO.Directory]::GetAccessControl($env:CDRIVE_TEST_SOURCE)
$sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($env:CDRIVE_TEST_SOURCE, $acl)
`], { env, windowsHide: true });
      await runRobocopy(f.source, f.destination);
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$sections = [System.Security.AccessControl.AccessControlSections]::Access
@{
  source = [IO.Directory]::GetAccessControl($env:CDRIVE_TEST_SOURCE).GetSecurityDescriptorSddlForm($sections)
  destination = [IO.Directory]::GetAccessControl($env:CDRIVE_TEST_DESTINATION).GetSecurityDescriptorSddlForm($sections)
} | ConvertTo-Json -Compress
`], { env, windowsHide: true });
      const acl = JSON.parse(stdout.trim()) as { source: string; destination: string };
      expect(acl.destination).toBe(acl.source);
    } finally { await f.cleanup(); }
  }, 20_000);

  it("detects same-size corrupt contents and substituted filenames", async () => {
    const f = await fixture();
    try {
      await runRobocopy(f.source, f.destination);
      await writeFile(path.join(f.destination, "state.json"), "bad! data", "utf8");
      await expect(verifyMigrationCopy(f.source, f.destination)).rejects.toThrow("文件内容不一致");
      await writeFile(path.join(f.destination, "state.json"), "user data", "utf8");
      await rename(path.join(f.destination, "state.json"), path.join(f.destination, "other.json"));
      await expect(verifyMigrationCopy(f.source, f.destination)).rejects.toThrow("目录条目不一致");
    } finally { await f.cleanup(); }
  }, 20_000);

  it("rejects a replaced junction even when it is still a valid link", async () => {
    const f = await fixture();
    try {
      await rename(f.source, f.destination);
      const foreign = path.join(f.root, "foreign");
      await mkdir(foreign);
      await symlink(foreign, f.source, "junction");
      const { store } = memoryStore([recordFor(f.source, f.destination)]);
      const service = new MigrationService(store, () => undefined);
      await expect(service.rollback("12345678-1234-1234-1234-123456789abc")).rejects.toThrow("不再指向记录中的目标");
      expect(normalizeReparseTarget(await readlink(f.source))).toBe(normalizeReparseTarget(foreign));
      expect(await readFile(path.join(f.destination, "state.json"), "utf8")).toBe("user data");
    } finally { await f.cleanup(); }
  });

  it("keeps application files and junctions usable through migrate, rollback, and reapply", async () => {
    const f = await fixture();
    try {
      const version = path.join(f.source, "versions", "one");
      await mkdir(version, { recursive: true });
      await writeFile(path.join(version, "manifest.json"), "working", "utf8");
      await symlink(version, path.join(f.source, "latest"), "junction");
      const { store } = memoryStore();
      const service = new MigrationService(store, () => undefined);
      // Same-volume fixture isolates the transaction; production preflight still
      // requires different NTFS volumes.
      vi.spyOn(service, "preflight").mockResolvedValue(f.preflight);
      const migrated = await service.execute(f.source, f.destinationBase);
      expect(migrated.stage).toBe("linked");
      expect(await readFile(path.join(f.source, "latest", "manifest.json"), "utf8")).toBe("working");
      await writeFile(path.join(f.source, "state.json"), "new app data", "utf8");
      await symlink(path.join(f.destination, "versions", "one"), path.join(f.destination, "new-latest"), "junction");
      const restored = await service.rollback(migrated.id);
      expect(restored.stage).toBe("rolled-back");
      expect((await lstat(f.source)).isSymbolicLink()).toBe(false);
      expect(await readFile(path.join(f.source, "new-latest", "manifest.json"), "utf8")).toBe("working");
      expect(await readFile(path.join(f.source, "state.json"), "utf8")).toBe("new app data");
      await expect(lstat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
      const reapplied = await service.reapply(migrated.id);
      expect(reapplied.stage).toBe("linked");
      expect(reapplied.migrationCount).toBe(2);
      expect(await readFile(path.join(f.source, "new-latest", "manifest.json"), "utf8")).toBe("working");
      expect(await readFile(path.join(f.source, "state.json"), "utf8")).toBe("new app data");
    } finally { await f.cleanup(); }
  }, 30_000);

  it("verifies parent-relative internal links against the logical source after backup renaming", async (context) => {
    const f = await fixture();
    try {
      await mkdir(path.join(f.source, "versions", "one"), { recursive: true });
      await writeFile(path.join(f.source, "versions", "one", "manifest.json"), "works", "utf8");
      try {
        await symlink("..\\App\\versions\\one", path.join(f.source, "latest"), "dir");
      } catch (error) {
        if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { context.skip(); return; }
        throw error;
      }
      const { store } = memoryStore();
      const service = new MigrationService(store, () => undefined);
      vi.spyOn(service, "preflight").mockResolvedValue(f.preflight);
      expect((await service.execute(f.source, f.destinationBase)).stage).toBe("linked");
      expect(await readFile(path.join(f.source, "latest", "manifest.json"), "utf8")).toBe("works");
    } finally { await f.cleanup(); }
  }, 20_000);

  it("never rolls back to a partially deleted old backup when cleanup fails", async () => {
    const f = await fixture();
    try {
      const { store, records } = memoryStore();
      const service = new MigrationService(store, () => undefined, {
        removeTree: async (candidate) => {
          await unlink(path.join(candidate, "app.json"));
          throw new Error("simulated busy old file");
        }
      });
      vi.spyOn(service, "preflight").mockResolvedValue(f.preflight);
      const record = await service.execute(f.source, f.destinationBase);
      expect(record.stage).toBe("linked");
      expect(records.get(record.id)?.stage).toBe("linked");
      expect(record.error).toContain("旧副本清理未完成");
      expect(record.backupPath).toBeTruthy();
      expect(await readFile(path.join(f.source, "app.json"), "utf8")).toBe('{"ready":true}');
      await assertRecordedLink(f.source, f.destination);
    } finally { await f.cleanup(); }
  }, 20_000);

  it("preserves the restored original if removing the migrated target partially fails", async () => {
    const f = await fixture();
    try {
      await rename(f.source, f.destination);
      await symlink(f.destination, f.source, "junction");
      const initial = recordFor(f.source, f.destination);
      const { store } = memoryStore([initial]);
      const service = new MigrationService(store, () => undefined, {
        removeTree: async (candidate) => { await unlink(path.join(candidate, "app.json")); throw new Error("simulated locked target"); }
      });
      const restored = await service.rollback(initial.id);
      expect(restored.stage).toBe("rolled-back");
      expect(restored.error).toContain("目标副本清理未完成");
      expect(await readFile(path.join(f.source, "app.json"), "utf8")).toBe('{"ready":true}');
      expect((await lstat(f.source)).isSymbolicLink()).toBe(false);
      expect(restored.stagingPath).toBeTruthy();
      await new MigrationService(store, () => undefined).recoverIncomplete();
      expect(store.getMigration(initial.id)?.stagingPath).toBeUndefined();
      expect(store.getMigration(initial.id)?.error).toBeUndefined();
      await expect(lstat(restored.stagingPath!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.cleanup(); }
  }, 20_000);

  it("restores the original after publication fails and removes the owned temporary copy", async () => {
    const f = await fixture();
    try {
      const { store, records } = memoryStore();
      const service = new MigrationService(store, () => undefined, {
        renameEntry: async (source, destination) => {
          if (source.includes(".cdriveshift-partial-")) throw new Error("simulated publication failure");
          await rename(source, destination);
        }
      });
      vi.spyOn(service, "preflight").mockResolvedValue(f.preflight);
      await expect(service.execute(f.source, f.destinationBase)).rejects.toThrow("publication failure");
      expect(await readFile(path.join(f.source, "state.json"), "utf8")).toBe("user data");
      expect([...records.values()][0]?.stage).toBe("failed");
      expect([...records.values()][0]?.backupPath).toBeUndefined();
      expect([...records.values()][0]?.stagingPath).toBeUndefined();
    } finally { await f.cleanup(); }
  }, 20_000);

  it("recovers a crash between unlinking the migration link and restoring the source directory", async () => {
    const f = await fixture();
    try {
      await rename(f.source, f.destination);
      const restorePath = `${f.source}.cdriveshift-restore-abcdef01`;
      await runRobocopy(f.destination, restorePath);
      const initial = recordFor(f.source, f.destination, { stage: "rolling-back", restorePath });
      const { store, records } = memoryStore([initial]);
      const service = new MigrationService(store, () => undefined);
      await service.recoverIncomplete();
      expect(records.get(initial.id)?.stage).toBe("linked");
      expect(records.get(initial.id)?.restorePath).toBeUndefined();
      await assertRecordedLink(f.source, f.destination);
      expect(await readFile(path.join(f.source, "state.json"), "utf8")).toBe("user data");
      await expect(lstat(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.cleanup(); }
  }, 20_000);

  it("recognizes a restored real source after a rollback crash and preserves both copies", async () => {
    const f = await fixture();
    try {
      await runRobocopy(f.source, f.destination);
      const initial = recordFor(f.source, f.destination, { stage: "rolling-back", restorePath: `${f.source}.cdriveshift-restore-abcdef01` });
      const { store, records } = memoryStore([initial]);
      await new MigrationService(store, () => undefined).recoverIncomplete();
      expect(records.get(initial.id)?.stage).toBe("rolled-back");
      expect(await readFile(path.join(f.source, "state.json"), "utf8")).toBe("user data");
      expect(await readFile(path.join(f.destination, "state.json"), "utf8")).toBe("user data");
    } finally { await f.cleanup(); }
  }, 20_000);

  it("recovers old-version interrupted cleanup without restoring a damaged backup", async () => {
    const f = await fixture();
    try {
      const backupPath = `${f.source}.cdriveshift-backup-abcdef01`;
      await rename(f.source, f.destination);
      await symlink(f.destination, f.source, "junction");
      await mkdir(backupPath);
      await writeFile(path.join(backupPath, "state.json"), "partial old data", "utf8");
      const initial = recordFor(f.source, f.destination, { stage: "switching", backupPath });
      const { store, records } = memoryStore([initial]);
      await new MigrationService(store, () => undefined).recoverIncomplete();
      expect(records.get(initial.id)?.stage).toBe("linked");
      expect(records.get(initial.id)?.backupPath).toBeUndefined();
      expect(await readFile(path.join(f.source, "app.json"), "utf8")).toBe('{"ready":true}');
    } finally { await f.cleanup(); }
  });

  it("restores and cleans a copy published before the source link could be created", async () => {
    const f = await fixture();
    try {
      const backupPath = `${f.source}.cdriveshift-backup-abcdef01`;
      const stagingPath = `${f.destination}.cdriveshift-partial-abcdef01`;
      await runRobocopy(f.source, f.destination);
      await rename(f.source, backupPath);
      const initial = recordFor(f.source, f.destination, { stage: "switching", backupPath, stagingPath });
      const { store, records } = memoryStore([initial]);
      await new MigrationService(store, () => undefined).recoverIncomplete();
      expect(records.get(initial.id)?.stage).toBe("failed");
      expect(records.get(initial.id)?.backupPath).toBeUndefined();
      expect(records.get(initial.id)?.stagingPath).toBeUndefined();
      expect(await readFile(path.join(f.source, "app.json"), "utf8")).toBe('{"ready":true}');
      await expect(lstat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.cleanup(); }
  }, 20_000);

  it("cleans an identical published target left by an old failed migration", async () => {
    const f = await fixture();
    try {
      await runRobocopy(f.source, f.destination);
      const initial = recordFor(f.source, f.destination, {
        stage: "failed",
        backupPath: `${f.source}.cdriveshift-backup-abcdef01`,
        stagingPath: `${f.destination}.cdriveshift-partial-abcdef01`
      });
      const { store, records } = memoryStore([initial]);
      await new MigrationService(store, () => undefined).recoverIncomplete();
      const recovered = records.get(initial.id)!;
      expect(recovered.stage).toBe("failed");
      expect(recovered.backupPath).toBeUndefined();
      expect(recovered.stagingPath).toBeUndefined();
      expect(await readFile(path.join(f.source, "app.json"), "utf8")).toBe('{"ready":true}');
      await expect(lstat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.cleanup(); }
  }, 20_000);

  it("preserves both directories when an old failed migration target has different contents", async () => {
    const f = await fixture();
    try {
      await runRobocopy(f.source, f.destination);
      await writeFile(path.join(f.destination, "state.json"), "otherdata", "utf8");
      const initial = recordFor(f.source, f.destination, {
        stage: "failed",
        stagingPath: `${f.destination}.cdriveshift-partial-abcdef01`
      });
      const { store, records } = memoryStore([initial]);
      await new MigrationService(store, () => undefined).recoverIncomplete();
      const recovered = records.get(initial.id)!;
      expect(recovered.stage).toBe("failed");
      expect(recovered.stagingPath).toBe(initial.stagingPath);
      expect(recovered.error).toContain("文件内容不一致");
      expect(await readFile(path.join(f.source, "state.json"), "utf8")).toBe("user data");
      expect(await readFile(path.join(f.destination, "state.json"), "utf8")).toBe("otherdata");
    } finally { await f.cleanup(); }
  }, 20_000);

  it("clears stale transaction metadata after a copy failed before creating any files", async () => {
    const f = await fixture();
    try {
      const { store, records } = memoryStore();
      const service = new MigrationService(store, () => undefined, { copy: async () => { throw new Error("copy unavailable"); } });
      vi.spyOn(service, "preflight").mockResolvedValue(f.preflight);
      await expect(service.execute(f.source, f.destinationBase)).rejects.toThrow("copy unavailable");
      const record = [...records.values()][0]!;
      expect(record.stage).toBe("failed");
      expect(record.backupPath).toBeUndefined();
      expect(record.stagingPath).toBeUndefined();
    } finally { await f.cleanup(); }
  });

  it("performs a real cross-volume preflight and keeps a tiny application usable on both drives", async (context) => {
    if (path.parse(os.tmpdir()).root.toLowerCase() === path.parse(process.cwd()).root.toLowerCase()) { context.skip(); return; }
    const f = await fixture();
    const targetBase = await mkdtemp(path.join(process.cwd(), ".cdriveshift-migration-test-"));
    try {
      await writeFile(path.join(f.source, "app.cjs"), "process.stdout.write(require('node:fs').readFileSync(require('node:path').join(__dirname, 'state.json'), 'utf8'));", "utf8");
      const { store } = memoryStore();
      const service = new MigrationService(store, () => undefined);
      const check = await service.preflight(f.source, targetBase);
      expect(check.blockers).toEqual([]);
      expect(check.allowed).toBe(true);
      const migrated = await service.execute(f.source, targetBase);
      expect(migrated.stage).toBe("linked");
      const execFileAsync = promisify(execFile);
      expect((await execFileAsync(process.execPath, [path.join(f.source, "app.cjs")], { windowsHide: true })).stdout).toBe("user data");
      await writeFile(path.join(f.source, "state.json"), "saved after migration", "utf8");
      const restored = await service.rollback(migrated.id);
      expect(restored.stage).toBe("rolled-back");
      expect(restored.error).toBeUndefined();
      expect((await execFileAsync(process.execPath, [path.join(f.source, "app.cjs")], { windowsHide: true })).stdout).toBe("saved after migration");
      const reapplied = await service.reapply(migrated.id);
      expect(reapplied.stage).toBe("linked");
      expect((await execFileAsync(process.execPath, [path.join(f.source, "app.cjs")], { windowsHide: true })).stdout).toBe("saved after migration");
    } finally {
      await f.cleanup();
      const resolved = await realpath(targetBase);
      if (path.dirname(resolved).toLowerCase() !== (await realpath(process.cwd())).toLowerCase() || !path.basename(resolved).startsWith(".cdriveshift-migration-test-")) throw new Error("Unsafe cross-volume cleanup path");
      await rm(resolved, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects foreign transaction paths without deleting files", async () => {
    const f = await fixture();
    try {
      const unrelated = path.join(f.root, "unrelated");
      await mkdir(unrelated);
      await writeFile(path.join(unrelated, "keep.txt"), "keep", "utf8");
      const initial = recordFor(f.source, f.destination, { stage: "copying", stagingPath: unrelated });
      const { store, records } = memoryStore([initial]);
      await new MigrationService(store, () => undefined).recoverIncomplete();
      expect(records.get(initial.id)?.error).toContain("事务路径与记录不匹配");
      expect(await readFile(path.join(unrelated, "keep.txt"), "utf8")).toBe("keep");
    } finally { await f.cleanup(); }
  });

  it("serializes all migration operations and tolerates a detached progress listener", async () => {
    const f = await fixture();
    try {
      const { store } = memoryStore();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const service = new MigrationService(store, () => { throw new Error("window closed"); }, {
        copy: async (source, destination) => { await blocked; await runRobocopy(source, destination); }
      });
      vi.spyOn(service, "preflight").mockResolvedValue(f.preflight);
      const pending = service.execute(f.source, f.destinationBase);
      expect(service.isBusy()).toBe(true);
      await expect(service.execute(f.source, f.destinationBase)).rejects.toThrow("已有迁移或恢复操作");
      await expect(service.rollback("id")).rejects.toThrow("已有迁移或恢复操作");
      release();
      expect((await pending).stage).toBe("linked");
      await service.whenIdle();
      expect(service.isBusy()).toBe(false);
    } finally { await f.cleanup(); }
  }, 20_000);
});
