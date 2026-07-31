import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(
  workspace,
  "native",
  "indexer",
  "target",
  "release",
  "cshift-indexer.exe"
);
const dataRoot = path.join(workspace, ".cdriveshiftai-data");
const child = spawn(executable, ["--serve"], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"]
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
const statusWaiters = new Set();
const statuses = [];
let nextId = 0;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.event === "status") {
    statuses.push(message.status);
    for (const waiter of [...statusWaiters]) waiter(message.status);
  }
  const waiter = message.id ? pending.get(message.id) : undefined;
  if (!waiter) return;
  clearTimeout(waiter.timer);
  pending.delete(message.id);
  if (message.ok === false) waiter.reject(new Error(message.error));
  else waiter.resolve(message);
});

function waitForReady(timeoutMs = 120_000) {
  const ready = statuses.find((status) => status?.state === "ready");
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      statusWaiters.delete(handler);
      reject(new Error("Timed out waiting for the full name index"));
    }, timeoutMs);
    const handler = (status) => {
      if (status?.state !== "ready") return;
      clearTimeout(timer);
      statusWaiters.delete(handler);
      resolve(status);
    };
    statusWaiters.add(handler);
  });
}

function request(payload, timeoutMs) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Native request ${id} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
}

try {
  const loadStarted = performance.now();
  await request(
    {
      op: "init",
      root: "*",
      cachePath: path.join(dataRoot, "search-index-v1.bin"),
      contentCacheDir: path.join(dataRoot, "content-indexes")
    },
    120_000
  );
  const readyStatus = await waitForReady();
  const loadMs = performance.now() - loadStarted;
  const query = process.argv[2] || "redscope";
  const queryStarted = performance.now();
  const response = await request(
    { op: "query", query, kind: "all", scope: "*", limit: 160 },
    15_000
  );
  const queryMs = performance.now() - queryStarted;
  const memory = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$p=Get-Process -Id ${child.pid};[pscustomobject]@{working=$p.WorkingSet64;private=$p.PrivateMemorySize64}|ConvertTo-Json -Compress`
      ],
      { encoding: "utf8", windowsHide: true }
    )
  );
  console.log(
    JSON.stringify(
      {
        query,
        loadMs: Math.round(loadMs),
        indexedEntries: readyStatus.entries,
        queryMs: Number(queryMs.toFixed(2)),
        workingSetMB: Number((memory.working / 1024 ** 2).toFixed(1)),
        privateMB: Number((memory.private / 1024 ** 2).toFixed(1)),
        matches: response.results?.length ?? 0,
        firstMatches: (response.results ?? []).slice(0, 5).map((item) => item.path)
      },
      null,
      2
    )
  );
} finally {
  try {
    await request({ op: "quit" }, 2_000);
  } catch {
    child.kill();
  }
}
