import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  throw new Error("The native magnifier smoke test requires Windows");
}

const workspace = path.resolve(import.meta.dirname, "..");
const executable = path.join(workspace, "release-ready", "win-unpacked", "CDriveShiftAI.exe");
const testData = path.join(workspace, ".cdriveshiftai-data", "test-temp", "native-magnifier");
const listenerId = `CDriveShiftAI.SmokeLens.${process.pid}`;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

await access(executable);
await rm(testData, { recursive: true, force: true });
await mkdir(testData, { recursive: true });
await writeFile(
  path.join(testData, "cdriveshiftai-state.json"),
  JSON.stringify({
    settings: {
      effectMode: "ivory",
      minimizeToTray: false,
      magnifierEnabled: true,
      magnifierModifiers: "Alt",
      magnifierWidth: 1200,
      magnifierHeight: 900
    }
  }),
  "utf8"
);

const app = spawn(executable, ["--no-first-run"], {
  cwd: path.dirname(executable),
  env: {
    ...process.env,
    CDRIVESHIFTAI_DATA_DIR: testData,
    CDRIVESHIFTAI_INPUT_LISTENER_ID: listenerId
  },
  stdio: "ignore",
  windowsHide: false
});

const probeScript = String.raw`
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CShiftLensProbe {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static object[] VisibleLenses() {
    var rows = new List<object>();
    EnumWindows((hwnd, _) => {
      var name = new System.Text.StringBuilder(128);
      GetClassName(hwnd, name, name.Capacity);
      if (name.ToString() == "${listenerId}" && IsWindowVisible(hwnd)) {
        RECT rect; GetWindowRect(hwnd, out rect);
        var colors = new HashSet<uint>();
        // Sample the composited lens surface and reject flat or incomplete
        // frames while magnification is being updated.
        var dc = GetDC(IntPtr.Zero);
        if (dc != IntPtr.Zero) {
          for (var row = 1; row <= 7; row++) {
            for (var column = 1; column <= 9; column++) {
              var x = rect.Left + ((rect.Right - rect.Left) * column / 10);
              var y = rect.Top + ((rect.Bottom - rect.Top) * row / 8);
              colors.Add(GetPixel(dc, x, y));
            }
          }
          ReleaseDC(IntPtr.Zero, dc);
        }
        rows.Add(new { handle=hwnd.ToInt64(), left=rect.Left, top=rect.Top, width=rect.Right-rect.Left, height=rect.Bottom-rect.Top, uniqueColors=colors.Count });
      }
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
'@
[CShiftLensProbe]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[CShiftLensProbe]::SetCursorPos(900, 650) | Out-Null
[CShiftLensProbe]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[CShiftLensProbe]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
$visible = @([CShiftLensProbe]::VisibleLenses())
$animationHandles = New-Object System.Collections.Generic.List[long]
$animationMissingFrames = 0
$animationFlatFrames = 0
$minimumUniqueColors = 2147483647
for ($frame = 0; $frame -lt 32; $frame++) {
  if ($frame -eq 4 -or $frame -eq 12 -or $frame -eq 20) {
    [CShiftLensProbe]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero)
  }
  $frameLenses = @([CShiftLensProbe]::VisibleLenses())
  if ($frameLenses.Count -ne 1) {
    $animationMissingFrames++
  } else {
    $animationHandles.Add([long]$frameLenses[0].handle)
    $minimumUniqueColors = [Math]::Min($minimumUniqueColors, [int]$frameLenses[0].uniqueColors)
    if ([int]$frameLenses[0].uniqueColors -le 2) {
      $animationFlatFrames++
    }
  }
  Start-Sleep -Milliseconds 8
}
[CShiftLensProbe]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 160
$afterRelease = @([CShiftLensProbe]::VisibleLenses())
[pscustomobject]@{
  visible=$visible
  animationHandles=@($animationHandles)
  animationMissingFrames=$animationMissingFrames
  animationFlatFrames=$animationFlatFrames
  minimumUniqueColors=$minimumUniqueColors
  afterRelease=$afterRelease
} | ConvertTo-Json -Depth 4 -Compress
`;

try {
  let probe;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(250);
    try {
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", probeScript],
        { encoding: "utf8", windowsHide: true }
      ).trim();
      probe = JSON.parse(output);
      if (probe.visible.length > 0) break;
    } catch {
      // The native listener is still starting.
    }
  }
  if (!probe || probe.visible.length !== 1) {
    throw new Error(`Expected one visible isolated lens: ${JSON.stringify(probe)}`);
  }
  const lens = probe.visible[0];
  if (lens.width !== 1200 || lens.height !== 900) {
    throw new Error(`DPI virtualized the lens dimensions: ${JSON.stringify(lens)}`);
  }
  if (probe.animationMissingFrames !== 0) {
    throw new Error(`Lens disappeared during wheel animation: ${JSON.stringify(probe)}`);
  }
  if (probe.animationFlatFrames !== 0) {
    throw new Error(`Lens displayed a flat/blank frame during wheel animation: ${JSON.stringify(probe)}`);
  }
  const animationHandles = new Set(probe.animationHandles.map(String));
  if (animationHandles.size !== 1 || !animationHandles.has(String(lens.handle))) {
    throw new Error(`Lens window was recreated during animation: ${JSON.stringify(probe)}`);
  }
  if (probe.afterRelease.length !== 0) {
    throw new Error(`Lens remained visible after modifier release: ${JSON.stringify(probe)}`);
  }
  console.log(JSON.stringify({
    result: "ok",
    lens,
    continuousAnimationSamples: probe.animationHandles.length,
    minimumUniqueColors: probe.minimumUniqueColors,
    hiddenAfterRelease: true
  }, null, 2));
} finally {
  const exited = new Promise((resolve) => app.once("exit", resolve));
  app.kill();
  if (app.exitCode === null) await Promise.race([exited, wait(2_000)]);
  await rm(testData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
