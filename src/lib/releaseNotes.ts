import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  version: "0.1.1",
  summary: "本版重点修复局部放大镜在调节尺寸与滚轮缩放时的白屏、灰帧和抖动，并加强常驻稳定性与后台效率。",
  sections: [
    {
      title: "局部放大镜显示",
      items: [
        "放大镜改为双缓冲画面交换：新画面准备完成后再显示，避免滚轮缩放期间闪成灰色或空白。",
        "滚轮以鼠标所在位置为中心平滑调整倍率，采用短帧间隔插值，减少内容上下跳动后回位。",
        "放大区域继续显示清晰边框、隐藏放大的鼠标图标，并可在截图、录屏或远程画面中正常看到。"
      ]
    },
    {
      title: "尺寸滑杆稳定性",
      items: [
        "宽度和高度滑杆在事件回调内立即读取数值，修复拖动后 React 事件失效导致的整页白屏。",
        "拖动滑杆只更新并保存配置，不再误创建或显示放大镜窗口。",
        "松开滑杆后再把最终尺寸同步给原生监听器；实际使用放大镜时严格采用用户保存的宽高。"
      ]
    },
    {
      title: "常驻与快捷键",
      items: [
        "全局监听器增加单实例互斥，避免同时运行旧版、便携版或安装版时争抢同一组按键与滚轮。",
        "单独按修饰键不会显示放大镜；录入快捷键期间暂停全局监听，确保组合键和滚轮能够被设置页接收。",
        "窗口渲染进程异常时自动恢复一次，降低极端情况下主界面停留在空白页的概率。"
      ]
    },
    {
      title: "资源与验证",
      items: [
        "索引器在后台运行时降低进程优先级并收缩可回收工作集，减少静默常驻时的 CPU 与内存压力。",
        "新增原生放大镜画面、尺寸滑杆拖动和多实例监听冲突的自动化回归测试。",
        "更新与诊断继续提供逐条折叠并可滚动的离线历史，本版将 0.1.0 收录为上一版本。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  version: "0.1.1",
  summary:
    "This release fixes blank, gray, and jumping frames while resizing or zooming the desktop lens, and improves resident stability and efficiency.",
  sections: [
    {
      title: "Desktop lens rendering",
      items: [
        "The lens now swaps between two buffered surfaces only after a complete frame is ready, preventing blank or gray flashes during wheel zoom.",
        "Magnification eases at short frame intervals around the pointer, reducing the jump-and-return effect.",
        "The bordered lens still omits the magnified cursor and remains visible in screenshots, recordings, and remote sessions."
      ]
    },
    {
      title: "Size slider stability",
      items: [
        "Width and height values are captured synchronously inside React callbacks, fixing the full-page blank screen caused by an expired event during dragging.",
        "Dragging only previews and persists configuration; it no longer creates or shows a lens window.",
        "The final size is sent to the native listener after release and is used exactly when the lens is activated."
      ]
    },
    {
      title: "Resident mode and shortcuts",
      items: [
        "A named single-instance guard prevents installed, portable, or older builds from competing for the same global keyboard and wheel hook.",
        "Modifier keys alone do not open the lens, and global listening pauses during shortcut recording.",
        "The main window attempts one renderer recovery after an unexpected render-process failure."
      ]
    },
    {
      title: "Efficiency and verification",
      items: [
        "The background indexer lowers its process priority and trims reclaimable working-set pages to reduce idle CPU and memory pressure.",
        "Automated regression coverage now includes native lens frames, slider dragging, and multi-instance listener conflicts.",
        "Update & diagnostics retains independently collapsible, scrollable offline history and now includes 0.1.0."
      ]
    }
  ]
};
