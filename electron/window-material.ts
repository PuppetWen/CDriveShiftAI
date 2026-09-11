import { nativeTheme, type BrowserWindow } from "electron";
import os from "node:os";
import { logger, serializeError } from "./logger";

type WindowMaterial = "acrylic" | "none";

const windowMaterials = new WeakMap<BrowserWindow, WindowMaterial>();
const failedWindows = new WeakSet<BrowserWindow>();

function supportsSystemBackdrop(): boolean {
  if (process.platform !== "win32") return false;
  const [major, , build] = os.release().split(".").map(Number);
  // Electron's DWM backdrop API starts with Windows 11 22H2.
  return major > 10 || (major === 10 && build >= 22621);
}

export function getWindowMaterial(window: BrowserWindow): WindowMaterial {
  return windowMaterials.get(window) ?? "none";
}

export function applyWindowMaterial(window: BrowserWindow, fallbackColor: string): void {
  if (window.isDestroyed()) return;
  const supported = supportsSystemBackdrop();
  let material: WindowMaterial = supported &&
    !nativeTheme.shouldUseHighContrastColors &&
    !nativeTheme.prefersReducedTransparency &&
    !failedWindows.has(window)
    ? "acrylic"
    : "none";
  const previous = windowMaterials.get(window);

  try {
    if (supported && material !== previous) window.setBackgroundMaterial(material);
    // Clear only the paint surface: BrowserWindow opacity and native resize /
    // maximize behavior stay intact, while DWM supplies the blurred desktop.
    window.setBackgroundColor(material === "acrylic" ? "#00000000" : fallbackColor);
  } catch (error) {
    material = "none";
    failedWindows.add(window);
    logger.warn("window.material_unavailable", { error: serializeError(error) });
    // A compositor / remote-session failure must leave a readable window.
    window.setBackgroundColor(fallbackColor);
    try {
      if (supported) window.setBackgroundMaterial("none");
    } catch {
      // The opaque fallback also works when DWM backdrop calls are unavailable.
    }
  }

  windowMaterials.set(window, material);
  if (material !== previous) window.webContents.send("window:background-material", material);
}
