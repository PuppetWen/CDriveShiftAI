import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  version: "0.1.0",
  summary: "本版将鼠标触发时长调整为 0–3000 毫秒，并以 50%–300% 连续滑杆替代固定的字体与界面大小档位。",
  sections: [
    {
      title: "鼠标触发时长",
      items: [
        "长按滑杆范围由 500–10000 毫秒调整为更实用的 0–3000 毫秒，继续采用 100 毫秒步进。",
        "0 毫秒表示按下鼠标后退侧键、前进侧键或中键时立即触发，不再等待定时器。",
        "前端、设置存储与 Rust 原生监听器统一使用新范围；旧的超长配置会安全收敛到 3000 毫秒。"
      ]
    },
    {
      title: "连续界面缩放",
      items: [
        "原来的小、标准、大、特大四档按钮改为连续进度滑杆，当前标准字体与界面大小定义为 100%。",
        "可调范围扩展到 50%–300%，滑动一次变化 10%，文字、控件、间距与图标保持整体同步缩放。",
        "拖动过程中界面和文字随滑块逐步放大或缩小，松开后保存最终值；旧四档设置会归一到最近的 10%。"
      ]
    },
    {
      title: "设置兼容与验证",
      items: [
        "设置读取层会验证、取整并限制缩放比例与鼠标毫秒数，异常或损坏值不会传入窗口和原生监听器。",
        "新增连续缩放、持久化兼容、0 毫秒即时触发范围和原生上限的回归测试。",
        "更新与诊断继续内置逐条折叠的离线历史，并将 0.0.12 收录为上一版本。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  version: "0.1.0",
  summary:
    "This release limits mouse activation time to 0–3000 milliseconds and replaces fixed interface sizes with a continuous 50%–300% slider.",
  sections: [
    {
      title: "Mouse activation time",
      items: [
        "The hold slider now covers a practical 0–3000 milliseconds instead of 500–10000, retaining 100 millisecond steps.",
        "Zero milliseconds triggers immediately when the configured back, forward, or middle mouse button is pressed, without starting a delay timer.",
        "The renderer, persisted settings, and Rust listener share the new limits; older long values safely converge to 3000 milliseconds."
      ]
    },
    {
      title: "Continuous interface scaling",
      items: [
        "The four Small, Standard, Large, and Extra large buttons are replaced by a continuous slider where the existing Standard size is 100%.",
        "The slider moves through 50%–300% in ten-percent increments, scaling text, controls, spacing, and icons together.",
        "Text and the interface resize step by step while dragging, then save on release; legacy presets normalize to the nearest ten percent."
      ]
    },
    {
      title: "Compatibility and verification",
      items: [
        "Persisted values are validated, rounded, and clamped before reaching any window or native listener.",
        "Regression coverage now includes continuous scaling, legacy settings, zero-delay activation, and the native three-second cap.",
        "Update & diagnostics keeps its independently collapsible offline history and now includes 0.0.12."
      ]
    }
  ]
};
