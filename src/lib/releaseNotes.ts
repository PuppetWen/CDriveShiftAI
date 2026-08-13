import type { AppUpdateReleaseSection } from "../types";

export const bundledReleaseNotes: {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
} = {
  version: "0.0.11",
  summary: "本版降低 Windows 临时目录占用造成的偶发迁移失败，记住浏览路径，并新增四档界面大小。",
  sections: [
    {
      title: "迁移可靠性",
      items: [
        "Windows 临时拒绝目录重命名时会进行有限退避重试，不再因瞬时文件句柄直接失败。",
        "目标路径被其他程序创建时立即停止，持续占用时显示可操作的关闭程序提示。",
        "源目录切换、目标发布、失败恢复和迁移回滚使用相同的受控重命名流程。"
      ]
    },
    {
      title: "路径记忆",
      items: [
        "目录浏览器会回到用户上次选择的位置。",
        "迁移源、迁移目标、分析、搜索、内容索引和复制目标分别保存历史路径。",
        "已失效的历史目录会被忽略，浏览器安全回退到系统默认位置。"
      ]
    },
    {
      title: "界面可读性",
      items: [
        "设置新增小、标准、大、特大四档字体与界面大小，并自动保存。",
        "文字、控件、图标和间距整体缩放，主窗口与快速搜索窗口同步生效。",
        "大屏内容宽度扩展至 1540px，更充分利用最大化窗口空间。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: typeof bundledReleaseNotes = {
  version: "0.0.11",
  summary:
    "This release reduces intermittent Windows migration failures, remembers browse locations, and adds four interface-size options.",
  sections: [
    {
      title: "Migration reliability",
      items: [
        "Transient Windows directory rename failures now use a finite backoff retry instead of failing immediately.",
        "Migration stops if another process creates the destination and explains persistent file-handle conflicts.",
        "Source switching, destination publishing, failure recovery, and rollback share the guarded rename flow."
      ]
    },
    {
      title: "Browse history",
      items: [
        "Directory pickers reopen at the location the user selected last time.",
        "Migration source, destination, analysis, search, content indexing, and copy destinations keep separate histories.",
        "Missing remembered directories are ignored and safely fall back to the system default."
      ]
    },
    {
      title: "Interface readability",
      items: [
        "Settings now offers Small, Standard, Large, and Extra large interface sizes with persistence.",
        "Text, controls, icons, and spacing scale together across the main and quick-search windows.",
        "The large-screen content width expands to 1540px to use maximized windows more effectively."
      ]
    }
  ]
};
