import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoMigrationPathMutation, assertRenameDestinationAvailable, migrationPathMutationReason, migrationRecordDeletionReason } from "../electron/file-operation-guard";
import type { MigrationRecord } from "../electron/types";

const records: MigrationRecord[] = [{ id: "app", source: "C:\\Apps\\Example", destination: "D:\\Moved\\Example", stage: "linked",
  totalBytes: 3, copiedBytes: 3, startedAt: "2026-01-01", updatedAt: "2026-01-01", warnings: [] }];
const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("migration path and history protection", () => {
  it("blocks destructive changes to live sources, targets, parents and children", () => {
    for (const target of ["C:\\Apps", "C:\\Apps\\Example", "D:\\Moved\\Example\\data.db"]) {
      expect(migrationPathMutationReason(target, records)).toContain("事务");
    }
    expect(migrationPathMutationReason("D:\\Moved\\Example2", records)).toBeUndefined();
    expect(migrationRecordDeletionReason(records[0])).toContain("恢复");
  });
  it("protects recovery files even if the transaction failed", () => {
    const record = { ...records[0], stage: "failed" as const, restorePath: "C:\\restore" };
    expect(migrationPathMutationReason("C:\\restore\\data.db", [record])).toContain("事务");
    expect(migrationRecordDeletionReason(record)).toContain("清理");
    expect(migrationRecordDeletionReason({ ...record, restorePath: undefined })).toBeUndefined();
  });
  it("resolves junction ancestors to prevent deleting migrated data through an alias", async () => {
    const base = path.resolve(".test-tmp"); await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "guard-")); temporary.push(root);
    const target = path.join(root, "target"); await mkdir(target);
    const alias = path.join(root, "alias"); await symlink(target, alias, "junction");
    const record = { ...records[0], destination: path.join(target, "app") };
    await expect(assertNoMigrationPathMutation(path.join(alias, "app"), [record])).rejects.toThrow("事务");
  });
  it("refuses to overwrite an existing destination during rename", async () => {
    const base = path.resolve(".test-tmp"); await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "rename-")); temporary.push(root);
    const source = path.join(root, "a.txt"), destination = path.join(root, "b.txt");
    await writeFile(source, "original"); await writeFile(destination, "keep");
    await expect(assertRenameDestinationAvailable(source, destination)).rejects.toThrow("不能覆盖");
    expect(await readFile(destination, "utf8")).toBe("keep");
    await expect(assertRenameDestinationAvailable(source, path.join(root, "c.txt"))).resolves.toBeUndefined();
  });
});
