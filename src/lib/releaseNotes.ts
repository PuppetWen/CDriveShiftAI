import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  version: "0.1.0",
  summary: "本版将鼠标触发时长调整为 0–3000 毫秒，加入全应用字体滑杆与跨程序的 Windows 局部放大镜。",
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
      title: "全应用字体缩放",
      items: [
        "原来的四档按钮改为 50%–300% 连续滑杆，以当前标准字体为 100%，每次变化 10%。",
        "主窗口、极速搜索、搜索结果和辅助窗口内的全部文字同步变化；卡片、按钮、间距和图标保持原尺寸。",
        "移除整页缩放及其横向滚动容器，避免高倍比例下吸顶卡片相互覆盖或页面被整体挤压。",
        "100% 标记与滑块圆点使用相同的有效轨道坐标；拖动时实时预览，松开后保存最终值。"
      ]
    },
    {
      title: "全局局部放大镜",
      items: [
        "新增跨程序、跨显示器的 Windows 局部放大镜，按住自定义组合键时在鼠标附近显示。",
        "快捷方式通过实际按住 Ctrl、Alt、Shift 或 Win 组合并滚动一次进行录入，不使用下拉框。",
        "只有组合键与滚轮同时触发后才显示，单独按 Ctrl 不会放大；录入时暂停全局钩子，避免抢走滚轮事件。",
        "滚轮调整局部倍率，宽度与高度分别通过滑杆配置；区域带边框并以鼠标为中心采样，放大画面不显示鼠标图标。"
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
    "This release limits mouse activation time to 0–3000 milliseconds, adds app-wide text sizing, and introduces a Windows desktop lens.",
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
      title: "App-wide text scaling",
      items: [
        "The old presets are replaced by a 50%–300% slider, with the current standard text size defined as 100% and ten-percent steps.",
        "All text in the main window, fast search, search results, and utility windows scales while cards, controls, spacing, and icons keep their original dimensions.",
        "Whole-page zoom and its horizontal overflow wrapper were removed to prevent sticky cards from overlapping at high values.",
        "The 100% marker uses the same effective track coordinates as the thumb; dragging previews live and saves on release."
      ]
    },
    {
      title: "Global desktop lens",
      items: [
        "A Windows desktop lens now follows the pointer across applications and displays.",
        "Record the shortcut by physically holding Ctrl, Alt, Shift, or Win modifiers and scrolling once instead of selecting from a dropdown.",
        "The lens appears only after a modifier-plus-wheel gesture; pressing Ctrl alone does nothing, and capture mode pauses the global hook so recording receives the wheel event.",
        "The wheel changes magnification, width and height use separate sliders, and the bordered source region is centered on the pointer without showing a magnified cursor icon."
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
