import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  version: "0.1.5",
  summary: "本版修复程序已运行时右键强制删除误报“绝对路径无效”的问题，并增加目录句柄占用检测，处理 PowerShell 进入目录后导致的删除失败。",
  sections: [
    {
      title: "右键删除路径传递",
      items: [
        "程序已运行或最小化到托盘时，资源管理器右键请求正确传递目标，不再因二次启动参数重排误报绝对路径无效。",
        "继续使用同一预检确认窗口和请求队列；已有菜单无需重新注册。"
      ]
    },
    {
      title: "目录占用检测",
      items: [
        "补充目录句柄检测，识别 PowerShell 等进程将待删除目录作为当前工作目录的占用，包括空目录。",
        "预检展示实际占用进程，用户确认后再次核对进程身份，再处理可结束的普通进程并重试删除。",
        "不会按进程名称批量结束 PowerShell；管理员权限仍无法解除所有驱动锁或系统限制。"
      ]
    },
    {
      title: "结果与回归验证",
      items: [
        "删除后核验目标确实不存在，失败时保留错误与操作指引；重新执行需要新的预检和确认。",
        "新增真实 Electron 二次启动及 PowerShell 当前目录占用测试，覆盖目标传递、空目录、进程身份和用户确认。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  version: "0.1.5",
  summary: "This release fixes invalid-path errors from Explorer when the app is already running and detects directory locks held by PowerShell and other processes.",
  sections: [
    {
      title: "Explorer path delivery",
      items: [
        "Keep the selected path intact when another instance or tray session receives an Explorer delete request.",
        "Use the existing preview, confirmation, and request queue; registered menus do not need to be recreated."
      ]
    },
    {
      title: "Directory lock detection",
      items: [
        "Detect directory handles, including empty folders used as the current directory by PowerShell.",
        "Show actual holders in the preview and recheck process identity after confirmation before handling them.",
        "Never stop PowerShell processes by name alone; elevation cannot remove every driver lock or system restriction."
      ]
    },
    {
      title: "Results and regression coverage",
      items: [
        "Verify that deletion completed, retain failure guidance, and require a fresh preview and consent for retries.",
        "Add real Electron relaunch and PowerShell directory-lock tests for paths, empty folders, identity, and consent."
      ]
    }
  ]
};
