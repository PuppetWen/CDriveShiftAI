import { execFile, spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildElevatedDeleteCommand, deleteWithElevation, deleteWithoutElevation, elevatedDeleteIdentity, type ElevatedDeleteRequest } from "../electron/elevated-delete";

const execute = promisify(execFile);
const workspace = path.resolve(__dirname, "..");
const fixtureBase = path.join(workspace, ".test-tmp");
let fixture = "";
let count = 0;

beforeAll(async () => {
  await mkdir(fixtureBase, { recursive: true });
  fixture = await mkdtemp(path.join(fixtureBase, "elevated-delete-"));
});
afterAll(async () => {
  if (fixture && path.dirname(path.resolve(fixture)) === fixtureBase && path.basename(fixture).startsWith("elevated-delete-")) {
    await rm(fixture, { force: true, recursive: true });
  }
});

async function requestFor(name = `target-${++count}`): Promise<ElevatedDeleteRequest> {
  const target = path.join(fixture, name);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "file.txt"), "fixture");
  return {
    path: target,
    canonicalPath: await realpath(target),
    expectedIdentity: elevatedDeleteIdentity(await lstat(target, { bigint: true })),
    applicationExecutable: path.join(fixture, "application", "CDriveShiftAI.exe"),
    applicationDataRoot: path.join(fixture, "application-data")
  };
}

function unpack(args: string[]) {
  expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const launcher = Buffer.from(args[4], "base64").toString("utf16le");
  const compressed = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(launcher)![1];
  const child = gunzipSync(Buffer.from(compressed, "base64")).toString("utf8");
  const data = /Expand-Text '([A-Za-z0-9+/=]+)'/.exec(child)![1];
  return { launcher, child, payload: JSON.parse(gunzipSync(Buffer.from(data, "base64")).toString("utf8")) };
}

describe.skipIf(process.platform !== "win32")("administrator PowerShell deletion", () => {
  it("encodes literal metacharacters as JSON data, uses only the system PowerShell, and verifies disappearance", async () => {
    const request = await requestFor("[literal] ' ; $() & 数据");
    const run = vi.fn(async (executable: string, args: string[]) => {
      expect(executable).toBe(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
      const { launcher, child, payload } = unpack(args);
      expect(payload.path).toBe(request.path);
      expect(payload.expectedIdentity).toBe(request.expectedIdentity);
      expect(launcher).not.toContain(request.path);
      expect(child).not.toContain(request.path);
      expect(launcher).toContain("-Verb RunAs -WindowStyle Hidden -Wait -PassThru");
      expect(launcher).not.toContain("-or $true");
      expect(args[4].length).toBeLessThan(30_000);
      expect(Buffer.byteLength(child, "utf16le") * 4 / 3).toBeLessThan(30_000);
      await rm(request.path, { recursive: true });
    });
    await deleteWithElevation(request, { run });
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not claim success when the helper exits successfully but leaves the target", async () => {
    const request = await requestFor();
    await expect(deleteWithElevation(request, { run: async () => undefined })).rejects.toThrow("目标仍然存在");
  });

  it("uses the direct branch without UAC or helper process termination for ordinary deletion", async () => {
    const request = await requestFor();
    const run = vi.fn(async (_executable: string, args: string[]) => {
      const { launcher, payload } = unpack(args);
      expect(launcher).toContain("if($administrator -or $true)");
      expect(payload.processes).toBeUndefined();
      await rm(request.path, { recursive: true });
    });
    await deleteWithoutElevation({ ...request, processes: [{ pid: 100, name: "test.exe", creationTime: "12345678" }] }, { run });
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([[5, "EPERM"], [32, "EBUSY"], [33, "EBUSY"], [145, "ENOTEMPTY"]])("maps non-elevated Win32 %s to the retryable errno %s", async (nativeCode, code) => {
    const request = await requestFor();
    await expect(deleteWithoutElevation(request, { run: async () => { throw Object.assign(new Error("fixed helper error"), { code: nativeCode }); } }))
      .rejects.toMatchObject({ code, path: request.path });
  });

  it.each([
    [1223, "已取消管理员权限授权"], [5, "访问权限"], [32, "文件占用"], [33, "文件锁"],
    [125, "父目录已发生变化"], [126, "受保护路径"], [145, "持续写入"]
  ])("reports helper exit code %s truthfully", async (code, message) => {
    const request = await requestFor();
    await expect(deleteWithElevation(request, { run: async () => { throw Object.assign(new Error("helper failed"), { code }); } })).rejects.toThrow(String(message));
    expect(await readFile(path.join(request.path, "file.txt"), "utf8")).toBe("fixture");
  });

  it("refuses a stale identity before launching any process", async () => {
    const request = await requestFor();
    request.expectedIdentity = "1:2:3:false:true";
    const run = vi.fn();
    await expect(deleteWithElevation(request, { run })).rejects.toThrow("目标已被替换");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a changed canonical parent before launching", async () => {
    const request = await requestFor();
    request.canonicalPath = path.join(fixture, "another-target");
    const run = vi.fn();
    await expect(deleteWithElevation(request, { run })).rejects.toThrow("路径发生变化");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["C:\\", "C:\\Windows\\System32", "\\\\server\\share\\data", "C:\\data\\*", "C:\\data\\file:stream", "C:\\data\\..\\other", "C:\\data\\trailing."])("rejects unsafe target %s", async (target) => {
    const request = await requestFor();
    const run = vi.fn();
    await expect(deleteWithElevation({ ...request, path: target }, { run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("protects this application's directory and data", async () => {
    const request = await requestFor();
    const run = vi.fn();
    await expect(deleteWithElevation({ ...request, applicationDataRoot: path.join(request.path, "state") }, { run })).rejects.toThrow("CDriveShiftAI");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not expose the entire encoded command or falsely count an access failure as disappearance", async () => {
    const request = await requestFor();
    await expect(deleteWithElevation(request, { run: async () => { throw Object.assign(new Error("SECRET encoded command"), { code: "EACCES" }); } })).rejects.toThrow("系统未能完成此操作");
    expect(await readFile(path.join(request.path, "file.txt"), "utf8")).toBe("fixture");
  });
});

describe.skipIf(process.platform !== "win32")("fixed deletion script with disposable Windows fixtures (no UAC)", () => {
  async function direct(request: ElevatedDeleteRequest) {
    const args = buildElevatedDeleteCommand({
      ...request, protectedRoots: [path.dirname(request.applicationExecutable), request.applicationDataRoot], applicationProcessId: process.pid
    }, true);
    return execute(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args,
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 25_000 });
  }

  it("deletes a nested literal-name tree and validates native file identity", async () => {
    const request = await requestFor("native [literal] ' ; $() & 数据");
    await mkdir(path.join(request.path, "one", "two"), { recursive: true });
    await writeFile(path.join(request.path, "one", "two", "nested.txt"), "nested");
    await direct(request);
    await expect(lstat(request.path)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("uses the production ordinary-delete entry point without a UAC request", async () => {
    const request = await requestFor();
    await deleteWithoutElevation(request);
    await expect(lstat(request.path)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("removes a directory junction without following its external target", async () => {
    const request = await requestFor();
    const outside = path.join(fixture, `outside-${++count}`);
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "preserved");
    await symlink(outside, path.join(request.path, "junction"), "junction");
    await direct(request);
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("preserved");
    await expect(lstat(request.path)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("refuses a replaced target inside the fixed script", async () => {
    const request = await requestFor();
    await expect(direct({ ...request, expectedIdentity: "1:2:3:false:true" })).rejects.toMatchObject({ code: 125 });
    expect(await readFile(path.join(request.path, "file.txt"), "utf8")).toBe("fixture");
  }, 30_000);

  it("refuses a protected application target inside the fixed script", async () => {
    const request = await requestFor();
    await expect(direct({ ...request, applicationDataRoot: request.path })).rejects.toMatchObject({ code: 126 });
    expect(await readFile(path.join(request.path, "file.txt"), "utf8")).toBe("fixture");
  }, 30_000);

  it("deletes a selected readonly hard link without changing the external link's attributes or content", async () => {
    const request = await requestFor();
    const selected = path.join(request.path, "file.txt");
    const outside = path.join(fixture, `outside-hardlink-${++count}.txt`);
    await link(selected, outside);
    await chmod(selected, 0o444);
    const before = await lstat(outside);
    await direct(request);
    const after = await lstat(outside);
    expect(after.mode).toBe(before.mode);
    expect(after.nlink).toBe(1);
    expect(await readFile(outside, "utf8")).toBe("fixture");
    await expect(lstat(request.path)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("deletes the selected junction itself while leaving its target", async () => {
    const request = await requestFor();
    const selected = path.join(fixture, `selected-junction-${++count}`);
    await symlink(request.path, selected, "junction");
    await direct({ ...request, path: selected, canonicalPath: selected, expectedIdentity: elevatedDeleteIdentity(await lstat(selected, { bigint: true })) });
    expect(await readFile(path.join(request.path, "file.txt"), "utf8")).toBe("fixture");
    await expect(lstat(selected)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects a canonical ancestor replaced by a junction while UAC was pending", async () => {
    const parent = path.join(fixture, `parent-before-uac-${++count}`);
    await mkdir(parent);
    const request = await requestFor(path.join(path.basename(parent), "target"));
    const moved = `${parent}-original`;
    await rename(parent, moved);
    await symlink(moved, parent, "junction");
    await expect(direct(request)).rejects.toMatchObject({ code: 125 });
    expect(await readFile(path.join(moved, "target", "file.txt"), "utf8")).toBe("fixture");
  }, 30_000);

  it("reports a real exclusive lock without claiming deletion", async () => {
    const request = await requestFor();
    const selected = path.join(request.path, "file.txt");
    const data = Buffer.from(selected, "utf8").toString("base64");
    const lockScript = `$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')); $handle=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try { [Console]::WriteLine('READY'); [Console]::ReadLine() | Out-Null } finally { $handle.Dispose() }`;
    const lock = spawn(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(lockScript, "utf16le").toString("base64")], { windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => {
        lock.once("error", reject);
        lock.once("exit", (code) => reject(new Error(`Fixture lock exited early: ${code}`)));
        lock.stdout.once("data", (value) => String(value).includes("READY") ? resolve() : reject(new Error("Fixture lock did not start")));
      });
      await expect(direct(request)).rejects.toMatchObject({ code: 32 });
      expect((await lstat(selected)).isFile()).toBe(true);
    } finally {
      lock.stdin.end("release\n");
      await new Promise<void>((resolve) => lock.once("exit", () => resolve()));
    }
    expect(await readFile(selected, "utf8")).toBe("fixture");
  }, 30_000);

  it("can finish a confirmed fixture process when its path was unreadable before elevation, after checking its held handle and start time", async () => {
    const request = await requestFor();
    const executable = path.join(fixture, "CShiftDeleteLockFixture.exe");
    const source = "using System; using System.IO; public class CShiftDeleteLockFixture { public static void Main(string[] args) { using(var file=new FileStream(args[0],FileMode.Open,FileAccess.ReadWrite,FileShare.None)) { Console.WriteLine(\"READY\"); Console.Out.Flush(); Console.ReadLine(); } } }";
    const buildScript = `$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString("base64")}')); $output=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(executable).toString("base64")}')); Add-Type -TypeDefinition $source -OutputAssembly $output -OutputType ConsoleApplication`;
    const powershell = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(buildScript, "utf16le").toString("base64")], { windowsHide: true });
    const holder = spawn(executable, [path.join(request.path, "file.txt")], { windowsHide: true });
    const stopped = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once("error", reject);
        holder.once("exit", (code) => reject(new Error(`Fixture process exited early: ${code}`)));
        holder.stdout.once("data", (value) => String(value).includes("READY") ? resolve() : reject(new Error("Fixture process did not start")));
      });
      const infoScript = `[Diagnostics.Process]::GetProcessById(${holder.pid}).StartTime.ToUniversalTime().Ticks.ToString()`;
      const { stdout } = await execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(infoScript, "utf16le").toString("base64")], { windowsHide: true });
      for (const processRecord of [
        { pid: holder.pid!, name: path.basename(executable), creationTime: "111111111111111111" },
        { pid: holder.pid!, name: "wrong-name.exe", creationTime: stdout.trim() },
        { pid: holder.pid!, name: path.basename(executable), creationTime: stdout.trim(), executablePath: path.join(fixture, "wrong-path.exe") }
      ]) {
        await expect(direct({ ...request, processes: [processRecord] })).rejects.toMatchObject({ code: 32 });
        expect(holder.exitCode).toBeNull();
      }
      await direct({ ...request, processes: [{ pid: holder.pid!, name: path.basename(executable), creationTime: stdout.trim() }] });
      await stopped;
      await expect(lstat(request.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (holder.exitCode === null) holder.stdin.end("release\n");
      await stopped;
    }
  }, 30_000);
});
