import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  version: "0.1.7",
  summary: "本版为五套主题统一加入透亮的液态玻璃材质，覆盖路径框、工具栏、菜单、属性和独立窗口，并修复迁移记录数量标签外露的矩形底色。",
  sections: [
    {
      title: "五套主题的液态玻璃",
      items: [
        "像素湖境、未来中枢、月白晶境、熔芯蜂巢和暖瓷晨光统一使用半透明材质、背景模糊和边缘高光，保留各自主题配色。",
        "路径输入框、搜索框、工具栏、侧栏、右键菜单、属性弹窗和独立搜索、强制删除、卸载前恢复窗口同步呈现玻璃质感。",
        "卸载前恢复窗口实时跟随主题变化，无需重新打开窗口。"
      ]
    },
    {
      title: "原生材质与交互反光",
      items: [
        "Windows 11 22H2 及以上支持原生 Acrylic 背景；系统不支持、开启高对比度或减少透明度、材质调用失败时使用可读的实色背景。",
        "反光跟随指针移动，仅在交互时更新，不增加闲置循环动画；窗口失焦或隐藏时清除反光。",
        "跟随系统辅助功能偏好调整透明度、对比度与反光，减少动画设置下停用指针反光。"
      ]
    },
    {
      title: "可读性与细节修复",
      items: [
        "调整文字、输入提示、焦点边框和危险按钮的颜色与背景，在透亮材质上保留清晰的操作辨识度。",
        "修复迁移记录数量标签椭圆外多出的矩形底色，玻璃高光仅保留在标签内部。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  version: "0.1.7",
  summary: "This release brings translucent liquid glass to all five themes across path fields, toolbars, menus, properties, and separate windows, and removes the rectangular background outside the migration-count badge.",
  sections: [
    {
      title: "Liquid glass across five themes",
      items: [
        "Apply translucent surfaces, backdrop blur, and edge highlights to Pixel Lake, Future Hub, Moonlit Crystal, Ember Hive, and Warm Ivory while retaining their colors.",
        "Extend glass styling to path and search fields, toolbars, sidebars, context menus, properties dialogs, and separate search, force-delete, and restore-before-uninstall windows.",
        "Keep the restore-before-uninstall window synchronized with theme changes without reopening it."
      ]
    },
    {
      title: "Native material and pointer reflections",
      items: [
        "Use native Acrylic on Windows 11 22H2 and later, with a readable solid background for unsupported systems, high contrast, reduced transparency, or material failures.",
        "Update reflections only as the pointer moves, with no added idle animation loop; clear them when windows lose focus or become hidden.",
        "Respect system transparency and contrast preferences, and disable pointer reflections when reduced motion is enabled."
      ]
    },
    {
      title: "Readability and detail fixes",
      items: [
        "Refine text, input hints, focus borders, and danger-button colors and backgrounds so actions remain legible on translucent surfaces.",
        "Remove the rectangular background outside the oval migration-count badge and keep the glass highlight within its outline."
      ]
    }
  ]
};
