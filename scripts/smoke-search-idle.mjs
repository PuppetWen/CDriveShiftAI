import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const workspace = path.resolve(import.meta.dirname, "..");
const base = path.join(workspace, ".test-tmp");
await mkdir(base, { recursive: true });
const fixture = await mkdtemp(path.join(base, "search-idle-"));
const files = path.join(fixture, "files");
const binary = path.join(fixture, "indexer.exe");
await mkdir(files);
await copyFile(path.resolve(process.argv[2] || path.join(workspace, "native/indexer/target/release/cshift-indexer.exe")), binary);
await Promise.all(Array.from({ length: 256 }, (_, i) => writeFile(path.join(files, `sample-${i}.txt`), `alpha ${i} beta`)));
const child = spawn(binary, ["--serve"], { cwd: fixture, windowsHide: true, env: { ...process.env, TEMP: fixture, TMP: fixture } });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let id = 0, ready = false;
lines.on("line", line => {
  const value = JSON.parse(line);
  if (value.event === "status" && value.status.state === "ready") ready = true;
  const waiting = pending.get(value.id);
  if (!waiting) return;
  pending.delete(value.id); clearTimeout(waiting.timer);
  value.ok === false ? waiting.reject(new Error(value.error)) : waiting.resolve(value);
});
child.stderr.on("data", () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = payload => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timed out: ${payload.op}`)); }, 10_000);
  pending.set(requestId, { resolve, reject, timer });
  child.stdin.write(`${JSON.stringify({ id: requestId, ...payload })}\n`);
});
const snapshot = () => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "$sampleProcess=Get-Process -Id ([int]$env:CSHIFT_IDLE_PID) -ErrorAction Stop; [PSCustomObject]@{cpu=$sampleProcess.TotalProcessorTime.TotalSeconds; working=$sampleProcess.WorkingSet64; private=$sampleProcess.PrivateMemorySize64}|ConvertTo-Json -Compress"
], { windowsHide: true, encoding: "utf8", env: { ...process.env, CSHIFT_IDLE_PID: String(child.pid), TEMP: fixture, TMP: fixture } }));
try {
  await request({ op: "init", root: files, cachePath: path.join(fixture, "names.bin"), contentCacheDir: path.join(fixture, "content"), mouseButton: "disabled", magnifierEnabled: false });
  for (let n = 0; !ready && n < 100; n++) await wait(50);
  assert(ready, "Fixture index did not become ready");
  const page = await request({ op: "query", query: "sample", keywords: ["sample"], kind: "file", scope: files, limit: 24 });
  assert.equal(page.results.length, 24);
  await request({ op: "setBackground", background: true });
  await wait(500);
  const before = snapshot(); const started = performance.now();
  await wait(6_000);
  const after = snapshot();
  const elapsedSeconds = (performance.now() - started) / 1_000;
  const oneCorePercent = 100 * (after.cpu - before.cpu) / elapsedSeconds;
  console.log(JSON.stringify({ isolatedFiles: 256, idleSeconds: +elapsedSeconds.toFixed(2),
    idleOneCorePercent: +oneCorePercent.toFixed(3), workingSetMiB: +(after.working / 1024 ** 2).toFixed(2),
    privateMiB: +(after.private / 1024 ** 2).toFixed(2), scope: "native indexer only; no user cache or files modified" }, null, 2));
  assert(oneCorePercent < 2, "Background idle unexpectedly uses more than 2% of one CPU core");
  const exited = once(child, "exit"); await request({ op: "quit" }); await exited;
} finally {
  lines.close();
  for (const value of pending.values()) clearTimeout(value.timer);
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  assert.equal(path.dirname(path.resolve(fixture)), base);
  assert(path.basename(fixture).startsWith("search-idle-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
