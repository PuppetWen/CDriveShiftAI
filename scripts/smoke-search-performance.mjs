import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

if (process.platform !== "win32") {
  throw new Error("The persisted search performance test requires Windows");
}

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(
  workspace,
  "native",
  "indexer",
  "target",
  "release",
  "cshift-indexer.exe"
);
const cachePath = path.join(workspace, ".cdriveshiftai-data", "search-index-v1.bin");
const contentCacheDir = path.join(workspace, ".cdriveshiftai-data", "content-indexes");
await access(executable);
await access(cachePath);

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const child = spawn(executable, ["--serve"], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"]
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
const statuses = [];
let nextId = 0;
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.event === "status") statuses.push(message.status);
  const pendingRequest = pending.get(message.id);
  if (!pendingRequest) return;
  pending.delete(message.id);
  clearTimeout(pendingRequest.timer);
  if (message.ok === false) pendingRequest.reject(new Error(message.error));
  else pendingRequest.resolve(message);
});

const request = (payload, timeoutMs = 60_000) => {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Native request ${id} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
};

const waitUntilReady = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = statuses.find((status) => status.state === "ready");
    if (ready) return ready;
    await wait(50);
  }
  throw new Error(`Persisted index did not become ready: ${JSON.stringify(statuses)}`);
};

const timedQuery = async ({ query, wholeWord = false, fuzzy = false, regex = false }) => {
  const started = performance.now();
  const response = await request({
    op: "query",
    query,
    kind: "all",
    scope: "*",
    scopes: [],
    categories: [],
    extensions: [],
    wholeWord,
    fuzzy,
    regex,
    sortBy: "name",
    sortDirection: "asc",
    limit: 240
  });
  return {
    elapsedMs: Number((performance.now() - started).toFixed(1)),
    returned: response.results?.length ?? 0,
    totalMatches: response.totalMatches ?? 0,
    hasMore: response.hasMore === true
  };
};

try {
  await request({
    op: "init",
    root: "*",
    cachePath,
    contentCacheDir,
    background: false
  });
  const ready = await waitUntilReady();
  const substring = await timedQuery({ query: "test" });
  const completeWord = await timedQuery({ query: "test", wholeWord: true });
  const fuzzy = await timedQuery({ query: "rdscp", fuzzy: true });
  console.log(
    JSON.stringify(
      {
        result: "ok",
        indexMode: ready.mode,
        indexEntries: ready.entries,
        substring,
        completeWord,
        fuzzy
      },
      null,
      2
    )
  );
} finally {
  try {
    await request({ op: "quit" }, 3_000);
  } catch {
    child.kill();
  }
  if (/panic|uncaught/i.test(stderr)) {
    throw new Error(stderr);
  }
}
