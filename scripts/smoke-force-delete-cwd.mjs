import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { ForceDeleteService } = require(path.join(workspace, "dist-electron", "force-delete.js"));
const { listFileLockProcesses } = require(path.join(workspace, "dist-electron", "file-locks.js"));
const fixture = await mkdtemp(path.join(workspace, ".force-delete-cwd-smoke-"));
const holders = [];
const allowedTermination = new Set();
let verificationSequence = 0;

async function startDirectoryHolder(cwd) {
  // The path never appears in the command line: inherited current-directory
  // handles must be discovered, not inferred from the executable or arguments.
  const script = "[Console]::WriteLine('ready'); [Console]::Out.Flush(); Start-Sleep -Seconds 120";
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  holders.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("error", (error) => { output += error.message; });
  for (let attempt = 0; !output.includes("ready"); attempt++) {
    if (attempt > 100 || child.exitCode !== null) throw new Error(`Fixture holder failed: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(Number.isInteger(child.pid) && child.pid > 4);
  return child;
}

try {
  const external = path.join(fixture, "external-current-directory");
  await mkdir(external);
  const preserved = path.join(external, "keep.txt");
  await writeFile(preserved, "preserve external files and terminal");
  const unrelated = await startDirectoryHolder(external);
  const service = new ForceDeleteService({
    applicationExecutable: process.execPath,
    applicationDataRoot: path.join(workspace, ".cdriveshiftai-data"),
    createVerificationId: () => `cwd-smoke-${++verificationSequence}`
  });
  // Keep the production discovery/deletion/identity-check pipeline. Guard its
  // process terminator in this test so it can only stop our own fixture holder.
  const terminate = service.operations.terminateProcess;
  service.operations.terminateProcess = (pid, creationTime) => {
    assert(allowedTermination.has(pid), `Refusing to terminate non-fixture or unrelated PID ${pid}`);
    return terminate(pid, creationTime);
  };
  service.operations.removeElevated = async () => { throw new Error("Directory CWD smoke must finish without UAC"); };
  const results = [];
  for (const nested of [false, true]) {
    const target = path.join(fixture, nested ? "中文 parent with nested cwd" : "中文 empty cwd");
    const heldDirectory = nested ? path.join(target, "child") : target;
    await mkdir(heldDirectory, { recursive: true });
    if (nested) await symlink(external, path.join(target, "external-junction"), "junction");
    const holder = await startDirectoryHolder(heldDirectory);
    allowedTermination.add(holder.pid);
    await assert.rejects(rmdir(heldDirectory), (error) => ["EBUSY", "EPERM", "EACCES"].includes(error.code));
    const scan = await listFileLockProcesses(target);
    assert(scan.processes.some((item) => item.pid === holder.pid));
    assert(!scan.processes.some((item) => item.pid === unrelated.pid), "Directory scan followed an external junction");
    const preview = await service.preview(target);
    assert(preview.processes.some((item) => item.pid === holder.pid && item.canTerminate && item.matchReason === "file-handle"), JSON.stringify(preview));
    assert(!preview.processes.some((item) => item.pid === unrelated.pid));
    const result = await service.execute(preview.verificationId);
    assert(result.deleted && !result.usedElevation, JSON.stringify(result));
    assert.deepEqual(result.terminatedProcesses.map((item) => item.pid), [holder.pid]);
    await assert.rejects(lstat(target), { code: "ENOENT" });
    assert.equal(unrelated.exitCode, null);
    assert.equal(await readFile(preserved, "utf8"), "preserve external files and terminal");
    allowedTermination.delete(holder.pid);
    results.push({ nested, pid: holder.pid, deleted: true, userConfirmedIdentityOnly: true });
  }
  process.stdout.write(`${JSON.stringify({ result: "ok", realCurrentDirectoryLocks: results, unrelatedPowerShellPreserved: true, externalJunctionPreserved: true, usedElevation: false }, null, 2)}\n`);
} finally {
  for (const child of holders) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
  const resolved = path.resolve(fixture);
  assert.equal(path.dirname(resolved), workspace);
  assert(path.basename(resolved).startsWith(".force-delete-cwd-smoke-"));
  assert(!(await lstat(resolved)).isSymbolicLink());
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
