import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
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
const testRoot = path.join(workspace, ".cdriveshiftai-data", "test-temp");
await mkdir(testRoot, { recursive: true });
const temporary = await mkdtemp(path.join(testRoot, "index-cache-restart-"));
const fixture = path.join(temporary, "fixture");
const cachePath = path.join(temporary, "cache", "names.bin");
const contentCacheDir = path.join(temporary, "content");
const baseFile = path.join(fixture, "base-before-restart.txt");
const deltaFile = path.join(fixture, "delta-after-ready.txt");
await mkdir(fixture, { recursive: true });
await writeFile(baseFile, "base snapshot", "utf8");

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function launchIndexer() {
  const child = spawn(executable, ["--serve"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const statuses = [];
  let nextId = 0;
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "status") statuses.push(message.status);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok === false) request.reject(new Error(message.error));
    else request.resolve(message);
  });
  const request = (payload, timeoutMs = 20_000) => {
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
  const query = (text) =>
    request({
      op: "query",
      query: text,
      kind: "all",
      scope: fixture,
      limit: 20
    });
  const waitForStatus = async (predicate, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = statuses.find(predicate);
      if (status) return status;
      await wait(50);
    }
    throw new Error(`Timed out waiting for status: ${JSON.stringify(statuses)}`);
  };
  const stop = async () => {
    try {
      await request({ op: "quit" }, 2_000);
    } finally {
      if (child.exitCode == null) child.kill();
    }
  };
  return { request, query, statuses, waitForStatus, stop };
}

try {
  const first = launchIndexer();
  await first.request({
    op: "init",
    root: fixture,
    cachePath,
    contentCacheDir
  });
  await first.waitForStatus((status) => status.state === "ready");

  await writeFile(deltaFile, "watcher delta", "utf8");
  await unlink(baseFile);
  const watcherDeadline = Date.now() + 8_000;
  let watcherApplied = false;
  while (Date.now() < watcherDeadline) {
    const [added, removed] = await Promise.all([
      first.query("delta-after-ready"),
      first.query("base-before-restart")
    ]);
    if (
      added.results?.some((item) => item.path === deltaFile) &&
      !removed.results?.some((item) => item.path === baseFile)
    ) {
      watcherApplied = true;
      break;
    }
    await wait(100);
  }
  if (!watcherApplied) {
    throw new Error("Live watcher did not apply fixture changes");
  }
  await first.stop();

  const deltaLog = await readFile(cachePath.replace(/\.bin$/i, ".delta"), "utf8");
  if (!deltaLog.includes("delta-after-ready") || !deltaLog.includes("base-before-restart")) {
    throw new Error("Incremental index log did not persist watcher changes");
  }

  const second = launchIndexer();
  await second.request({
    op: "init",
    root: fixture,
    cachePath,
    contentCacheDir
  });
  const restored = await second.waitForStatus(
    (status) => status.state === "ready" && status.mode === "cached"
  );
  await wait(700);
  if (second.statuses.some((status) => status.state === "indexing")) {
    throw new Error(
      `Persisted index triggered an unexpected full rebuild: ${JSON.stringify(
        second.statuses
      )}`
    );
  }
  const [addedAfterRestart, removedAfterRestart] = await Promise.all([
    second.query("delta-after-ready"),
    second.query("base-before-restart")
  ]);
  if (
    !addedAfterRestart.results?.some((item) => item.path === deltaFile) ||
    removedAfterRestart.results?.some((item) => item.path === baseFile)
  ) {
    throw new Error("Incremental changes were not restored after restart");
  }
  await second.stop();

  const forced = launchIndexer();
  await forced.request({
    op: "init",
    root: fixture,
    cachePath,
    contentCacheDir,
    forceRebuild: true,
    rebuildReason: "system-restart"
  });
  await forced.waitForStatus((status) => status.state === "ready");
  if (!forced.statuses.some((status) => status.state === "indexing")) {
    throw new Error("Forced refresh did not start a full rebuild");
  }
  await forced.stop();
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: restored.mode,
        entries: restored.entries,
        fullRebuildAfterRestart: false,
        deltaReplayVerified: true,
        forcedRefreshVerified: true
      },
      null,
      2
    )
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
