import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { ForceDeleteService } = require(path.join(workspace, "dist-electron", "force-delete.js"));
const testRoot = path.join(workspace, ".cdriveshiftai-data", "test-temp");
await mkdir(testRoot, { recursive: true });
const fixture = await mkdtemp(path.join(testRoot, "force-delete-"));
const target = path.join(fixture, "occupied-target");
await mkdir(target);
const commandFile = path.join(target, "hold-open.cmd");
await writeFile(commandFile, "@echo off\r\nping -t 127.0.0.1 >nul\r\n", "utf8");

const child = spawn("cmd.exe", ["/d", "/c", commandFile], {
  windowsHide: true,
  detached: false,
  stdio: "ignore"
});

try {
  await new Promise((resolve) => setTimeout(resolve, 900));
  const service = new ForceDeleteService({
    applicationExecutable: process.execPath,
    applicationDataRoot: path.join(workspace, ".cdriveshiftai-data"),
    createVerificationId: () => "force-delete-smoke-verification"
  });
  const preview = await service.preview(target);
  const related = preview.processes.find((item) => item.pid === child.pid);
  if (!related || !related.canTerminate) {
    throw new Error(`Force-delete preview did not find the occupied fixture process: ${JSON.stringify(preview.processes)}`);
  }
  const result = await service.execute(preview.verificationId);
  if (!result.deleted || !result.terminatedProcesses.some((item) => item.pid === child.pid)) {
    throw new Error(`Force-delete execution did not terminate the related process: ${JSON.stringify(result)}`);
  }
  try {
    await access(target);
    throw new Error("Force-delete execution left the target directory on disk");
  } catch (error) {
    if (error instanceof Error && error.message.includes("left the target")) throw error;
  }
  process.stdout.write(`${JSON.stringify({
    result: "ok",
    relatedProcesses: preview.processes.length,
    terminatedProcesses: result.terminatedProcesses.length,
    targetRemoved: true
  }, null, 2)}\n`);
} finally {
  try {
    child.kill("SIGKILL");
  } catch {
    // The expected path already stopped the process tree.
  }
  await rm(fixture, { recursive: true, force: true });
}
