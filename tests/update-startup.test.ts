import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { isVisibleUpdateWindow, waitForVisibleUpdateWindow } from "../electron/update-startup";

class Contents extends EventEmitter {
  destroyed = false;
  loading = false;
  url = "";
  isDestroyed() { return this.destroyed; }
  isLoadingMainFrame() { return this.loading; }
  getURL() { return this.url; }
  finish() {
    this.loading = false;
    this.url = "file:///E:/app/dist/index.html";
    this.emit("did-finish-load");
  }
}

class Window extends EventEmitter {
  webContents = new Contents();
  destroyed = false;
  visible = false;
  minimized = false;
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  show() { this.visible = true; this.emit("show"); }
}

describe("updated main-window acknowledgement", () => {
  it("does not confuse initial not-loading/blank state with a loaded application", async () => {
    const window = new Window();
    let acknowledged = false;
    const pending = waitForVisibleUpdateWindow(window).then(() => { acknowledged = true; });
    window.show();
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    window.webContents.url = "about:blank";
    window.webContents.emit("did-finish-load");
    window.webContents.url = "file:///E:/app/dist/index.html";
    window.emit("show");
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    window.webContents.finish();
    await pending;
    expect(acknowledged).toBe(true);
    expect(window.eventNames()).toEqual([]);
    expect(window.webContents.eventNames()).toEqual([]);
  });

  it("waits for visibility after loading and does not acknowledge a minimized window", async () => {
    const window = new Window();
    let acknowledged = false;
    const pending = waitForVisibleUpdateWindow(window).then(() => { acknowledged = true; });
    window.webContents.finish();
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    window.minimized = true;
    window.show();
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    window.minimized = false;
    window.emit("restore");
    await pending;
    expect(isVisibleUpdateWindow(window)).toBe(true);
  });

  it("requires a new finish event if navigation restarts before showing", async () => {
    const window = new Window();
    let acknowledged = false;
    const pending = waitForVisibleUpdateWindow(window).then(() => { acknowledged = true; });
    window.webContents.finish();
    window.webContents.emit("did-start-loading");
    window.show();
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    window.webContents.finish();
    await pending;
  });

  it("rejects a failed main-frame load even if a later event reports completion", async () => {
    const window = new Window();
    const pending = waitForVisibleUpdateWindow(window);
    const rejected = expect(pending).rejects.toThrow("failed to load");
    window.webContents.emit("did-fail-load", {}, -6, "FILE_NOT_FOUND", "file:///missing", true);
    window.show();
    window.webContents.finish();
    await rejected;
    expect(window.webContents.eventNames()).toEqual([]);
  });

  it("does not mistake a subframe failure for a failed application load", async () => {
    const window = new Window();
    const pending = waitForVisibleUpdateWindow(window);
    window.webContents.emit("did-fail-load", {}, -6, "FILE_NOT_FOUND", "file:///subframe", false);
    window.show();
    window.webContents.finish();
    await pending;
  });

  it("rejects closing, hiding or losing the renderer before acknowledgement", async () => {
    for (const event of ["close", "closed", "hide", "render-process-gone", "destroyed"]) {
      const window = new Window();
      const pending = waitForVisibleUpdateWindow(window);
      const rejected = expect(pending).rejects.toThrow(/before startup acknowledgement/);
      if (event === "render-process-gone" || event === "destroyed") window.webContents.emit(event);
      else window.emit(event);
      window.show();
      window.webContents.finish();
      await rejected;
      expect(window.eventNames()).toEqual([]);
      expect(window.webContents.eventNames()).toEqual([]);
    }
  });

  it("bounds waiting and removes every listener when no visible loaded window appears", async () => {
    const window = new Window();
    await expect(waitForVisibleUpdateWindow(window, 10)).rejects.toThrow("did not become visible");
    expect(window.eventNames()).toEqual([]);
    expect(window.webContents.eventNames()).toEqual([]);
  });
});
