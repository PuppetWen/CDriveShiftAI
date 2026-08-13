import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  migrationRobocopyArguments,
  normalizeReparseTarget,
  renameWithRetry,
  runRobocopy
} from "../electron/migration";

describe("migration copy options", () => {
  it("copies junctions and symbolic links as links instead of expanding or excluding them", () => {
    const argumentsList = migrationRobocopyArguments("C:\\source", "D:\\destination");

    expect(argumentsList).toContain("/SJ");
    expect(argumentsList).toContain("/SL");
    expect(argumentsList).not.toContain("/XJ");
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
