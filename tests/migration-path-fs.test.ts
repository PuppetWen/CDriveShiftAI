import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeMigrationPath } from "../electron/migration-path";
import { MigrationService } from "../electron/migration";
import type { AppStore } from "../electron/store";
import type { MigrationRecord, PreflightResult } from "../electron/types";

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("migration path names and redirection", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cdriveshift-path-names-")));
  });
  afterEach(async () => {
    if (path.dirname(root).toLowerCase() !== (await realpath(os.tmpdir())).toLowerCase() ||
        !path.basename(root).startsWith("cdriveshift-path-names-")) throw new Error("Unsafe fixture cleanup");
    expect((await lstat(root)).isSymbolicLink()).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("accepts existing directory names and only permits a missing final component", async () => {
    expect((await canonicalizeMigrationPath(root)).toLowerCase()).toBe(root.toLowerCase());
    const missing = path.join(root, "missing");
    expect(await canonicalizeMigrationPath(missing, { allowMissingLeaf: true })).toBe(missing);
    await expect(canonicalizeMigrationPath(missing)).rejects.toThrow();
    await expect(canonicalizeMigrationPath(path.join(missing, "child"), { allowMissingLeaf: true })).rejects.toThrow();
  });

  it("rejects a redirected ancestor even when the final leaf may be a link or missing", async () => {
    const target = path.join(root, "target");
    const alias = path.join(root, "alias");
    await mkdir(path.join(target, "child"), { recursive: true });
    await symlink(target, alias, "junction");
    await expect(canonicalizeMigrationPath(alias)).rejects.toThrow();
    await expect(canonicalizeMigrationPath(path.join(alias, "child"), { allowLeafLink: true })).rejects.toThrow();
    await expect(canonicalizeMigrationPath(path.join(alias, "missing"), { allowMissingLeaf: true })).rejects.toThrow();
    expect(await canonicalizeMigrationPath(alias, { allowLeafLink: true })).toBe(alias);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  });

  it("migrates and restores a legacy short-name path without treating it as a junction", async (context) => {
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder($env:CDRIVE_SHORT_PATH_FIXTURE).ShortPath"
    ], { env: { ...process.env, CDRIVE_SHORT_PATH_FIXTURE: root }, windowsHide: true });
    const shortRoot = stdout.trim();
    if (shortRoot.toLowerCase() === root.toLowerCase()) { context.skip(); return; }
    expect((await canonicalizeMigrationPath(shortRoot)).toLowerCase()).toBe(root.toLowerCase());
    const source = path.join(shortRoot, "App");
    const destinationBase = path.join(shortRoot, "moved");
    const destination = path.join(destinationBase, "App");
    await mkdir(source);
    await mkdir(destinationBase);
    await writeFile(path.join(source, "data.txt"), "before migration");
    const records = new Map<string, MigrationRecord>();
    const store = {
      getAnalysis: () => undefined,
      saveMigration: async (record: MigrationRecord) => { records.set(record.id, structuredClone(record)); },
      getMigration: (id: string) => records.has(id) ? structuredClone(records.get(id)) : undefined,
      listMigrations: () => [...records.values()].map(record => structuredClone(record))
    } as unknown as AppStore;
    const service = new MigrationService(store, () => undefined);
    // An existing record can contain a short parent name even though new
    // production preflights canonicalize names before creating a record.
    const preflight = vi.spyOn(service, "preflight").mockResolvedValue({
      allowed: true, source, destinationBase, finalDestination: destination,
      requiredBytes: 16, availableBytes: 1024 ** 4, fileCount: 1, directoryCount: 1,
      reparsePointCount: 0, risk: "low", warnings: [], blockers: []
    } as PreflightResult);
    const migrated = await service.execute(source, destinationBase);
    expect(migrated.stage).toBe("linked");
    expect(migrated.error).toBeUndefined();
    expect(migrated.backupPath).toBeUndefined();
    await writeFile(path.join(source, "data.txt"), "saved through migration link");
    const versioned = path.join(root, "moved", "App", "versions", "one");
    await mkdir(versioned, { recursive: true });
    await writeFile(path.join(versioned, "manifest.json"), "working");
    await symlink(versioned, path.join(source, "latest"), "junction");
    const restored = await service.rollback(migrated.id);
    expect(restored.stage).toBe("rolled-back");
    expect(restored.error).toBeUndefined();
    expect(await readFile(path.join(source, "data.txt"), "utf8")).toBe("saved through migration link");
    expect(await readFile(path.join(source, "latest", "manifest.json"), "utf8")).toBe("working");
    preflight.mockResolvedValue({
      allowed: true, source: path.join(root, "App"), destinationBase: path.join(root, "moved"),
      finalDestination: path.join(root, "moved", "App"), requiredBytes: 28,
      availableBytes: 1024 ** 4, fileCount: 2, directoryCount: 3,
      reparsePointCount: 1, risk: "low", warnings: [], blockers: []
    });
    const reapplied = await service.reapply(migrated.id);
    expect(reapplied.stage).toBe("linked");
    expect(reapplied.error).toBeUndefined();
  }, 30_000);
});
