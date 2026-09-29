import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const workspace = path.resolve(import.meta.dirname, "..");
const base = path.join(workspace, ".task-tmp", "force-delete-search");
await mkdir(base, { recursive: true });
const fixture = await mkdtemp(path.join(base, "smoke-"));
const require = createRequire(import.meta.url);
const { ForceDeleteService } = require(path.join(workspace, "dist-electron", "force-delete.js"));
const { collectLockScanFiles, listFileLockProcesses } = require(path.join(workspace, "dist-electron", "file-locks.js"));
const children = [];
const delays = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delays(50);
  }
}
async function hold(target, directory = false) {
  const code = directory
    ? "[Console]::WriteLine('READY'); [Console]::ReadLine() | Out-Null"
    : "$f=[IO.File]::Open($env:CSHIFT_HELD_FILE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try { [Console]::WriteLine('READY'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }";
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], {
    cwd: directory ? target : fixture, windowsHide: true, env: { ...process.env, CSHIFT_HELD_FILE: target }
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await until(() => { assert.equal(child.exitCode, null, output); return output.includes("READY"); }, "lock holder ready");
  return child;
}

try {
  const target = path.join(fixture, "large 中文 directory");
  await mkdir(target);
  // The lock lives beyond the bounded traversal, so only handle enumeration can
  // find it. Also exclude the path from the holder's command line.
  for (let batch = 0; batch < 51; batch++) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(path.join(target, `a${String(batch * 100 + i).padStart(5, "0")}.txt`), "fixture")));
  }
  const locked = path.join(target, "z-locked.txt");
  await writeFile(locked, "exclusive fixture");
  const limited = await collectLockScanFiles(target);
  assert(limited.incomplete && !limited.files.includes(locked));
  const holder = await hold(locked);
  await assert.rejects(rm(locked));
  const scan = await listFileLockProcesses(target);
  const found = scan.processes.find((item) => item.pid === holder.pid);
  assert(found?.name && found?.appName && found?.executablePath && found?.lockedPath, JSON.stringify(scan));
  assert(!found.protected);
  console.log("PASS: handle detection beyond 5000 entries, with application metadata");

  const service = new ForceDeleteService({ applicationExecutable: process.execPath, applicationDataRoot: path.join(fixture, "app-data"), createVerificationId: () => "fixture-confirmation" });
  service.operations.listProcesses = async () => { throw new Error("CIM unavailable fixture"); };
  service.operations.removeElevated = async () => { throw new Error("This smoke test must not request UAC"); };
  const terminate = service.operations.terminateProcess;
  const allowed = new Set([holder.pid]);
  service.operations.terminateProcess = (pid, time) => { assert(allowed.has(pid), "Refusing to stop an unrelated process"); return terminate(pid, time); };
  const preview = await service.preview(target);
  assert(preview.processes.some((item) => item.pid === holder.pid && item.canTerminate && item.appName));
  assert((await service.execute(preview.verificationId)).deleted);
  await assert.rejects(lstat(target), { code: "ENOENT" });
  console.log("PASS: confirmed deletion of actual locked tree when CIM is unavailable");

  const cwdTarget = path.join(fixture, "current-directory");
  await mkdir(cwdTarget);
  const cwdHolder = await hold(cwdTarget, true);
  allowed.add(cwdHolder.pid);
  await assert.rejects(rmdir(cwdTarget));
  const cwdPreview = await service.preview(cwdTarget);
  assert(cwdPreview.processes.some((item) => item.pid === cwdHolder.pid && item.canTerminate && item.appName));
  assert((await service.execute(cwdPreview.verificationId)).deleted);
  console.log("PASS: current-directory lock identified and released after confirmation");

  const root = path.join(fixture, "search-root");
  const scope = path.join(root, "documents");
  const state = path.join(fixture, "index-state");
  await mkdir(scope, { recursive: true });
  await mkdir(state);
  await writeFile(path.join(scope, "sample.txt"), "unique-search-needle");
  const child = spawn(path.join(workspace, "native", "indexer", "target", "release", "cshift-indexer.exe"), ["--serve"], { cwd: state, windowsHide: true });
  children.push(child);
  const events = [];
  const pending = new Map();
  let next = 0;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.id && pending.has(value.id)) {
      const item = pending.get(value.id); pending.delete(value.id); clearTimeout(item.timer);
      if (value.ok === false) item.reject(new Error(value.error)); else item.resolve(value);
    } else events.push(value);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const request = (payload) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Request timed out: ${payload.op}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
  await request({ op: "init", root, cachePath: path.join(state, "names.bin"), contentCacheDir: path.join(state, "content") });
  await until(() => events.some((item) => item.event === "status" && item.status.state === "ready"), "name index");
  await request({ op: "contentIndex", scope });
  await until(() => events.some((item) => item.event === "contentStatus" && item.status.state === "ready"), "content index");
  const result = await request({ op: "contentQuery", scope, query: "unique-search-needle", limit: 10 });
  assert(result.results?.length > 0, JSON.stringify(result));
  const moved = path.join(root, "moved-documents");
  await rename(scope, moved);
  await rm(moved, { recursive: true });
  // Suspend a larger content scan with a bounded output queue while keeping
  // the indexer alive, then move and delete its source directory externally.
  await mkdir(scope);
  for (let i = 0; i < 80; i++) await writeFile(path.join(scope, `${i}.txt`), "search words ".repeat(100000));
  await request({ op: "contentIndex", scope });
  await request({ op: "setBackground", background: true });
  await delays(300);
  await rename(scope, moved);
  await rm(moved, { recursive: true });
  assert.equal(child.exitCode, null);
  const movedRoot = path.join(fixture, "moved-search-root");
  await rename(root, movedRoot);
  await rm(movedRoot, { recursive: true });
  await request({ op: "setBackground", background: false });
  console.log("PASS: indexed and paused content-search directories can be moved and deleted with indexer running");
  child.stdin.end();
  await until(() => child.exitCode !== null, "indexer exit");
  lines.close();
} finally {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const stopped = once(child, "exit"); child.kill(); await stopped;
  }
  const resolved = path.resolve(fixture);
  assert.equal(path.dirname(resolved), base);
  assert(path.basename(resolved).startsWith("smoke-") && !(await lstat(resolved)).isSymbolicLink());
  await rm(resolved, { recursive: true, force: true, maxRetries: 5 });
}
