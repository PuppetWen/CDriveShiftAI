import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  "version": "0.2.2",
  "summary": "修复自动更新成功回执的窗口事件时序，并完整退出更新失败的进程树后恢复旧版。",
  "sections": [
    {
      "title": "自动更新与失败恢复",
      "items": [
        "修复窗口已打开却未确认成功的问题，等待主页面完成加载与显示，补齐停止加载事件。",
        "更新助手释放数据目录占用，安装器与新版程序使用明确的工作目录和临时目录。",
        "新版启动使用独立进程作业；失败时关闭本次启动的全部后代进程，等待文件释放后恢复备份。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  "version": "0.2.2",
  "summary": "Fix automatic update startup acknowledgement timing and stop the failed application process tree before restoring the previous version.",
  "sections": [
    {
      "title": "Automatic updates and recovery",
      "items": [
        "Handle the final loading event so an opened, fully loaded window correctly acknowledges successful startup.",
        "Release inherited data-directory locks and set explicit working and temporary directories for installation and restart.",
        "Track the newly launched application in its own process job and wait for its descendants to exit before restoring a failed update."
      ]
    }
  ]
};
