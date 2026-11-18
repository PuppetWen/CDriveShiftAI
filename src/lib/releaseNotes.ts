import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  "version": "0.2.5",
  "summary": "新增 Windows 原生极速搜索窗口，降低大索引搜索时的内存占用。",
  "sections": [
    {
      "title": "独立极速搜索",
      "items": [
        "简体中文环境的托盘菜单和搜索快捷键打开 Windows 原生窗口，两套界面共用一个索引进程和搜索书签。",
        "支持名称和正文搜索、多条件筛选及排序，可以携带当前筛选切换到完整搜索界面。"
      ]
    },
    {
      "title": "索引占用与刷新",
      "items": [
        "使用内存映射的紧凑路径表，复用相同目录前缀，减少索引常驻分配、查询解码和重启开销。",
        "每日刷新可复用经过 NTFS 日志验证的未变更卷。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  "version": "0.2.5",
  "summary": "Add a native Windows quick search window and reduce memory use with large indexes.",
  "sections": [
    {
      "title": "Native quick search",
      "items": [
        "In Simplified Chinese, the tray menu and quick search shortcut open a native Windows window that shares the index process and saved searches with the main window.",
        "Search file names or contents with filters and sorting, and carry the current search into the full interface."
      ]
    },
    {
      "title": "Index memory and refresh",
      "items": [
        "Memory-map compact path tables with shared directory prefixes to reduce private allocations, query decoding, and restart time.",
        "Daily refreshes can reuse indexes for unchanged volumes when the NTFS journal confirms they are current."
      ]
    }
  ]
};
