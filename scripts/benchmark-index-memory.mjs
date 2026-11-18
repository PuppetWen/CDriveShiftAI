import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, lstat, mkdir, mkdtemp, open, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

// Measure fresh processes and compare ordered result pages without printing file paths.
// A fresh process does not imply a cold Windows disk cache.
// Usage: node scripts/benchmark-index-memory.mjs --mode native|app --base EXE
//          --cache INDEX [--candidate EXE] [--entries COUNT] [--rounds COUNT] [--restart true]
//          [--stable-metadata true]
assert.equal(process.platform, "win32");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const [option, value] = process.argv.slice(index, index + 2);
  assert(option.startsWith("--") && value && !value.startsWith("--"), `Invalid option: ${option}`);
  args.set(option.slice(2), value);
}
const mode = args.get("mode") ?? "native";
assert(["native", "app"].includes(mode), "Expected --mode native or --mode app");
const base = path.resolve(args.get("base") ?? "");
assert(args.has("base") && args.has("cache"), "Supply --base EXE and --cache INDEX");
const candidate = args.has("candidate") ? path.resolve(args.get("candidate")) : undefined;
const cache = path.resolve(args.get("cache"));
const expectedEntries = args.has("entries") ? Number(args.get("entries")) : undefined;
const rounds = Number(args.get("rounds") ?? 9);
assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 30, "Invalid round count");
const restart = args.get("restart") === "true";
const stableMetadata = args.get("stable-metadata") === "true";
const workspace = path.resolve(import.meta.dirname, "..");
const tempRoot = path.join(workspace, ".test-tmp");
const runPowerShell = promisify(execFile);
const powerShell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const scope = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;
const cases = [
  { name: "substring", query: "test" },
  { name: "whole-word", query: "test", filters: { wholeWord: true } },
  { name: "fuzzy", query: "rdscp", filters: { fuzzy: true } },
  { name: "regex", query: "test[0-9]+", filters: { regex: true } },
  { name: "path", query: `system32\\`, filters: { matchPath: true, scope, sortBy: "path" } },
  { name: "path-regex", query: "[sS]ystem32[\\\\/].*\\.dll$", filters: { matchPath: true, regex: true, scope } },
  { name: "scope-extension", query: "dll", filters: { kind: "file", scope, extensions: ["dll"], sortBy: "type" } },
  { name: "size-range", query: "kernel", filters: { kind: "file", scope, minSize: 1_024, maxSize: 10_485_760, sortBy: "size", sortDirection: "desc" } },
  { name: "time-range", query: "kernel", filters: { kind: "file", scope, modifiedAfter: "2020-01-01T00:00:00Z", modifiedBefore: "2037-01-01T00:00:00Z", sortBy: "modified", sortDirection: "desc" } },
  { name: "multi-keyword", query: "kernel shell", filters: { scope, keywords: ["kernel", "shell"], kind: "file", categories: ["executable"] } }
];
const metadataFixtureSize = stableMetadata ? 384 : 0;
let metadataRecords;

async function createStableMetadataFixture(directory) {
  const records = [];
  const query = "benchmark-static-metadata";
  for (let index = 0; index < metadataFixtureSize; index += 1) {
    const target = path.join(directory, `${query}-${String(index).padStart(4, "0")}.txt`);
    const size = 2048 + (index % 41) * 307;
    const modifiedAt = new Date(Date.UTC(2021, index % 6, 1 + index % 28));
    await writeFile(target, Buffer.alloc(size, 65));
    await utimes(target, modifiedAt, modifiedAt);
    const bytes = Buffer.from(target, "utf8");
    const record = Buffer.alloc(13);
    record.writeBigUInt64LE(BigInt(size), 1);
    record.writeUInt32LE(bytes.length, 9);
    records.push(record, bytes);
  }
  const size = cases.find((entry) => entry.name === "size-range");
  Object.assign(size, { query, filters: { ...size.filters, scope: directory, minSize: 3_000, maxSize: 12_000 } });
  const date = cases.find((entry) => entry.name === "time-range");
  Object.assign(date, {
    query,
    filters: {
      ...date.filters, scope: directory, modifiedAfter: "2021-01-01T00:00:00Z",
      modifiedBefore: "2021-05-31T23:59:59Z"
    }
  });
  return Buffer.concat(records);
}

async function addMetadataRecords(cachePath) {
  if (!metadataRecords) return;
  const cacheFile = await open(cachePath, "r+");
  try {
    const header = Buffer.alloc(10);
    const headerRead = await cacheFile.read(header, 0, header.length, 0);
    assert.equal(headerRead.bytesRead, header.length);
    assert.equal(header.subarray(0, 8).toString("utf8"), "CSIDX02\0");
    const countPosition = header.length + header.readUInt16LE(8);
    const count = Buffer.alloc(8);
    assert.equal((await cacheFile.read(count, 0, count.length, countPosition)).bytesRead, count.length);
    count.writeBigUInt64LE(count.readBigUInt64LE() + BigInt(metadataFixtureSize));
    const { size } = await cacheFile.stat();
    assert.equal((await cacheFile.write(metadataRecords, 0, metadataRecords.length, size)).bytesWritten, metadataRecords.length);
    assert.equal((await cacheFile.write(count, 0, count.length, countPosition)).bytesWritten, count.length);
  } finally {
    await cacheFile.close();
  }
}

function percentile(values, percent) {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.ceil(ordered.length * percent) - 1].toFixed(1));
}

function pageSnapshot(page) {
  const { items, hasMore, totalMatches } = page;
  const digest = (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return {
    rows: items.length,
    matches: totalMatches,
    hasMore,
    orderDigest: digest(items.map(({ path: location, name, isDirectory, score }) =>
      [location, name, isDirectory, score])),
    metadataDigest: digest(items.map(({ size, modifiedAt, modifiedAtMs }) =>
      [size, modifiedAt, modifiedAtMs]))
  };
}

async function memory(rootPid, fixture) {
  const command = [
    "$ErrorActionPreference='Stop';",
    "$rootPid=[int]$env:CSHIFT_BENCH_PID;",
    "$tree=@(Get-CimInstance Win32_Process);",
    "$ids=[Collections.Generic.HashSet[int]]::new(); $null=$ids.Add($rootPid);",
    "do {$count=$ids.Count; foreach($entry in $tree){",
    "if($ids.Contains([int]$entry.ParentProcessId)){$null=$ids.Add([int]$entry.ProcessId)}}}while($count -ne $ids.Count);",
    "$counters=@{}; try {Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |",
    "ForEach-Object {$counters[[int]$_.IDProcess]=$_.WorkingSetPrivate}} catch {};",
    "$result=@(foreach($id in $ids){$proc=Get-Process -Id $id -ErrorAction SilentlyContinue;",
    "if($proc){$meta=$tree | Where-Object ProcessId -eq $id | Select-Object -First 1;",
    "$processType=if($meta.CommandLine -match ' --type=([a-zA-Z0-9-]+)'){$Matches[1]}else{$proc.ProcessName};",
    "[pscustomobject]@{type=$processType;cpu=$proc.TotalProcessorTime.TotalSeconds;working=$proc.WorkingSet64;",
    "workingPrivate=$counters[$id];commit=$proc.PrivateMemorySize64;",
    "peakWorking=$proc.PeakWorkingSet64;peakCommit=$proc.PeakPagedMemorySize64}}});",
    "ConvertTo-Json -InputObject $result -Compress"
  ].join("");
  const { stdout } = await runPowerShell(powerShell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    timeout: 20_000,
    env: { ...process.env, TEMP: fixture, TMP: fixture, CSHIFT_BENCH_PID: String(rootPid) }
  });
  const rows = JSON.parse(stdout);
  assert(rows.length > 0, "The measured process already exited");
  function mib(value) {
    return value == null ? null : Number((value / 1024 ** 2).toFixed(1));
  }
  function totals(subset) {
    if (!subset.length) return null;
    return {
      workingMiB: mib(subset.reduce((sum, row) => sum + row.working, 0)),
      privateWorkingMiB: subset.some((row) => row.workingPrivate == null)
        ? null
        : mib(subset.reduce((sum, row) => sum + row.workingPrivate, 0)),
      privateCommitMiB: mib(subset.reduce((sum, row) => sum + row.commit, 0)),
      cpuSeconds: Number(subset.reduce((sum, row) => sum + row.cpu, 0).toFixed(3))
    };
  }
  return {
    tree: totals(rows),
    indexer: totals(mode === "native" ? rows : rows.filter((row) => row.type === "cshift-indexer")),
    processes: rows.map((row) => ({
      type: row.type, ...totals([row]), peakWorkingMiB: mib(row.peakWorking), peakCommitMiB: mib(row.peakCommit)
    }))
  };
}

async function end(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const finished = await Promise.race([exited.then(() => true), sleep(3_000, false, { ref: false })]);
  if (finished) return;
  // Only terminate the spawned benchmark root and its child processes.
  await runPowerShell(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 8_000 }).catch(() => child.kill());
  await exited;
}

function start(executable, childArgs, fixture) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (["TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "ELECTRON_RUN_AS_NODE"].includes(name.toUpperCase())) delete env[name];
  }
  return spawn(executable, childArgs, {
    cwd: fixture, windowsHide: true, stdio: [mode === "native" ? "pipe" : "ignore", "pipe", "pipe"],
    env: {
      ...env, TEMP: fixture, TMP: fixture, APPDATA: fixture, LOCALAPPDATA: fixture,
      CDRIVESHIFTAI_DATA_DIR: fixture,
      CDRIVESHIFTAI_DISABLE_WATCHERS: "1",
      CDRIVESHIFTAI_SMOKE_QUIT_AFTER_READY_MS: "400000"
    }
  });
}

async function nativeConnect(child, cachePath, fixture) {
  let nextId = 0;
  const pending = new Map();
  let lastStatus;
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.event === "status") lastStatus = value.status;
    pending.get(value.id)?.(value);
  });
  function request(payload, timeoutMs = 60_000) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`Indexer timed out: ${payload.op}`)); }, timeoutMs);
      pending.set(id, (result) => {
        clearTimeout(timer);
        pending.delete(id);
        result.ok === false ? reject(Error(result.error)) : resolve(result);
      });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  }
  await request({ op: "init", root: "*", cachePath, contentCacheDir: path.join(fixture, "content-indexes") });
  return {
    status: () => lastStatus,
    search: async (query, filters, options) => {
      const { modifiedAfter, modifiedBefore, ...rest } = filters;
      const result = await request({
        op: "query", query, ...rest, ...options,
        modifiedAfterMs: modifiedAfter ? Date.parse(modifiedAfter) : undefined,
        modifiedBeforeMs: modifiedBefore ? Date.parse(modifiedBefore) : undefined
      });
      return { ...result, items: result.results };
    },
    close: async () => {
      try {
        await request({ op: "quit" }, 3_000);
      } finally {
        reader.close();
        child.stdin.end();
      }
    }
  };
}

async function freeDebugPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitUntil(action, description, timeoutMs = 90_000) {
  const endAt = Date.now() + timeoutMs;
  do {
    const result = await action();
    if (result) return result;
    await sleep(100);
  } while (Date.now() < endAt);
  throw Error(`Timed out waiting for ${description}`);
}

async function appConnect(port, child) {
  child.stdout.resume();
  const endpoint = await waitUntil(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
      const pages = await response.json();
      return pages.find((page) => page.type === "page")?.webSocketDebuggerUrl;
    } catch {
      return undefined;
    }
  }, "Electron debugger", 25_000);
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
  });
  function evaluate(expression) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error("Electron evaluation timed out")); }, 65_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        const error = message.error?.message ?? message.result?.exceptionDetails?.exception?.description ??
          message.result?.exceptionDetails?.text;
        error ? reject(Error(error)) : resolve(message.result?.result?.value);
      });
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }
  await waitUntil(() => evaluate("Boolean(document.querySelector('.app-shell'))"), "Electron app shell", 15_000);
  const uiReadyAt = performance.now();
  await evaluate("window.cDriveShiftAI.navigateApp({view:'overview'})");
  return {
    uiReadyAt,
    status: () => evaluate("window.cDriveShiftAI.indexerStatus()"),
    beginSearch: () => evaluate("window.cDriveShiftAI.navigateApp({view:'search'})"),
    search: (query, filters, options) =>
      evaluate(`window.cDriveShiftAI.searchPage(${JSON.stringify(query)},${JSON.stringify(filters)},${JSON.stringify(options)})`),
    close: async () => {
      try {
        // Don't wait for a debugger response from a closing renderer.
        socket.send(JSON.stringify({ id: ++nextId, method: "Runtime.evaluate", params: { expression: "window.close()" } }));
        await sleep(100);
      } finally {
        socket.close();
      }
    }
  };
}

async function measure(executable, label, fixture, fixtureCache) {
  let child, exited, connection;
  const log = [];
  try {
    const port = mode === "app" ? await freeDebugPort() : undefined;
    const startAt = performance.now();
    child = start(executable, port ? [`--remote-debugging-port=${port}`, "--no-first-run"] : ["--serve"], fixture);
    child.stderr.on("data", (chunk) => { if (log.length < 30) log.push(chunk.toString("utf8")); });
    exited = once(child, "exit");
    connection = mode === "native" ? await nativeConnect(child, fixtureCache, fixture) : await appConnect(port, child);
    const status = await waitUntil(async () => {
      const current = await connection.status();
      if (current?.state === "error") throw Error(`Index startup failed: ${current.message}`);
      if (current?.state === "indexing" && current.mode !== "cached") {
        throw Error(`Cache was not accepted and a rebuild started: ${current.mode}`);
      }
      return current?.state === "ready" ? current : undefined;
    }, "persisted index");
    const readyMs = Math.round(performance.now() - startAt);
    if (expectedEntries !== undefined) assert.equal(status.entries, expectedEntries + metadataFixtureSize);
    const readyMemory = await memory(child.pid, fixture);
    await sleep(4_000); // Exclude GPU startup and overview animation from idle CPU.
    const beforeIdle = await memory(child.pid, fixture);
    const idleStarted = performance.now();
    await sleep(2_500);
    const idleMemory = await memory(child.pid, fixture);
    const idleCpuPct = Number((100_000 * (idleMemory.tree.cpuSeconds - beforeIdle.tree.cpuSeconds) /
      (performance.now() - idleStarted)).toFixed(2));
    await connection.beginSearch?.();
    const observations = cases.map(() => ({ durations: [], pages: [] }));
    async function queryCase(test, page) {
      const { query, filters } = test;
      return connection.search(query, { kind: "all", scope: "*", sortBy: "name", sortDirection: "asc", ...filters }, page);
    }
    async function runCases(first, last) {
      for (let round = 0; round <= rounds; round += 1) {
        for (let index = first; index < last; index += 1) {
          const time = performance.now();
          const page = await queryCase(cases[index], { limit: 120 });
          observations[index].durations.push(performance.now() - time);
          if (round === 0) {
            observations[index].pages.push(pageSnapshot(page));
            if (page.nextCursor) {
              const next = await queryCase(cases[index], { limit: 120, cursor: page.nextCursor });
              observations[index].pages.push(pageSnapshot(next));
            }
          }
        }
      }
    }
    // Sample the effect of uncapped name/regex scans before a full-path query
    // deliberately reads more of the mapped strings.
    const firstPathCase = cases.findIndex((entry) => entry.filters?.matchPath);
    await runCases(0, firstPathCase);
    const nameSearchMemory = await memory(child.pid, fixture);
    await runCases(firstPathCase, cases.length);
    const searchMemory = await memory(child.pid, fixture);
    const report = {
      label, mode, cacheEntries: status.entries, cacheMode: status.mode, readyMs,
      uiReadyMs: connection.uiReadyAt ? Math.round(connection.uiReadyAt - startAt) : undefined,
      readyMemory, idleMemory, idleCpuPct, nameSearchMemory, searchMemory,
      queries: observations.map(({ durations, pages }, index) => ({
        name: cases[index].name,
        firstMs: Number(durations[0].toFixed(1)),
        warmP50Ms: percentile(durations.slice(1), 0.5),
        warmP95Ms: percentile(durations.slice(1), 0.95),
        pages
      }))
    };
    console.log(JSON.stringify(report));
    return report;
  } catch (error) {
    throw Error(`${label}: ${error.message}\n${log.join("").slice(-3_000)}`, { cause: error });
  } finally {
    if (child) {
      try {
        if (child.exitCode === null && child.signalCode === null) await connection?.close();
      } finally {
        await end(child, exited);
      }
    }
  }
}

function assertOrderedPages(first, second) {
  assert.equal(second.cacheEntries, first.cacheEntries, "Files indexed differs");
  const metadataChanges = [];
  for (let index = 0; index < first.queries.length; index += 1) {
    const expected = first.queries[index];
    const actual = second.queries[index];
    const onlyOrder = ({ metadataDigest, ...other }) => other;
    assert.deepEqual(actual.pages.map(onlyOrder), expected.pages.map(onlyOrder), `Different ordered pages: ${expected.name}`);
    if (actual.pages.some((page, n) => page.metadataDigest !== expected.pages[n].metadataDigest)) {
      // These fields are read from live OS files by Electron after each query.
      metadataChanges.push(expected.name);
    }
  }
  if (metadataChanges.length > 0) {
    console.log(JSON.stringify({ first: first.label, second: second.label, liveMetadataChanges: metadataChanges }));
  }
  if (stableMetadata) {
    assert(!metadataChanges.includes("size-range") && !metadataChanges.includes("time-range"),
      "Size or date results changed on the stable metadata fixture");
  }
  return metadataChanges;
}

async function measureCache(executable, label) {
  const fixture = await mkdtemp(path.join(tempRoot, "index-bench-"));
  const fixtureCache = path.join(fixture, "search-index-v1.bin");
  try {
    await copyFile(cache, fixtureCache);
    await addMetadataRecords(fixtureCache);
    const now = new Date();
    await utimes(fixtureCache, now, now);
    await writeFile(path.join(fixture, "cdriveshiftai-state.json"),
      JSON.stringify({ settings: { effectMode: "calm", minimizeToTray: false } }), "utf8");
    const report = await measure(executable, label, fixture, fixtureCache);
    const names = (await readdir(fixture)).filter((name) => name.startsWith("search-index"));
    const cacheFiles = await Promise.all(names.map(async (name) => ({
      name, bytes: (await stat(path.join(fixture, name))).size
    })));
    console.log(JSON.stringify({ label, mode, cacheFiles }));
    if (restart) {
      const reopened = await measure(executable, `${label}-restart`, fixture, fixtureCache);
      assertOrderedPages(report, reopened);
    }
    return report;
  } finally {
    assert.equal(path.dirname(fixture), tempRoot);
    assert(path.basename(fixture).startsWith("index-bench-") && !(await lstat(fixture)).isSymbolicLink());
    await rm(fixture, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  }
}

await access(base);
await access(cache);
await mkdir(tempRoot, { recursive: true });
const metadataRoot = stableMetadata ? await mkdtemp(path.join(tempRoot, "index-bench-meta-")) : undefined;
try {
  if (metadataRoot) {
    metadataRecords = await createStableMetadataFixture(metadataRoot);
    console.log(JSON.stringify({ mode, controlledMetadataEntries: metadataFixtureSize }));
  }
  const first = await measureCache(base, "baseline");
  if (candidate) {
    await access(candidate);
    const second = await measureCache(candidate, "candidate");
    const metadataChanges = assertOrderedPages(first, second);
    console.log(JSON.stringify({
      result: "ok", mode, orderedPageFingerprintsMatch: true,
      metadataFingerprintsMatch: metadataChanges.length === 0,
      controlledMetadataFingerprintsMatch: stableMetadata || undefined
    }));
  }
} finally {
  if (metadataRoot) {
    assert.equal(path.dirname(metadataRoot), tempRoot);
    assert(path.basename(metadataRoot).startsWith("index-bench-meta-") && !(await lstat(metadataRoot)).isSymbolicLink());
    await rm(metadataRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  }
}
