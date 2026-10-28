import type { EventEmitter } from "node:events";

type WindowEvents = Pick<EventEmitter, "on" | "removeListener">;

export interface UpdateStartupWindow extends WindowEvents {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  webContents: WindowEvents & {
    isDestroyed(): boolean;
    isLoadingMainFrame(): boolean;
    getURL(): string;
  };
}

export function isVisibleUpdateWindow(window: UpdateStartupWindow): boolean {
  return !window.isDestroyed() && !window.webContents.isDestroyed() &&
    window.isVisible() && !window.isMinimized() &&
    !window.webContents.isLoadingMainFrame() &&
    window.webContents.getURL() !== "" && window.webContents.getURL() !== "about:blank";
}

// Register before loadURL: a freshly created webContents can report "not
// loading" while still showing its initial blank page. Only did-finish-load
// for the application page, together with a visible window, acknowledges it.
export function waitForVisibleUpdateWindow(
  window: UpdateStartupWindow,
  timeoutMs = 75_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let loaded = false;
    let settled = false;
    const contents = window.webContents;
    const cleanup = () => {
      clearTimeout(timer);
      contents.removeListener("did-start-loading", started);
      contents.removeListener("did-finish-load", finished);
      contents.removeListener("did-fail-load", failed);
      contents.removeListener("render-process-gone", rendererGone);
      contents.removeListener("destroyed", rendererGone);
      window.removeListener("show", check);
      window.removeListener("restore", check);
      window.removeListener("close", closed);
      window.removeListener("closed", closed);
      window.removeListener("hide", hidden);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (loaded && isVisibleUpdateWindow(window)) settle();
    };
    const started = () => { loaded = false; };
    const finished = () => {
      loaded = contents.getURL() !== "" && contents.getURL() !== "about:blank";
      check();
    };
    const failed = (_event: unknown, code: number, description: string, _url: string, mainFrame: boolean) => {
      if (mainFrame !== false) settle(new Error(`Updated window failed to load (${code}): ${description}`));
    };
    const rendererGone = () => settle(new Error("Updated renderer exited before startup acknowledgement"));
    const closed = () => settle(new Error("Updated window closed before startup acknowledgement"));
    const hidden = () => settle(new Error("Updated window was hidden before startup acknowledgement"));
    const timer = setTimeout(() => settle(new Error("Updated window did not become visible and finish loading")), timeoutMs);
    timer.unref();
    contents.on("did-start-loading", started);
    contents.on("did-finish-load", finished);
    contents.on("did-fail-load", failed);
    contents.on("render-process-gone", rendererGone);
    contents.on("destroyed", rendererGone);
    window.on("show", check);
    window.on("restore", check);
    window.on("close", closed);
    window.on("closed", closed);
    window.on("hide", hidden);
    if (window.isDestroyed() || contents.isDestroyed()) rendererGone();
  });
}
