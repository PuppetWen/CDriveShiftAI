import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// Synthetic names only: no user index is loaded, changed, or crawled.
const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.resolve(process.argv[2] || path.join(workspace, "native/indexer/target/release/cshift-indexer.exe"));
const reportPath = process.argv[3] && path.resolve(process.argv[3]);
const count = Number(process.env.SEARCH_BENCHMARK_ENTRIES || 1_000_000);
assert(Number.isInteger(count) && count > 0 && count <= 2_000_000);
const tempRoot = path.join(workspace, ".test-tmp");
await mkdir(tempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(tempRoot, "keyword-perf-"));
const root = path.join(fixture, "files");
const cachePath = path.join(fixture, "names.bin");
await mkdir(root);
const queries = [
  { name: "single-selective", query: "dsh", keywords: ["dsh"] },
  { name: "or-selective", query: "dsh deepseek", keywords: ["dsh", "deepseek"] },
  { name: "or-common", query: "module renderer", keywords: ["module", "renderer"] },
  { name: "short-common", query: "m", keywords: ["m"] },
  { name: "name-sort-common", query: "module", keywords: ["module"], sortBy: "name" }
].map(value => ({ ...value, total: 0 }));
const cache = await open(cachePath, "w");
const rootBytes = Buffer.from(root);
const header = Buffer.alloc(18 + rootBytes.length);
header.write("CSIDX02\0", "binary"); header.writeUInt16LE(rootBytes.length, 8);
rootBytes.copy(header, 10); header.writeBigUInt64LE(BigInt(count), 10 + rootBytes.length);
await cache.write(header);
let buffers = [], bytes = 0;
for (let i = 0; i < count; i++) {
  const prefix = i % 10_000 === 0 ? "dsh" : i % 5_000 === 0 ? "deepseek" : i % 100 === 0 ? "renderer" : "module";
  const name = `${prefix}-${String((i * 7919) % count).padStart(7, "0")}.ts`;
  for (const query of queries) if (query.keywords.some(term => name.includes(term))) query.total++;
  const value = Buffer.from(path.join(root, name));
  const record = Buffer.alloc(13 + value.length);
  record.writeBigUInt64LE(128n, 1); record.writeUInt32LE(value.length, 9); value.copy(record, 13);
  buffers.push(record); bytes += record.length;
  if (bytes >= 4 * 1024 * 1024) { await cache.write(Buffer.concat(buffers)); buffers = []; bytes = 0; }
}
if (buffers.length) await cache.write(Buffer.concat(buffers));
await cache.close();
const child = spawn(executable, ["--serve"], { cwd: fixture, windowsHide: true,
  env: { ...process.env, TEMP: fixture, TMP: fixture }, stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map(); let nextId = 0, ready = false, stderr = "";
child.stderr.on("data", data => { stderr += data.toString(); });
lines.on("line", line => {
  const response = JSON.parse(line);
  if (response.event === "status" && response.status.state === "ready") ready = true;
  const call = pending.get(response.id); if (!call) return;
  pending.delete(response.id); clearTimeout(call.timeout);
  if (response.ok === false) call.reject(Error(response.error)); else call.resolve(response);
});
const request = payload => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timeout = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${payload.op}`)); }, 30_000);
  pending.set(id, { resolve, reject, timeout }); child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await request({ op: "init", root, cachePath, contentCacheDir: path.join(fixture, "content"), mouseButton: "disabled", magnifierEnabled: false });
  for (let n = 0; !ready && n < 600; n++) await wait(50);
  assert(ready, `Synthetic cache did not load: ${stderr}`);
  const results = [];
  for (const query of queries) {
    const elapsed = [];
    for (let iteration = 0; iteration < 6; iteration++) {
      const started = performance.now();
      const response = await request({ op: "query", query: query.query, keywords: query.keywords,
        kind: "file", scope: "*", sortBy: query.sortBy || "relevance", sortDirection: query.sortBy ? "asc" : "desc", limit: 240 });
      assert.equal(response.totalMatches, query.total, query.name);
      assert.equal(new Set(response.results.map(value => value.path)).size, response.results.length);
      if (iteration) elapsed.push(performance.now() - started);
    }
    elapsed.sort((a, b) => a - b);
    results.push({ query: query.name, totalMatches: query.total, medianMs: +elapsed[2].toFixed(2), maxMs: +elapsed.at(-1).toFixed(2) });
  }
  const report = { entries: count, measuredRounds: 5, results };
  console.log(JSON.stringify(report, null, 2));
  if (reportPath) { await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n"); }
  await request({ op: "quit" }); await once(child, "exit");
} finally {
  lines.close();
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  for (const call of pending.values()) clearTimeout(call.timeout);
  assert.equal(path.dirname(path.resolve(fixture)), tempRoot);
  assert(path.basename(fixture).startsWith("keyword-perf-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
