import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const scope = process.argv[2];
const contentCacheDir = process.argv[3];
if (!scope || !contentCacheDir) {
  throw new Error("Usage: node scripts/rebuild-content-index.mjs <scope> <content-cache-dir>");
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
const testTempRoot = path.join(workspace, ".cdriveshiftai-data", "test-temp");
await mkdir(testTempRoot, { recursive: true });
const fixture = await mkdtemp(path.join(testTempRoot, "rebuild-"));
await mkdir(contentCacheDir, { recursive: true });

const child = spawn(executable, ["--serve"], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"]
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
const eventWaiters = new Set();
let nextId = 0;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  const request = pending.get(message.id);
  if (request) {
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.ok === false) request.reject(new Error(message.error));
    else request.resolve(message);
    return;
  }
  if (message.event === "contentStatus") {
    const status = message.status;
    if (status.filesIndexed === 0 || status.filesIndexed % 1_000 === 0 || status.state !== "indexing") {
      console.log(
        `${status.state}: ${status.filesIndexed.toLocaleString()} documents — ${status.message}`
      );
    }
  }
  for (const waiter of [...eventWaiters]) waiter(message);
});

function request(payload, timeoutMs = 15_000) {
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

function waitForReady(timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventWaiters.delete(handler);
      reject(new Error("Content index rebuild timed out"));
    }, timeoutMs);
    const handler = (message) => {
      if (message.event !== "contentStatus") return;
      if (message.status?.state === "error") {
        clearTimeout(timer);
        eventWaiters.delete(handler);
        reject(new Error(message.status.message));
      } else if (message.status?.state === "ready") {
        clearTimeout(timer);
        eventWaiters.delete(handler);
        resolve(message.status);
      }
    };
    eventWaiters.add(handler);
  });
}

try {
  await request({
    op: "init",
    root: fixture,
    cachePath: path.join(fixture, "names.bin"),
    contentCacheDir
  });
  await request({ op: "contentIndex", scope });
  const ready = await waitForReady();
  const persisted = await request({ op: "contentStatus", scope });
  console.log(
    JSON.stringify(
      {
        root: ready.root,
        indexedDocuments: ready.filesIndexed,
        persistedDocuments: persisted.status?.filesIndexed,
        result: "ok"
      },
      null,
      2
    )
  );
  await request({ op: "quit" });
} finally {
  if (!child.killed) child.kill();
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  await rm(fixture, { recursive: true, force: true });
}
