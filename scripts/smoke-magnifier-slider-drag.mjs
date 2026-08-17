import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

if (process.platform !== "win32") throw new Error("Windows is required");
const workspace = path.resolve(import.meta.dirname, "..");
const portable = process.argv.includes("--portable");
const waitForStartup = !process.argv.includes("--immediate");
const executable = portable
  ? path.join(workspace, "release-ready", "CDriveShiftAI-x64-portable.exe")
  : path.join(workspace, "release-ready", "win-unpacked", "CDriveShiftAI.exe");
const testData = path.join(workspace, ".cdriveshiftai-data", "test-temp", `magnifier-slider-drag-${process.pid}`);
const listenerId = `CDriveShiftAI.DragSmoke.${process.pid}`;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(selected));
  });
});
await access(executable);
await rm(testData, { recursive: true, force: true });
await mkdir(testData, { recursive: true });
await writeFile(path.join(testData, "cdriveshiftai-state.json"), JSON.stringify({ settings: { effectMode: "ivory", minimizeToTray: false, magnifierEnabled: true, magnifierModifiers: "Ctrl", magnifierWidth: 480, magnifierHeight: 300 } }));

const app = spawn(executable, [`--remote-debugging-port=${port}`, "--no-first-run"], {
  cwd: path.dirname(executable),
  env: { ...process.env, CDRIVESHIFTAI_DATA_DIR: testData, CDRIVESHIFTAI_INPUT_LISTENER_ID: listenerId },
  stdio: "ignore",
  windowsHide: false
});
let socket;
let nextId = 0;
let failure;
const rendererEvents = [];
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`CDP request timed out: ${method}`));
  }, 20_000);
  pending.set(id, {
    resolve: (value) => { clearTimeout(timer); resolve(value); },
    reject: (error) => { clearTimeout(timer); reject(error); }
  });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
const wheel = (holdMilliseconds = 0) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", String.raw`
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class I { [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }
'@
[I]::keybd_event(0x11,0,0,[UIntPtr]::Zero); [I]::mouse_event(0x800,0,0,120,[UIntPtr]::Zero); Start-Sleep -Milliseconds ${holdMilliseconds}; [I]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
`], { windowsHide: true, stdio: "ignore" });
const visibleLensWindows = () => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", String.raw`
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W { public delegate bool E(IntPtr h,IntPtr p); [StructLayout(LayoutKind.Sequential)] public struct R { public int Left,Top,Right,Bottom; } [DllImport("user32.dll")] public static extern bool EnumWindows(E e,IntPtr p); [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder s,int n); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out R r); [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h); }
'@
$result=@(); [W]::EnumWindows({param($h,$p) $s=New-Object Text.StringBuilder 256; [void][W]::GetClassName($h,$s,$s.Capacity); if($s.ToString() -eq '${listenerId}' -and [W]::IsWindowVisible($h)){ $r=New-Object W+R; if([W]::GetWindowRect($h,[ref]$r)){ $dpi=[W]::GetDpiForWindow($h); $rawWidth=$r.Right-$r.Left; $rawHeight=$r.Bottom-$r.Top; $script:result += @{rawWidth=$rawWidth;rawHeight=$rawHeight;scaledWidth=[Math]::Round($rawWidth*$dpi/96);scaledHeight=[Math]::Round($rawHeight*$dpi/96);dpi=$dpi} } }; return $true},[IntPtr]::Zero)|Out-Null; ConvertTo-Json @($result) -Compress
`], { encoding: "utf8", windowsHide: true }).trim());

try {
  let page;
  for (let attempt = 0; attempt < (portable ? 300 : 80); attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl && item.url !== "devtools://devtools/bundled/inspector.html");
      if (page) break;
    } catch {}
    await wait(100);
  }
  if (!page) throw new Error("Packaged page did not start");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (item) {
      pending.delete(message.id);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
      return;
    }
    if (["Runtime.exceptionThrown", "Runtime.consoleAPICalled", "Log.entryAdded"].includes(message.method)) {
      rendererEvents.push(message);
    }
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await evaluate(`(() => {
    window.__cshiftSmokeErrors = [];
    window.addEventListener('error', (event) => window.__cshiftSmokeErrors.push({ type: 'error', message: event.message, stack: event.error?.stack }));
    window.addEventListener('unhandledrejection', (event) => window.__cshiftSmokeErrors.push({ type: 'rejection', message: String(event.reason), stack: event.reason?.stack }));
    return true;
  })()`);
  await evaluate('window.cDriveShiftAI ? true : false');
  await send("Runtime.evaluate", { expression: 'window.cDriveShiftAI && window.cDriveShiftAI.updateSettings({ effectMode: "ivory" })', awaitPromise: true });
  await send("Runtime.evaluate", { expression: 'window.cDriveShiftAI.navigateApp({ view: "settings" })', awaitPromise: true });
  // Renderer navigation is event-driven; clicking the sidebar Settings button
  // is stable even if the app did not start with a view query parameter.
  await evaluate(`(() => { const buttons=[...document.querySelectorAll('button')]; const target=buttons.find((button)=>/设置|Settings/i.test(button.textContent||'')); if(target){target.click();return true} return false })()`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate('document.querySelectorAll(".settings-module-nav button").length >= 3')) break;
    await wait(100);
  }
  const moduleCount = await evaluate('document.querySelectorAll(".settings-module-nav button").length');
  if (moduleCount < 3) throw new Error(`Settings navigation did not load: ${moduleCount}`);
  await evaluate('document.querySelectorAll(".settings-module-nav button")[2].click()');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate('document.querySelector(".magnifier-size-setting input") !== null')) break;
    await wait(100);
  }
  const sliderReady = await evaluate('document.querySelector(".magnifier-size-setting input") !== null');
  if (!sliderReady) throw new Error("Magnifier slider did not load");
  if (portable && waitForStartup) {
    await wait(12_000);
    const idleState = await evaluate(`({ rootChildren: document.querySelector('#root')?.childElementCount ?? 0, errors: window.__cshiftSmokeErrors ?? [] })`);
    if (idleState.rootChildren < 1) throw new Error(`Renderer disappeared while idle: ${JSON.stringify(idleState)}`);
  }
  const point = await evaluate(`(() => { const r=document.querySelector('.magnifier-size-setting input').getBoundingClientRect(); return {x:r.left+r.width*.45,y:r.top+r.height/2}; })()`);
  let maximumDuringDrag = 0;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const offset = iteration % 2 === 0 ? 120 : -80;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    // This deliberately contains no modifier key and no wheel input. Moving a
    // size setting must be a pure UI operation and must never show the lens.
    await wait(15);
    maximumDuringDrag = Math.max(maximumDuringDrag, visibleLensWindows().length);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + offset, y: point.y, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + offset, y: point.y, button: "left", clickCount: 1 });
    await wait(35);
    const iterationState = await evaluate(`({ rootChildren: document.querySelector('#root')?.childElementCount ?? 0, errors: window.__cshiftSmokeErrors ?? [] })`);
    if (iterationState.rootChildren < 1) {
      throw new Error(`Renderer disappeared at drag iteration ${iteration + 1}: ${JSON.stringify(iterationState)}`);
    }
  }
  if (maximumDuringDrag !== 0) throw new Error(`Lens appeared while its size slider was being dragged: ${maximumDuringDrag}`);
  await wait(350);
  const pageState = await evaluate(`({
    rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
    bodyTextLength: document.body?.innerText?.length ?? 0,
    sliderCount: document.querySelectorAll('.magnifier-size-setting input').length,
    savedWidth: Number(document.querySelectorAll('.magnifier-size-setting input')[0]?.value ?? 0),
    savedHeight: Number(document.querySelectorAll('.magnifier-size-setting input')[1]?.value ?? 0),
    url: location.href,
    readyState: document.readyState,
    apiAvailable: Boolean(window.cDriveShiftAI),
    rootPresent: Boolean(document.querySelector('#root'))
  })`);
  const screenshot = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  if (pageState.rootChildren < 1 || pageState.bodyTextLength < 100 || pageState.sliderCount !== 2 || !screenshot.data) {
    const errors = await evaluate('window.__cshiftSmokeErrors ?? []').catch(() => []);
    throw new Error(`Renderer content disappeared after slider drag: ${JSON.stringify({ pageState, errors })}`);
  }
  let persistedSize;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    persistedSize = (await send("Runtime.evaluate", {
      expression: `window.cDriveShiftAI.getSettings().then((settings) => ({ width: settings.magnifierWidth, height: settings.magnifierHeight }))`,
      returnByValue: true,
      awaitPromise: true
    })).result?.value;
    if (persistedSize?.width === pageState.savedWidth && persistedSize?.height === pageState.savedHeight) break;
    await wait(100);
  }
  if (persistedSize?.width !== pageState.savedWidth || persistedSize?.height !== pageState.savedHeight) {
    throw new Error(`Slider value was not persisted: ${JSON.stringify({ pageState, persistedSize })}`);
  }
  // Only after the settings gesture is completely finished do we perform a
  // real shortcut gesture. The native lens must use the saved slider size.
  const wheelProcess = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type @'\nusing System; using System.Runtime.InteropServices; public static class I { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }\n'@\n[I]::keybd_event(0x11,0,0,[UIntPtr]::Zero); [I]::mouse_event(0x800,0,0,120,[UIntPtr]::Zero); Start-Sleep -Milliseconds 500; [I]::keybd_event(0x11,0,2,[UIntPtr]::Zero)`], { windowsHide: true, stdio: "ignore" });
  await wait(100);
  const lens = visibleLensWindows()[0] ?? {};
  await new Promise((resolve) => wheelProcess.once("exit", resolve));
  const lensMatches =
    (lens.rawWidth === pageState.savedWidth && lens.rawHeight === pageState.savedHeight) ||
    (lens.scaledWidth === pageState.savedWidth && lens.scaledHeight === pageState.savedHeight);
  if (!lensMatches) {
    throw new Error(`Lens did not use the saved slider size: ${JSON.stringify({ lens, pageState })}`);
  }
  console.log(JSON.stringify({ result: "ok", portable, iterations: 20, visibleLensesDuringDrag: maximumDuringDrag, pageState, persistedSize, lens, screenshotBytes: Buffer.from(screenshot.data, "base64").length }, null, 2));
} catch (error) {
  failure = error;
  if (portable) {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
    console.error(JSON.stringify({ portableFailure: String(error), port, testData, pages, rendererEvents }, null, 2));
  }
  throw error;
} finally {
  if (socket) {
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.close();
    await Promise.race([closed, wait(750)]);
  }
  if (app.exitCode === null) {
    const exited = new Promise((resolve) => app.once("exit", resolve));
    app.kill();
    await Promise.race([exited, wait(4000)]);
  }
  // A single-file portable launcher exits after starting its extracted main
  // process. Reap only descendants identifiable by this run's unique debug
  // port or unique user-data directory; never touch an interactive instance.
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", String.raw`
$portNeedle='--remote-debugging-port=${port}'
$dataNeedle='${testData.replaceAll("'", "''").replaceAll("\\", "\\")}'
$targets=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('CDriveShiftAI.exe','cshift-indexer.exe') -and ($_.CommandLine -like "*$portNeedle*" -or $_.CommandLine -like "*$dataNeedle*") })
if($targets.Count -gt 0){ Stop-Process -Id $targets.ProcessId -Force }
`], { windowsHide: true, stdio: "ignore" });
  await wait(500);
  if (!failure) {
    await rm(testData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}
