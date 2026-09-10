import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDeleteHelper } from "../electron/delete-helper";

function fakeShell() {
  return {
    openPath: vi.fn(async (_path: string) => ""),
    openExternal: vi.fn(async (_url: string) => undefined)
  };
}

describe("delete helper destinations", () => {
  it.each([
    "cmd.exe", "ms-settings:privacy", "task-manager & shutdown /r", "Task-Manager", "",
    undefined, null, { target: "task-manager" }, ["task-manager"]
  ])("rejects unrecognized renderer input %j without opening anything", async (target) => {
    const shell = fakeShell();
    await expect(openDeleteHelper(target, shell, "win32")).rejects.toThrow("不支持的删除辅助操作");
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("opens only the system Task Manager executable", async () => {
    const shell = fakeShell();
    await openDeleteHelper("task-manager", shell, "win32");
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(
      path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "Taskmgr.exe")
    );
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("opens only the installed apps settings page", async () => {
    const shell = fakeShell();
    await openDeleteHelper("installed-apps", shell, "win32");
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("ms-settings:appsfeatures");
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("reports an openPath failure with a manual Task Manager shortcut", async () => {
    const shell = fakeShell();
    shell.openPath.mockResolvedValue("Access denied");
    await expect(openDeleteHelper("task-manager", shell, "win32"))
      .rejects.toThrow("无法打开任务管理器：Access denied。请按 Ctrl + Shift + Esc");
  });

  it("handles rejected launches with manual settings instructions", async () => {
    const shell = fakeShell();
    shell.openExternal.mockRejectedValue(new Error("No protocol handler"));
    await expect(openDeleteHelper("installed-apps", shell, "win32"))
      .rejects.toThrow("无法打开已安装的应用：No protocol handler。请按 Win + I");
  });

  it("rejects Windows tools on other platforms without launching anything", async () => {
    const shell = fakeShell();
    await expect(openDeleteHelper("task-manager", shell, "linux"))
      .rejects.toThrow("仅支持 Windows");
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
