import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  throw new Error("The installed updater smoke test requires Windows");
}

const workspace = path.resolve(import.meta.dirname, "..");
const currentVersion = JSON.parse(
  await readFile(path.join(workspace, "package.json"), "utf8")
).version;
const testRoot = path.join(
  workspace,
  ".cdriveshiftai-data",
  "test-temp",
  "installed-update-smoke"
);
const oldInstaller = path.join(
  testRoot,
  "download",
  "CDriveShiftAI-x64.exe"
);
const installDirectory = path.join(testRoot, "installation");
const installedExecutable = path.join(installDirectory, "CDriveShiftAI.exe");
const dataDirectory = path.join(installDirectory, ".cdriveshiftai-data");
const sentinel = path.join(dataDirectory, "update-sentinel.txt");
const staging = path.join(testRoot, ".cdriveshiftai-update", currentVersion);
const packagePath = path.join(staging, "CDriveShiftAI-x64.exe");
const helperPath = path.join(staging, "cshift-updater.exe");
const planPath = path.join(staging, "update-plan.json");
const backupPath = path.join(staging, "previous-version");
const successMarker = path.join(staging, "update-success.json");
const logPath = path.join(staging, "update.log");
const newInstaller = path.join(
  workspace,
  "release-ready",
  "CDriveShiftAI-x64.exe"
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

async function run(executable, argumentList, timeoutMs = 120_000) {
  const child = spawn(executable, argumentList, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  let timeout;
  const result = await Promise.race([
    once(child, "exit").then(([code]) => ({ code, timedOut: false })),
    new Promise((resolve) => {
      timeout = setTimeout(
        () => resolve({ code: null, timedOut: true }),
        timeoutMs
      );
    })
  ]);
  clearTimeout(timeout);
  if (result.timedOut) {
    child.kill();
    throw new Error(`${path.basename(executable)} timed out`);
  }
  return { code: result.code, stdout, stderr };
}

async function fileVersion(candidate) {
  const command =
    "(Get-Item -LiteralPath $env:CSHIFT_SMOKE_VERSION_PATH).VersionInfo.FileVersion";
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CSHIFT_SMOKE_VERSION_PATH: candidate }
    }
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`Could not read version for ${candidate}`);
  return output.trim();
}

async function listDotNetInstallUtilities() {
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$items=@(Get-CimInstance Win32_Process | Where-Object {",
        "$_.Name -ieq 'InstallUtil.exe'} |",
        "Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine);",
        "$items | ConvertTo-Json -Compress"
      ].join("")
    ],
    10_000
  );
  if (result.code !== 0 || !result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function stopInstalledProcesses() {
  const script = `
    $root = [System.IO.Path]::GetFullPath($env:CSHIFT_SMOKE_INSTALL_PATH)
    Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and
      [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
        $root + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
      )
    } | ForEach-Object {
      Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null
    }
  `;
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-Command", script],
    {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CSHIFT_SMOKE_INSTALL_PATH: installDirectory
      }
    }
  );
  await once(child, "exit").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function cleanup() {
  await stopInstalledProcesses();
  const uninstaller = path.join(
    installDirectory,
    "Uninstall CDriveShiftAI.exe"
  );
  if (await exists(uninstaller)) {
    await run(uninstaller, ["/S"], 60_000).catch(() => undefined);
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(installDirectory, { recursive: true, force: true });
      await rm(path.join(testRoot, ".cdriveshiftai-update"), {
        recursive: true,
        force: true
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

await cleanup();
await mkdir(staging, { recursive: true });
const dotNetUtilitiesBefore = await listDotNetInstallUtilities();
const baselineUtilityIds = new Set(
  dotNetUtilitiesBefore.map((item) => Number(item.ProcessId))
);
let completed = false;
try {
  const install = await run(oldInstaller, [
    "/S",
    `/D=${installDirectory}`
  ]);
  if (install.code !== 0 || !(await exists(installedExecutable))) {
    throw new Error(
      `0.0.1 test installation failed (${install.code}): ${install.stderr}`
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  const unexpectedUtilities = (await listDotNetInstallUtilities()).filter((item) => {
    return !baselineUtilityIds.has(Number(item.ProcessId));
  });
  if (unexpectedUtilities.length > 0) {
    throw new Error(
      `CDriveShiftAI installer left a .NET InstallUtil child behind: ${JSON.stringify(
        unexpectedUtilities
      )}`
    );
  }
  const beforeVersion = await fileVersion(installedExecutable);
  if (beforeVersion !== "0.0.1") {
    throw new Error(`Expected installed 0.0.1, received ${beforeVersion}`);
  }

  await mkdir(dataDirectory, { recursive: true });
  await writeFile(sentinel, "preserve-index-settings-migrations", "utf8");
  await copyFile(newInstaller, packagePath);
  await copyFile(helperSource, helperPath);
  const expectedSha512 = await sha512(packagePath);
  await writeFile(
    planPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        mode: "installed",
        parentPid: 0,
        packagePath,
        targetPath: installedExecutable,
        installedDir: installDirectory,
        stagingDir: staging,
        backupPath,
        successMarker,
        expectedVersion: currentVersion,
        expectedSha512,
        logPath
      },
      null,
      2
    ),
    "utf8"
  );

  const update = await run(helperPath, ["--plan", planPath]);
  if (update.code !== 0) {
    throw new Error(
      `Installed update helper failed (${update.code}): ${update.stderr}`
    );
  }
  const afterVersion = await fileVersion(installedExecutable);
  const sentinelValue = await readFile(sentinel, "utf8");
  if (
    afterVersion !== currentVersion ||
    sentinelValue !== "preserve-index-settings-migrations"
  ) {
    throw new Error(
      `Installed update lost its version or data: ${afterVersion}, ${sentinelValue}`
    );
  }
  if (
    (await exists(packagePath)) ||
    (await exists(backupPath)) ||
    (await exists(path.join(staging, "preserved-application-data")))
  ) {
    throw new Error("Installed update left package, backup or preserved data behind");
  }
  const postUpdateUtilities = (await listDotNetInstallUtilities()).filter((item) => {
    return !baselineUtilityIds.has(Number(item.ProcessId));
  });
  if (postUpdateUtilities.length > 0) {
    throw new Error(
      `Installed update left a .NET InstallUtil child behind: ${JSON.stringify(
        postUpdateUtilities
      )}`
    );
  }
  const targetStats = await stat(installedExecutable);
  completed = true;
  console.log(
    JSON.stringify(
      {
        result: "ok",
        mode: "installed",
        beforeVersion,
        afterVersion,
        silentInstallPathPreserved: true,
        applicationDataPreservedAcrossOldUninstaller: true,
        packageAndBackupDeletedAfterStart: true,
        unexpectedDotNetInstallUtilityProcesses: 0,
        targetBytes: targetStats.size
      },
      null,
      2
    )
  );
} finally {
  await cleanup();
  if (!completed) {
    console.error("Installed update smoke cleanup completed after a failure");
  }
}
