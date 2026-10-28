import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

// Exercise the updater's real process entry point from the old app data cwd.
// Both the package and target are deliberately invalid PE files: no NSIS
// installer, registry mutation, or real application can execute in this test.
assert.equal(process.platform, "win32", "This regression test needs Windows directory locks");
const workspace = path.resolve(import.meta.dirname, "..");
const temporaryRoot = path.join(workspace, ".test-tmp");
await mkdir(temporaryRoot, { recursive: true });
const fixture = await mkdtemp(path.join(temporaryRoot, "updater-cwd-"));
const baseline = process.argv.find(argument => argument.startsWith("--baseline="))?.slice("--baseline=".length);
const helper = path.resolve(process.argv.find(argument => argument.startsWith("--helper="))?.slice("--helper=".length) ?? path.join(workspace, "native/updater/target/release/cshift-updater.exe"));
const invalidImage = Buffer.from("MZ-invalid-updater-cwd-test-image");
const marker = "preserve-settings-index-and-journal";

async function runCase(executable, name, expectDirectoryLock) {
  const root = path.join(fixture, name);
  const installed = path.join(root, "application");
  const data = path.join(installed, ".cdriveshiftai-data");
  const staging = path.join(root, ".cdriveshiftai-update", "0.2.1");
  const inheritedTemp = path.join(root, "inherited-temp");
  await Promise.all([mkdir(data, { recursive: true }), mkdir(staging, { recursive: true }), mkdir(inheritedTemp, { recursive: true })]);
  const packagePath = path.join(staging, "invalid-installer.exe");
  const targetPath = path.join(installed, "invalid-application.exe");
  const planPath = path.join(staging, "update-plan.json");
  const logPath = path.join(staging, "update.log");
  await Promise.all([writeFile(packagePath, invalidImage), writeFile(targetPath, invalidImage), writeFile(path.join(data, "sentinel.txt"), marker)]);
  await writeFile(planPath, JSON.stringify({
    schemaVersion: 1, mode: "installed", parentPid: 0, packagePath, targetPath,
    installedDir: installed, stagingDir: staging,
    backupPath: path.join(staging, "previous-version"),
    successMarker: path.join(staging, "update-success.json"),
    expectedVersion: "0.2.1", expectedSha512: createHash("sha512").update(invalidImage).digest("hex"), logPath
  }));
  assert.deepEqual(await readFile(packagePath), invalidImage);
  const environment = { ...process.env, TEMP: inheritedTemp, TMP: inheritedTemp };
  delete environment.CDRIVESHIFTAI_DATA_DIR;
  const started = performance.now();
  const child = spawn(path.resolve(executable), ["--plan", planPath], { cwd: data, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  let timer;
  const code = await new Promise((resolve, reject) => {
    timer = setTimeout(() => { child.kill(); reject(Error("Isolated updater did not exit in 35 seconds")); }, 35_000);
    child.once("error", reject);
    child.once("exit", resolve);
  }).finally(() => clearTimeout(timer));
  const elapsedMs = Math.round(performance.now() - started);
  const log = await readFile(logPath, "utf8");
  assert.equal(code, 1, "The invalid package must never produce a successful installation");
  assert.match(log, /helper SHA-512 verification passed/);
  assert.match(log, /moving application data outside the old install directory/);
  assert.equal(log.includes("starting silent NSIS update"), !expectDirectoryLock, log);
  if (expectDirectoryLock) {
    assert(elapsedMs >= 19_000, "The old helper should exhaust its 20-second directory-move retries");
  } else {
    assert.match(log, /restoring installed application backup/);
    assert(elapsedMs < 15_000, "The corrected helper should reach invalid-package rejection without lock retries");
  }
  assert.equal(await readFile(path.join(data, "sentinel.txt"), "utf8"), marker);
  assert.deepEqual(await readFile(targetPath), invalidImage);
  return { name, elapsedMs, directoryMoveBlocked: expectDirectoryLock, packageExecutionRejected: true, applicationDataPreserved: true, error: stderr.trim() };
}

try {
  const results = [];
  if (baseline) results.push(await runCase(baseline, "before", true));
  results.push(await runCase(helper, "after", false));
  console.log(JSON.stringify({ result: "ok", realInstallerExecuted: false, cases: results }, null, 2));
} finally {
  const relative = path.relative(temporaryRoot, fixture);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
