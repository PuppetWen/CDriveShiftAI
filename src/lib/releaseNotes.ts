import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  "version": "0.2.7",
  "summary": "恢复与主界面一致的极速搜索窗口，修复连续搜索时的取消请求误报。",
  "sections": [
    {
      "title": "极速搜索窗口",
      "items": [
        "快捷键和托盘菜单打开与主界面一致的主题搜索窗口，支持筛选、书签和文件操作。",
        "重复按快捷键可以恢复已最小化的极速窗口，并聚焦搜索输入框。"
      ]
    },
    {
      "title": "连续搜索",
      "items": [
        "旧查询和文件夹统计被新输入取代时静默取消，避免出现搜索失败提示。",
        "取消后的文件夹大小统计会继续处理当前结果，保存前再次检查请求状态。"
      ]
    },
    {
      "title": "磁盘搜索",
      "items": [
        "检测可读盘符和 U 盘的插入、移除，更新两套界面的搜索位置及共享索引。",
        "更换同一盘符的介质后重新建立索引，完成后自动重查当前关键词和筛选。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  "version": "0.2.7",
  "summary": "Restore the themed quick search window and handle superseded search requests quietly.",
  "sections": [
    {
      "title": "Quick search window",
      "items": [
        "The shortcut and tray menu open a quick search window using the main interface's theme, filters, bookmarks, and file actions.",
        "Pressing the shortcut again restores a minimized window and focuses the search input."
      ]
    },
    {
      "title": "Continuous search",
      "items": [
        "Handle queries and folder-size tasks superseded by new input quietly, avoiding false search errors.",
        "Resume folder-size work for the current results after cancellation and check request state before caching it."
      ]
    },
    {
      "title": "Drive search",
      "items": [
        "Detect readable drives and inserted or removed USB volumes, updating search locations and the shared index.",
        "Rebuild the index when media using the same drive letter is replaced, then rerun the current search and filters."
      ]
    }
  ]
};
