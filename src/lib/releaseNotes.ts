import type { AppUpdateReleaseSection } from "../types";

export const bundledReleaseNotes: {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
} = {
  version: "0.0.10",
  summary: "本版修复含 Junction 或符号链接的目录无法安全迁移的问题，并将链接纳入完整性校验。",
  sections: [
    {
      title: "链接安全迁移",
      items: [
        "Junction、目录符号链接和文件符号链接不再被误报为无法读取的条目。",
        "迁移会复制链接本身而不展开目标，避免循环、重复数据或链接丢失。",
        "预检计划新增链接数量，并继续阻止真实权限错误或不完整扫描。"
      ]
    },
    {
      title: "完整性校验",
      items: [
        "复制后同时核对文件数、目录数、总字节数和重解析点数量。",
        "每个链接的相对路径与目标都会逐项比较，缺失或变化时不会执行切换。",
        "校验以复制完成后的当前源目录为准，可发现复制期间发生的大多数变化。"
      ]
    },
    {
      title: "使用要求与验证",
      items: [
        "迁移前仍必须完全退出关联应用；Windows 无法可靠枚举所有打开文件。",
        "新增真实 Robocopy Junction 复制和目录汇总回归测试。",
        "49 项单元测试、类型检查和生产构建全部通过。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: typeof bundledReleaseNotes = {
  version: "0.0.10",
  summary:
    "This release enables safe migration of directories containing junctions or symbolic links and verifies every preserved link.",
  sections: [
    {
      title: "Link-safe migration",
      items: [
        "Junctions, directory symlinks, and file symlinks are no longer reported as unreadable entries.",
        "Migration copies links themselves instead of expanding their targets, preventing loops, duplication, or missing links.",
        "The preflight plan reports link counts while continuing to block genuine permission and incomplete-scan errors."
      ]
    },
    {
      title: "Integrity verification",
      items: [
        "Post-copy verification compares file counts, directory counts, total bytes, and reparse-point counts.",
        "Every link's relative path and target are compared before the source path is switched.",
        "Verification rescans the current source after copying to detect most changes made during the copy."
      ]
    },
    {
      title: "Requirements and validation",
      items: [
        "Related applications must still be fully closed because Windows cannot reliably enumerate every open file.",
        "Regression coverage now performs a real Robocopy junction-preservation test.",
        "All 49 unit tests, type checks, and production builds passed."
      ]
    }
  ]
};
