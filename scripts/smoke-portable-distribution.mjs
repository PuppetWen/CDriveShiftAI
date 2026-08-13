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
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function removeTestDirectory(attempts = 80) {
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

async function waitForPortableData(attempts = 160) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await access(expectedDataDirectory);
      return;
    } catch (error) {
      lastError = error;
    }
    await wait(125);
  }
  throw lastError ?? new Error("Portable application data directory was unavailable");
}

await removeTestDirectory();
await mkdir(testDirectory, { recursive: true });
await copyFile(sourceExecutable, executable);

const child = spawn(
  executable,
  ["--no-first-run"],
  {
    cwd: testDirectory,
    env: {
      ...process.env,
      CDRIVESHIFTAI_SMOKE_QUIT_AFTER_READY_MS: "1800"
    },
    stdio: "ignore",
    windowsHide: true
  }
);

try {
  await waitForPortableData();
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
  await wait(3_000);
} finally {
  if (child.exitCode == null) {
    const exited = once(child, "exit");
    child.kill();
    await Promise.race([exited, wait(5_000)]);
  }
  await wait(500);
  await removeTestDirectory();
}
