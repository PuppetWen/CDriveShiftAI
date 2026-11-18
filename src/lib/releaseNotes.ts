import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  "version": "0.2.3",
  "summary": "降低空闲资源占用和窗口缩放开销，改善搜索响应，并修复下载后的静默安装与新版重启。",
  "sections": [
    {
      "title": "窗口与搜索性能",
      "items": [
        "停止空闲时循环重绘背景，窗口缩放时简化玻璃效果，拖动结束后再保存窗口大小。",
        "托盘模式释放搜索结果缓存；优先使用已有索引，完整刷新延后到窗口可见时执行。",
        "频繁写入的文件就地更新索引，避免累积重复记录，同时保留全文更新。"
      ]
    },
    {
      "title": "自动更新",
      "items": [
        "更新助手接手后才退出旧版，支持含空格的安装目录，并复用已校验的下载包。",
        "静默安装后自动打开新版，核对启动回执后再提交更新和清理备份。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  "version": "0.2.3",
  "summary": "Reduce idle and resize overhead, keep search responsive, and fix automatic installation and restart after a download.",
  "sections": [
    {
      "title": "Window and search performance",
      "items": [
        "Stop repainting the idle background, simplify glass effects while resizing and save window bounds after the drag.",
        "Release search result caches in the tray and use the existing index before refreshing it while the window is visible.",
        "Update frequently modified files in place in the name index while retaining full-text updates."
      ]
    },
    {
      "title": "Automatic updates",
      "items": [
        "Wait for the updater to accept the handoff, handle installation paths with spaces and reuse verified downloads.",
        "Launch the new version after silent installation and verify startup before committing the update and clearing the backup."
      ]
    }
  ]
};
