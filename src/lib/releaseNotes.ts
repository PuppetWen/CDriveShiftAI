import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  version: "0.1.3",
  summary: "本版修复更新完成后在安装目录旁遗留 CDriveShiftAI-Update-Runner 空目录的问题，并加强更新助手清理验证。",
  sections: [
    {
      title: "更新目录位置",
      items: [
        "更新助手不再创建于安装目录的相邻位置，改为安装目录内部的 .cdriveshiftai-update-runner 专用目录。",
        "安装版和便携版使用相同的内部路径规则，不再占用用户选择目录的同级位置。",
        "更新助手文件名包含目标版本，避免不同版本残留文件发生名称冲突。"
      ]
    },
    {
      title: "更新后清理",
      items: [
        "新版本启动确认后删除整个内部 runner 目录，不再只删除版本子目录而留下空外层目录。",
        "启动时会清理由旧版产生且确实为空的同级 CDriveShiftAI-Update-Runner；非空目录保持不动。",
        "清理操作继续使用严格路径边界，避免删除其他同名或无关目录。"
      ]
    },
    {
      title: "安装安全",
      items: [
        "更新前仍保留主更新助手与内部备用助手的逐字节哈希校验。",
        "安装更新继续保留原安装路径和 .cdriveshiftai-data 应用数据。",
        "备用助手从安装目录内部运行时仍支持静默安装、启动确认和失败恢复。"
      ]
    },
    {
      title: "自动化验证",
      items: [
        "新增安装目录内部 runner 路径的单元测试。",
        "便携版完整更新测试验证更新包、备份和内部 runner 均会删除。",
        "安装版完整更新测试从内部 runner 启动更新，并验证安装路径、应用数据和清理结果。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  version: "0.1.3",
  summary:
    "This release prevents updates from leaving an empty CDriveShiftAI-Update-Runner beside the installation directory and strengthens helper cleanup verification.",
  sections: [
    {
      title: "Update runner location",
      items: [
        "The helper now uses .cdriveshiftai-update-runner inside the application directory instead of creating a sibling directory.",
        "Installed and portable distributions share the same internal location rule.",
        "Helper filenames include the target version to avoid stale-name collisions."
      ]
    },
    {
      title: "Post-update cleanup",
      items: [
        "After startup acknowledgement, the complete internal runner directory is removed rather than leaving an empty parent.",
        "Empty legacy sibling runner directories are removed at startup, while non-empty directories are preserved.",
        "Strict path boundaries continue to protect unrelated directories from cleanup."
      ]
    },
    {
      title: "Installation safety",
      items: [
        "Both primary and internal fallback helpers retain byte-for-byte hash verification.",
        "Installed updates preserve the selected installation path and .cdriveshiftai-data application data.",
        "The internal fallback runner supports silent installation, startup acknowledgement, and recovery."
      ]
    },
    {
      title: "Automated verification",
      items: [
        "Unit coverage verifies that the runner remains inside the application directory.",
        "The portable update flow verifies cleanup of the package, backup, and internal runner.",
        "The installed update flow starts from the internal runner and verifies path preservation, data preservation, and cleanup."
      ]
    }
  ]
};
