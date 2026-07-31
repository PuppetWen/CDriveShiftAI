import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const sourceExecutable = path.join(
  workspace,
  "release-ready",
  "CDriveShiftAI-x64-portable.exe"
);
const testDirectory = path.join(
  path.dirname(workspace),
  `.cdriveshiftai-portable-smoke-${process.pid}`
);
const executable = path.join(testDirectory, "CDriveShiftAI-x64-portable.exe");
const expectedDataDirectory = path.join(testDirectory, ".cdriveshiftai-data");
const debugPort = 9245;
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function removeTestDirectory(attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(testDirectory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw lastError;
}

async function fetchPage(attempts = 240) {
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
  throw lastError ?? new Error("Portable Electron page target was unavailable");
}

await removeTestDirectory();
await mkdir(testDirectory, { recursive: true });
await copyFile(sourceExecutable, executable);

const child = spawn(
  executable,
  [`--remote-debugging-port=${debugPort}`, "--no-first-run"],
  {
    cwd: testDirectory,
    env: process.env,
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

  await access(expectedDataDirectory);
  console.log(
    JSON.stringify(
      {
        result: "ok",
        launchedAsSingleFile: true,
        dataStoredBesidePortableExecutable: true,
        dataDirectory: expectedDataDirectory
      },
      null,
      2
    )
  );
  void send("Browser.close").catch(() => undefined);
  await wait(350);
} finally {
  socket?.close();
  if (child.exitCode == null) {
    const exited = once(child, "exit");
    child.kill();
    await Promise.race([exited, wait(5_000)]);
  }
  await wait(500);
  await removeTestDirectory();
}
