import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  throw new Error("The transactional updater smoke test requires Windows");
}

const workspace = path.resolve(import.meta.dirname, "..");
const tamperPackage = process.argv.includes("--tamper");
const invalidStartupPackage = process.argv.includes("--invalid-start");
const suppliedOldPortable = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith("--"));
const testRoot = path.join(
  workspace,
  ".cdriveshiftai-data",
  "test-temp",
  "update-smoke-0.0.2"
);
const oldPortable =
  suppliedOldPortable ??
  path.join(testRoot, "download", "CDriveShiftAI-x64-portable.exe");
const distribution = path.join(testRoot, "distribution");
const target = path.join(distribution, "CDriveShiftAI-update-smoke.exe");
const staging = path.join(distribution, ".cdriveshiftai-update", "0.0.2");
const packagePath = path.join(staging, "CDriveShiftAI-x64-portable.exe");
const helperPath = path.join(staging, "cshift-updater.exe");
const planPath = path.join(staging, "update-plan.json");
const backupPath = path.join(staging, "previous-version.exe");
const successMarker = path.join(staging, "update-success.json");
const logPath = path.join(staging, "update.log");
const newPortable = path.join(
  workspace,
  "release-ready",
  "CDriveShiftAI-x64-portable.exe"
);
const helperSource = path.join(
  workspace,
  "release-ready",
  "win-unpacked",
  "resources",
  "bin",
  "cshift-updater.exe"
);

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function sha512(candidate) {
  const digest = createHash("sha512");
  digest.update(await readFile(candidate));
  return digest.digest("hex");
}

async function fileVersion(candidate) {
  const command = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "(Get-Item -LiteralPath $env:CSHIFT_SMOKE_VERSION_PATH).VersionInfo.FileVersion"
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CSHIFT_SMOKE_VERSION_PATH: candidate }
    }
  );
  let output = "";
  let errorOutput = "";
  command.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  command.stderr.on("data", (chunk) => {
    errorOutput += chunk.toString("utf8");
  });
  const [code] = await once(command, "exit");
  if (code !== 0) {
    throw new Error(
      `Could not read the portable executable version: ${errorOutput.trim()}`
    );
  }
  return output.trim();
}

async function stopSmokeApplication() {
  const processName = path.basename(target);
  const killer = spawn(
    "taskkill.exe",
    ["/IM", processName, "/T", "/F"],
    { windowsHide: true, stdio: "ignore" }
  );
  await once(killer, "exit").catch(() => undefined);
}

async function removeDistributionWithRetry() {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(distribution, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

await mkdir(staging, { recursive: true });
await copyFile(oldPortable, target);
await copyFile(newPortable, packagePath);
await copyFile(helperSource, helperPath);
const beforeVersion = await fileVersion(target);
if (beforeVersion !== "0.0.1") {
  throw new Error(`Expected a 0.0.1 portable fixture, received ${beforeVersion}`);
}
if (invalidStartupPackage) {
  await writeFile(packagePath, Buffer.from("MZ-invalid-CDriveShiftAI-update"));
}
const expectedSha512 = await sha512(packagePath);
if (tamperPackage) {
  await appendFile(packagePath, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
}
await writeFile(
  planPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      mode: "portable",
      parentPid: 0,
      packagePath,
      targetPath: target,
      stagingDir: staging,
      backupPath,
      successMarker,
      expectedVersion: "0.0.2",
      expectedSha512,
      logPath
    },
    null,
    2
  ),
  "utf8"
);

let helper;
try {
  helper = spawn(helperPath, ["--plan", planPath], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let helperError = "";
  helper.stderr.on("data", (chunk) => {
    helperError += chunk.toString("utf8");
  });
  let timeout;
  const result = await Promise.race([
    once(helper, "exit").then(([code]) => ({ code, timedOut: false })),
    new Promise((resolve) =>
      {
        timeout = setTimeout(
          () => resolve({ code: null, timedOut: true }),
          120_000
        );
      }
    )
  ]);
  clearTimeout(timeout);
  if (result.timedOut) {
    helper.kill();
    throw new Error("Updater helper timed out");
  }
  if (tamperPackage) {
    if (result.code === 0) {
      throw new Error("Tampered update package was incorrectly accepted");
    }
    const afterRejectedVersion = await fileVersion(target);
    if (
      afterRejectedVersion !== "0.0.1" ||
      (await exists(backupPath))
    ) {
      throw new Error(
        `Checksum rejection modified the old version: ${afterRejectedVersion}`
      );
    }
    console.log(
      JSON.stringify(
        {
          result: "ok",
          mode: "checksum-rejection",
          oldVersionPreserved: true,
          replacementRefused: true,
          helperError: helperError.trim()
        },
        null,
        2
      )
    );
  } else if (invalidStartupPackage) {
    if (result.code === 0) {
      throw new Error("Invalid replacement unexpectedly started");
    }
    const restoredVersion = await fileVersion(target);
    if (restoredVersion !== "0.0.1" || (await exists(backupPath))) {
      throw new Error(
        `Failed startup did not restore the old portable version: ${restoredVersion}`
      );
    }
    console.log(
      JSON.stringify(
        {
          result: "ok",
          mode: "startup-rollback",
          oldVersionRestored: true,
          failedReplacementRemoved: true,
          helperError: helperError.trim()
        },
        null,
        2
      )
    );
  } else if (result.code !== 0) {
    throw new Error(
      `Updater helper exited with ${result.code}: ${helperError.trim()}`
    );
  } else {
    const afterVersion = await fileVersion(target);
    if (afterVersion !== "0.0.2") {
      throw new Error(`Portable target was not replaced: ${afterVersion}`);
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!(await exists(packagePath)) && !(await exists(backupPath))) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if ((await exists(packagePath)) || (await exists(backupPath))) {
      throw new Error("Successful update did not delete its package and backup");
    }
    const targetStats = await stat(target);
    console.log(
      JSON.stringify(
        {
          result: "ok",
          mode: "portable",
          beforeVersion,
          afterVersion,
          targetReplacedInPlace: true,
          packageDeletedAfterStart: true,
          backupDeletedAfterStart: true,
          targetBytes: targetStats.size
        },
        null,
        2
      )
    );
  }
} finally {
  await stopSmokeApplication();
  if (helper && helper.exitCode == null) helper.kill();
  await removeDistributionWithRetry();
}
