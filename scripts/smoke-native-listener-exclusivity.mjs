import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") throw new Error("Windows is required");
const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(workspace, "native", "indexer", "target", "release", "cshift-indexer.exe");
const listenerId = `CDriveShiftAI.ExclusiveSmoke.${process.pid}`;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
await access(executable);

const children = [];
const statuses = [];
const launch = () => {
  const child = spawn(executable, ["--serve"], {
    env: { ...process.env, CDRIVESHIFTAI_INPUT_LISTENER_ID: listenerId },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true
  });
  children.push(child);
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.event === "magnifierStatus") statuses.push(event);
      } catch {
        // Ignore partial/non-protocol output; the timeout reports missing status.
      }
    }
  });
  return child;
};

try {
  launch();
  for (let attempt = 0; attempt < 40 && statuses.length < 1; attempt += 1) await wait(100);
  launch();
  for (let attempt = 0; attempt < 40 && statuses.length < 2; attempt += 1) await wait(100);
  const owners = statuses.filter((status) => status.available === true);
  const conflicts = statuses.filter((status) => status.conflict === true);
  if (owners.length !== 1 || conflicts.length !== 1) {
    throw new Error(`Expected one owner and one conflict: ${JSON.stringify(statuses)}`);
  }
  console.log(JSON.stringify({ result: "ok", owners: owners.length, conflicts: conflicts.length }, null, 2));
} finally {
  for (const child of children) {
    if (child.exitCode == null) child.kill();
  }
}
