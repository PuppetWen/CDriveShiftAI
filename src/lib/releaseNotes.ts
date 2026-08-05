import type { AppUpdateReleaseSection } from "../types";

export const bundledReleaseNotes: {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
} = {
  version: "0.0.7",
  summary: "本版补齐多语言界面、搜索结果路径提示和受控强制删除，并优化侧边栏与筛选布局。",
  sections: [
    {
      title: "搜索与文件操作",
      items: [
        "长路径悬浮提示会显示完整内容、自动换行，并始终限制在当前窗口内。",
        "右键菜单新增受控强制删除：先识别并关闭占用进程，再删除文件或目录，并提供失败明细。",
        "目录名称搜索、实时新增与删除、分页加载、完整排序和内容搜索范围清理均完成回归。"
      ]
    },
    {
      title: "语言与界面",
      items: [
        "设置新增不少于十种主流语言，主导航、搜索、设置、迁移、归属地图和运行状态会同步切换。",
        "侧边栏支持平滑拖动调整宽度和折叠，图标、标题、更新记录与筛选控件重新校准对齐。",
        "五套主题统一覆盖新语言选择器、完整路径提示与强制删除确认窗口。"
      ]
    },
    {
      title: "性能与稳定性",
      items: [
        "616 万级持久化索引继续使用原生分页查询，前台搜索保持亚秒响应。",
        "托盘静默时销毁渲染器并暂停后台全量工作，只保留索引监听、快捷键和托盘能力。",
        "缓存重启、增量重放、动态新增删除、干净退出和强制删除占用进程均加入自动化验证。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: typeof bundledReleaseNotes = {
  version: "0.0.7",
  summary:
    "This release completes multilingual UI coverage, full-path tooltips, controlled force deletion, and layout refinements.",
  sections: [
    {
      title: "Search and file actions",
      items: [
        "Long-path tooltips now expose the complete path, wrap naturally, and remain inside the current window.",
        "The result context menu adds controlled force deletion that identifies and closes locking processes before removal.",
        "Directory name search, live creates and deletes, paging, full-result sorting, and content-scope clearing are covered by regression tests."
      ]
    },
    {
      title: "Languages and interface",
      items: [
        "Settings now offer more than ten major languages across navigation, search, settings, migration, ownership results, and runtime status.",
        "The sidebar resizes smoothly and collapses, while icons, headings, release notes, and filter controls have been realigned.",
        "All five themes cover the language picker, full-path tooltip, and force-delete confirmation dialog."
      ]
    },
    {
      title: "Performance and stability",
      items: [
        "The native paged search engine keeps multi-million-entry persisted-index queries within a sub-second target.",
        "Tray idle mode destroys renderer processes and suspends bulk background work while preserving watchers, shortcuts, and tray access.",
        "Automated coverage now includes cache restart, delta replay, live filesystem changes, clean shutdown, and locked-file force deletion."
      ]
    }
  ]
};
