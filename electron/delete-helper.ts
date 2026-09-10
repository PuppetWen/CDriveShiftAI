import path from "node:path";

interface DeleteHelperShell {
  openPath(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
}

// The renderer chooses a named destination; it cannot provide a command, path or URL.
export async function openDeleteHelper(
  target: unknown,
  systemShell: DeleteHelperShell,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (target !== "task-manager" && target !== "installed-apps") {
    throw new Error("不支持的删除辅助操作");
  }
  if (platform !== "win32") {
    throw new Error("删除辅助操作仅支持 Windows 桌面版");
  }

  const name = target === "task-manager" ? "任务管理器" : "已安装的应用";
  const manualSteps = target === "task-manager"
    ? "请按 Ctrl + Shift + Esc 手动打开任务管理器"
    : "请按 Win + I 打开设置，进入“应用”→“已安装的应用”（Windows 10 为“应用和功能”）";
  try {
    if (target === "task-manager") {
      const executable = path.win32.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "Taskmgr.exe"
      );
      const error = await systemShell.openPath(executable);
      if (error) throw new Error(error);
    } else {
      await systemShell.openExternal("ms-settings:appsfeatures");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法打开${name}：${detail}。${manualSteps}。`);
  }
}
