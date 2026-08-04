import type { AppUpdateReleaseSection } from "../types";

export const bundledReleaseNotes: {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
} = {
  version: "0.0.5",
  summary: "本版完善版本检测、系统代理、实时搜索结果和开机启动行为。",
  sections: [
    {
      title: "版本检测与自动更新",
      items: [
        "启动及窗口恢复时检查正式版本，托盘静默时不轮询。",
        "更新请求遵循 Windows 系统代理与 PAC。",
        "安装版与便携版均保留校验、续传和失败回滚。"
      ]
    },
    {
      title: "极速搜索实时结果",
      items: [
        "新增、删除、改名和移动会按当前条件动态更新结果。",
        "托盘静默且没有有效搜索时不运行动态查询。"
      ]
    },
    {
      title: "启动与安装行为",
      items: [
        "新增开机启动后最小化，并降低托盘后台内存占用。",
        "覆盖安装会保留用户原有的桌面快捷方式选择。"
      ]
    }
  ]
};
