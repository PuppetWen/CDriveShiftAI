import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { ForceDeleteService } = require(path.join(workspace, "dist-electron", "force-delete.js"));
const fixture = await mkdtemp(path.join(workspace, ".force-delete-smoke-"));
const target = path.join(fixture, "中文 occupied target");
await mkdir(target);
const heldFile = path.join(target, "locked.txt");
await writeFile(heldFile, "fixture lock");
const readyFile = path.join(fixture, "ready");
const scriptFile = path.join(fixture, "hold-open.ps1");
await writeFile(scriptFile, [
  "$ErrorActionPreference = 'Stop'",
  "$held = [IO.File]::Open($env:CSHIFT_SMOKE_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)",
  "try { [IO.File]::WriteAllText($env:CSHIFT_SMOKE_READY_FILE, 'ready'); Start-Sleep -Seconds 60 } finally { $held.Dispose() }"
].join("\r\n"), "utf8");

// Pass the held file through the environment: it never appears on the command
// line, so only actual Restart Manager handle detection can discover this lock.
const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CSHIFT_SMOKE_LOCK_FILE: heldFile, CSHIFT_SMOKE_READY_FILE: readyFile }
});
let holderOutput = "";
child.stdout.on("data", (chunk) => { holderOutput += chunk; });
child.stderr.on("data", (chunk) => { holderOutput += chunk; });
child.on("error", (error) => { holderOutput += error.message; });

let holderPid = child.pid;
try {
  assert(Number.isInteger(holderPid) && holderPid > 4, "Fixture launcher did not return a PID");
  for (let attempts = 0; ; attempts += 1) {
    try {
      await lstat(readyFile);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (attempts >= 80 || child.exitCode !== null) throw new Error(`Fixture holder failed: ${holderOutput}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const service = new ForceDeleteService({
    applicationExecutable: process.execPath,
    applicationDataRoot: path.join(workspace, ".cdriveshiftai-data"),
    createVerificationId: () => "force-delete-smoke-verification"
  });
  // Prove this is an actual Windows sharing lock, not just a matching command line.
  await assert.rejects(rm(heldFile), (error) => ["EBUSY", "EPERM", "EACCES"].includes(error.code));
  const preview = await service.preview(target);
  const related = preview.processes.find((item) => item.pid === holderPid);
  assert(related?.canTerminate && related.matchReason === "file-handle", `Preview did not find the fixture lock holder: ${JSON.stringify(preview)}`);
  const result = await service.execute(preview.verificationId);
  assert(result.deleted && result.terminatedProcesses.some((item) => item.pid === holderPid), `Execution did not stop the fixture lock holder: ${JSON.stringify(result)}`);
  await assert.rejects(lstat(target), { code: "ENOENT" });
  holderPid = undefined;

  const linkedData = path.join(fixture, "linked-data");
  await mkdir(linkedData);
  const keepFile = path.join(linkedData, "keep.txt");
  await writeFile(keepFile, "preserved");
  await chmod(keepFile, 0o444);
  const beforeMode = (await lstat(keepFile)).mode;
  const secondTarget = path.join(fixture, "readonly-中文");
  const longDirectory = path.join(secondTarget, ...Array.from({ length: 6 }, (_, index) => `${index}-${"long".repeat(10)}`));
  await mkdir(longDirectory, { recursive: true });
  const readOnlyFile = path.join(longDirectory, "只读.txt");
  await writeFile(readOnlyFile, "read-only");
  await chmod(readOnlyFile, 0o444);
  const longPathPreview = await service.preview(readOnlyFile);
  assert((await service.execute(longPathPreview.verificationId)).deleted);
  await assert.rejects(lstat(readOnlyFile), { code: "ENOENT" });
  await symlink(linkedData, path.join(secondTarget, "external-junction"), "junction");
  await link(keepFile, path.join(secondTarget, "readonly-hardlink.txt"));
  const secondPreview = await service.preview(secondTarget);
  assert((await service.execute(secondPreview.verificationId)).deleted);
  await assert.rejects(lstat(secondTarget), { code: "ENOENT" });
  assert.equal(await readFile(keepFile, "utf8"), "preserved");
  assert.equal((await lstat(keepFile)).mode, beforeMode, "External linked file attributes changed");

  process.stdout.write(`${JSON.stringify({
    result: "ok",
    actualExclusiveFileLock: true,
    lockHolderWithoutCommandLinePath: true,
    relatedProcesses: preview.processes.length,
    terminatedProcesses: result.terminatedProcesses.length,
    targetRemoved: true,
    unicodeAndLongReadonlyPaths: true,
    externalJunctionTargetPreserved: true,
    externalReadonlyHardlinkAttributesPreserved: true
  }, null, 2)}\n`);
} finally {
  if (holderPid) {
    // Stop only the fixture process launched by this script, never an app by name.
    child.kill("SIGKILL");
  }
  const resolvedFixture = path.resolve(fixture);
  assert(resolvedFixture.startsWith(`${workspace}${path.sep}.force-delete-smoke-`), "Unsafe fixture cleanup path");
  await rm(resolvedFixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
