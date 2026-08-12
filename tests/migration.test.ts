import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationRobocopyArguments, runRobocopy } from "../electron/migration";

describe("migration copy options", () => {
  it("copies junctions and symbolic links as links instead of expanding or excluding them", () => {
    const argumentsList = migrationRobocopyArguments("C:\\source", "D:\\destination");

    expect(argumentsList).toContain("/SJ");
    expect(argumentsList).toContain("/SL");
    expect(argumentsList).not.toContain("/XJ");
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
      expect(await readlink(copiedLink)).toBe(target);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
