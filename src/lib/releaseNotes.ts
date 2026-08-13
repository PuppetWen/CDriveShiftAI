import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  version: "0.0.12",
  summary: "本版支持直接按下鼠标按键进行快捷操作录入，以滑杆设置长按毫秒数，并可离线查看逐条折叠的历史更新。",
  sections: [
    {
      title: "鼠标快捷操作",
      items: [
        "触发按键不再使用下拉框，点击录入区域后直接按鼠标后退侧键、前进侧键或中键即可保存。",
        "不支持的左键和右键不会误覆盖已有设置，界面会继续等待有效按键并给出提示。",
        "录入结果会立即持久化并同步到底层全局鼠标监听器，仍可一键关闭鼠标触发。"
      ]
    },
    {
      title: "长按时长",
      items: [
        "长按时长改为可拖动滑杆，范围为 500–10000 毫秒，步进 100 毫秒。",
        "滑杆旁同时显示精确毫秒数和秒数，并保留键盘方向键的无障碍调节能力。",
        "拖动结束、键盘调整结束或滑杆失焦时自动保存，无需手动输入数值。"
      ]
    },
    {
      title: "历史更新",
      items: [
        "更新与诊断界面内置从 0.0.1 开始的历史更新内容，无网络时仍可查看。",
        "每个历史版本都能独立展开或收起，默认保持收起，展开一个版本不会改变其他版本。",
        "历史列表内容较多时显示独立纵向滚动条；每条记录保留 GitHub Release 入口，并针对窄屏切换为单列。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  version: "0.0.12",
  summary:
    "This release records mouse shortcuts from a physical button press, sets hold time with a millisecond slider, and adds an offline collapsible release history.",
  sections: [
    {
      title: "Mouse shortcuts",
      items: [
        "The trigger is no longer a dropdown: arm the recorder and press the mouse back, forward, or middle button to save it.",
        "Unsupported left and right clicks do not overwrite the existing setting; the recorder stays armed and explains what to press.",
        "Captured settings persist immediately and are synchronized with the native global mouse listener; the trigger can still be disabled in one click."
      ]
    },
    {
      title: "Hold duration",
      items: [
        "Hold duration now uses a draggable slider from 500 to 10000 milliseconds in 100 millisecond steps.",
        "The control shows exact milliseconds and seconds together and remains adjustable with keyboard arrow keys.",
        "The value saves when dragging or keyboard adjustment ends, or when the slider loses focus."
      ]
    },
    {
      title: "Release history",
      items: [
        "Update & diagnostics now includes release content back to 0.0.1 and remains available offline.",
        "Every historical version expands and collapses independently and is collapsed by default.",
        "Long histories use their own vertical scrollbar; every entry links to GitHub Release and switches to one column on narrow screens."
      ]
    }
  ]
};
