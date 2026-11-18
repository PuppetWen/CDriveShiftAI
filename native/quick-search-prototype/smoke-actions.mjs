import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

assert.equal(process.platform, "win32");
const project = import.meta.dirname;
const scratch = path.resolve(project, "../../.task-tmp");
await mkdir(scratch, { recursive: true });
const temp = await mkdtemp(path.join(scratch, "native-search-actions-"));
const env = { ...process.env, TEMP: temp, TMP: temp };
const candidate = path.join(temp, "report.txt");
const bookmark = {
  id: "example", name: "Recovered report", query: "report", mode: "name", contentScope: "*", datePreset: "custom",
  filters: {
    scope: temp, scopes: [temp], kind: "file", categories: ["document", "code"], extensions: ["txt"],
    keywords: ["annual"], keywordMatch: "any", sortBy: "name", sortDirection: "desc",
    minSize: 5, modifiedAfter: "2025-01-02T07:30:04.123Z"
  }
};
const driver = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SearchActions {
  private delegate bool VisitWindow(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32")] private static extern bool EnumWindows(VisitWindow callback, IntPtr parameter);
  [DllImport("user32", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);
  [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr wnd, out uint pid);
  [DllImport("user32")] public static extern IntPtr GetDlgItem(IntPtr wnd, int id);
  [DllImport("user32")] public static extern bool PostMessage(IntPtr wnd, uint msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct GuiInfo {
    public uint size, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public int left, top, right, bottom;
  }
  [DllImport("user32")] public static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo state);
  [DllImport("user32", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  public static extern IntPtr Send(IntPtr wnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  public static IntPtr FindSearch(uint owner) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((wnd, ignored) => {
      uint pid;
      GetWindowThreadProcessId(wnd, out pid);
      if (pid != owner) return true;
      var name = new StringBuilder(100);
      GetClassName(wnd, name, name.Capacity);
      if (name.ToString() != "CShiftQuickSearchPrototype") return true;
      found = wnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
function Choose-Menu([int]$steps) {
  $info = New-Object SearchActions+GuiInfo
  $info.size = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $unused = [uint32]0
  $thread = [SearchActions]::GetWindowThreadProcessId($window, [ref]$unused)
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if ([SearchActions]::GetGUIThreadInfo($thread, [ref]$info) -and ($info.flags -band 4) -and $info.menuOwner -eq $window) {
      for ($step = 0; $step -lt $steps; $step++) {
        if (![SearchActions]::PostMessage($window, 256, 40, 1)) { throw 'Could not navigate menu' }
      }
      if (![SearchActions]::PostMessage($window, 256, 13, 1)) { throw 'Could not choose menu item' }
      return
    }
    Start-Sleep -Milliseconds 45
  }
  throw "The native menu did not open (flags $($info.flags), owner $($info.menuOwner))"
}
$window = [SearchActions]::FindSearch([uint32]$env:CSHIFT_ACTION_PID)
if ($window -eq 0) { throw 'Did not find the fixture window' }
$list = [SearchActions]::GetDlgItem($window, 111)
function Require-Result {
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    $result = [IntPtr]::Zero
    if ([SearchActions]::Send($list, 4100, 0, 0, 2, 150, [ref]$result) -ne 0 -and [int]$result -eq 1) { return }
    Start-Sleep -Milliseconds 45
  }
  throw 'Bookmarked result was not shown'
}
function Command([int]$id) {
  if (![SearchActions]::PostMessage($window, 273, $id, 0)) { throw "Could not send command $id" }
}
switch ($env:CSHIFT_DRIVE_ACTION) {
  'apply' {
    Command 123
    Choose-Menu 2
    Require-Result
  }
  'save' {
    Command 123
    Choose-Menu 1
  }
  'file' {
    # Home selects the first result in the list without moving the desktop pointer.
    [void][SearchActions]::PostMessage($list, 256, 36, 1)
    Command 124
    Choose-Menu 3
  }
  'full' { Command 125 }
}
`;

let child;
let exited;
let errors = "";
const messages = [];
function send(value) {
  child.stdin.write(JSON.stringify(value) + "\n");
}
async function received(predicate) {
  const until = Date.now() + 8_000;
  while (Date.now() < until && child.exitCode === null) {
    const message = messages.find(predicate);
    if (message) return message;
    await sleep(30);
  }
  assert.fail(`Missing hosted message: ${JSON.stringify(messages)}\n${errors}`);
}

try {
  const script = path.join(temp, "drive.ps1");
  await writeFile(script, "\uFEFF" + driver);
  child = spawn(path.join(project, "target/release/cshift-quick-search-prototype.exe"), ["--hosted"], {
    cwd: temp, env, stdio: ["pipe", "pipe", "pipe"]
  });
  exited = once(child, "exit");
  child.stdin.on("error", (error) => { errors += error.message; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (!message.id) return;
    const replies = {
      bookmarksList: { bookmarks: [bookmark] },
      bookmarkFoldersList: { folders: [] },
      bookmarkSave: { bookmark: { ...bookmark, ...message.value } },
      fileAction: {},
      openFullSearch: {},
      query: { results: [{ path: candidate, name: "report.txt", size: 5, score: 1, isDirectory: false }],
        generation: 1, hasMore: false, totalMatches: 1 }
    };
    send(message.op in replies
      ? { ...replies[message.op], id: message.id, ok: true }
      : { id: message.id, ok: false, error: "Unknown operation in smoke host" });
  });
  await received((message) => message.event === "visibility" && message.visible);
  async function drive(action) {
    const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    try {
      await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-File", script], {
        env: { ...env, CSHIFT_ACTION_PID: String(child.pid), CSHIFT_DRIVE_ACTION: action },
        windowsHide: true, timeout: 12_000
      });
    } catch (error) {
      throw new Error(`${error.message}\nHosted messages: ${JSON.stringify(messages)}\n${errors}`);
    }
  }
  await drive("apply");
  const query = await received((message) => message.op === "query");
  assert.equal(query.query, "annual report");
  assert.deepEqual(query.keywords, ["annual", "report"]);
  assert.deepEqual(query.scopes, [temp]);
  assert.deepEqual(query.categories, ["document", "code"]);
  assert.equal(query.kind, "file");
  assert.equal(query.sortBy, "name");
  assert.equal(query.sortDirection, "desc");
  assert.equal(query.minSize, 5);
  assert.equal(query.modifiedAfterMs, Date.parse(bookmark.filters.modifiedAfter));
  await drive("save");
  const saved = await received((message) => message.op === "bookmarkSave");
  assert.deepEqual(saved.value.filters.keywords, query.keywords);
  assert.equal(saved.value.filters.modifiedAfter, bookmark.filters.modifiedAfter);
  await drive("file");
  const file = await received((message) => message.op === "fileAction");
  assert.equal(file.action, "copyPath");
  assert.equal(file.path, candidate);
  await drive("full");
  const full = await received((message) => message.op === "openFullSearch");
  assert.deepEqual(full.value.filters, saved.value.filters);
  send({ command: "shutdown" });
  assert.deepEqual(await Promise.race([exited, sleep(5000, [], { ref: false })]), [0, null]);
  console.log(JSON.stringify({ result: "ok", restoredBookmark: true, savedBookmark: true,
    copyPathDelegated: true, fullSearchState: true }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await exited.catch(() => {});
  }
  assert(temp.startsWith(scratch + path.sep));
  await rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}
