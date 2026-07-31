import { spawn } from "node:child_process";
import { once } from "node:events";
import { stat, utimes } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(
  workspace,
  "release-ready",
  "win-unpacked",
  "CDriveShiftAI.exe"
);
const dataDirectory = path.join(workspace, ".cdriveshiftai-data");
const cachePath = path.join(dataDirectory, "search-index-v1.bin");
const debugPort = 9244;
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchPage(attempts = 160) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${debugPort}/json/list`
      );
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((candidate) => candidate.type === "page");
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(125);
  }
  throw lastError ?? new Error("Electron page target was unavailable");
}

const cache = await stat(cachePath);
if (cache.size === 0) {
  throw new Error(`Persisted index is empty: ${cachePath}`);
}
// This smoke specifically verifies the valid-cache path. Preserve the user's
// real refresh timestamp and temporarily keep the cache inside the 24 h policy
// window; expiry/forced refresh is covered by the native policy tests.
await utimes(cachePath, cache.atime, new Date());

const child = spawn(
  executable,
  [`--remote-debugging-port=${debugPort}`, "--no-first-run"],
  {
    env: {
      ...process.env,
      CDRIVESHIFTAI_DATA_DIR: dataDirectory
    },
    stdio: "ignore",
    windowsHide: true
  }
);

let socket;
try {
  const page = await fetchPage();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text);
    }
    return response.result?.value;
  };

  await send("Runtime.enable");
  // Explicitly exercise the same main-process show path used by the tray and
  // global shortcut. Test runners can start Electron without an activated
  // foreground window, which intentionally keeps the index loader paused.
  await evaluate(
    "window.cDriveShiftAI?.navigateApp?.({view:'overview'}).catch(() => undefined)"
  );
  const observed = [];
  let ready;
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const status = await evaluate(
      "window.cDriveShiftAI?.indexerStatus?.().catch(() => undefined)"
    );
    if (status) {
      observed.push({
        state: status.state,
        mode: status.mode,
        entries: status.entries
      });
      if (status.state === "indexing") {
        throw new Error(
          `Packaged app started a full rebuild despite a valid cache: ${JSON.stringify(
            status
          )}`
        );
      }
      if (status.state === "ready") {
        ready = status;
        break;
      }
    }
    await wait(250);
  }

  if (!ready || ready.mode !== "cached" || ready.entries <= 0) {
    throw new Error(
      `Packaged app did not load the persisted index: ${JSON.stringify({
        ready,
        observed: observed.slice(-10)
      })}`
    );
  }

  console.log(
    JSON.stringify(
      {
        result: "ok",
        cacheBytes: cache.size,
        state: ready.state,
        mode: ready.mode,
        entries: ready.entries,
        fullRebuildAfterRestart: false
      },
      null,
      2
    )
  );
} finally {
  socket?.close();
  if (child.exitCode == null) {
    const exited = once(child, "exit");
    child.kill();
    await Promise.race([exited, wait(3_000)]);
  }
  await utimes(cachePath, cache.atime, cache.mtime);
}
