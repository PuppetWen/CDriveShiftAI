import type { AppUpdateReleaseSection } from "../types";

export const bundledReleaseNotes: {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
} = {
  version: "0.0.6",
  summary: "本版重构极速搜索体验，并新增熔橙蜂巢与暖瓷晨光两套完整主题。",
  sections: [
    {
      title: "极速搜索",
      items: [
        "名称搜索支持包含、完整词、模糊和正则匹配，并提供清晰的分组筛选工作台。",
        "后端分页、滚动懒加载和列表虚拟化兼顾完整结果、动态更新与低内存占用。",
        "结果表格支持列宽拖动、完整排序、文件夹大小和直接迁移操作。"
      ]
    },
    {
      title: "界面主题",
      items: [
        "新增熔橙蜂巢主题：橙黑工业 HUD、蜂巢背景和切面控件。",
        "新增暖瓷晨光主题：米白纸感、陶土色强调和柔和卡片层次。",
        "五套主题统一覆盖主窗口、独立搜索、托盘菜单、提示、对话框与进度效果。"
      ]
    },
    {
      title: "独立搜索与设置",
      items: [
        "独立极速搜索窗口新增紧凑主题切换器，与主窗口共享并持久保存主题。",
        "设置页按功能重新分组，减少无效空白并保留即时生效行为。",
        "主题切换不会触发快捷键冲突弹窗，冲突仅在设置区域内提示。"
      ]
    }
  ]
};
