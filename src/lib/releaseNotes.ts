import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  "version": "0.1.12",
  "summary": "搜索支持键盘删除整颗关键词、Ctrl 多选与拖动框选，输入焦点改为主题荧光效果。",
  "sections": [
    {
      "title": "关键词输入",
      "items": [
        "输入框为空时按 Backspace 或 Delete 删除上一颗完整关键词，连续按键可继续删除；输入法组词时避免误删。",
        "输入框和标签编辑采用主题荧光效果，提示精简为“回车确认关键词，点击标签可编辑”。"
      ]
    },
    {
      "title": "结果选择",
      "items": [
        "名称与文件内容搜索结果支持 Ctrl 加左键增减选择和拖动框选。",
        "框选兼容虚拟列表与滚动，拖动结束后保留选择；隐藏窗口或结束拖动后停止框选处理。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  "version": "0.1.12",
  "summary": "Delete keyword chips from the keyboard, select results with Ctrl-click or a drag box, and enjoy theme-aware focus glow.",
  "sections": [
    {
      "title": "Keyword input",
      "items": [
        "Press Backspace or Delete in an empty draft to remove the previous chip; IME composition never removes chips.",
        "Use a theme-aware glow for search and tag editing, with a shorter keyword hint."
      ]
    },
    {
      "title": "Result selection",
      "items": [
        "Ctrl-click toggles selected results and dragging draws a selection box in name and content search.",
        "Selection works across virtual rows and scrolling; drag handling stops when the gesture ends or the window is hidden."
      ]
    }
  ]
};
