import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  version: "0.1.6",
  summary: "本版修复强制删除确认框勾选后没有明显反馈的问题。资源管理器右键删除只打开独立确认窗口，保留删除进度、成功结果和失败指引。",
  sections: [
    {
      title: "确认操作即时反馈",
      items: [
        "修复确认复选框被通用样式隐藏的问题；点击整行即可勾选或取消，勾选后显示对勾、高亮和“已勾选确认”。",
        "底部明确提示先勾选再执行，删除按钮随确认状态启用；支持键盘空格切换和可见焦点。",
        "删除或等待管理员授权时显示执行状态并禁用重复操作，勾选本身不会开始删除。"
      ]
    },
    {
      title: "独立右键删除窗口",
      items: [
        "资源管理器右键强制删除只弹出独立确认窗口，无需打开或唤起桌面端主界面。",
        "覆盖程序未启动、主界面已打开和托盘运行场景，连续请求继续排队，逐项预检并确认。",
        "删除成功后显示结果，失败时保留原因和操作指引；已有右键菜单无需重新添加。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  version: "0.1.6",
  summary: "This release makes force-delete consent visibly respond to clicks and opens Explorer deletion in a separate confirmation window with progress, results, and failure guidance.",
  sections: [
    {
      title: "Clear confirmation feedback",
      items: [
        "Restore the checkbox hidden by shared styles; clicking the row toggles a visible checkmark, highlight, and confirmation message.",
        "Explain when to check the box and enable deletion only after consent, with Space-key support and visible focus.",
        "Show deletion or authorization progress and block duplicate actions; checking the box alone never starts deletion."
      ]
    },
    {
      title: "Separate Explorer deletion window",
      items: [
        "Open only a separate confirmation window for Explorer force deletion, without opening or bringing forward the main app.",
        "Handle cold starts, an open main window, and tray sessions while keeping queued requests and individual confirmation.",
        "Keep the success result or failure guidance visible; existing context-menu registrations do not need to be recreated."
      ]
    }
  ]
};
