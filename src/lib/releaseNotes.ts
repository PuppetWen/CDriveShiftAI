import type { AppUpdateReleaseSection } from "../types";

export const bundledReleaseNotes: {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
} = {
  version: "0.0.8",
  summary: "本版修复 Windows 索引缓存覆盖失败与残缺缓存误判，确保少量异常结果会自动重建。",
  sections: [
    {
      title: "索引缓存修复",
      items: [
        "修复已有缓存刷新时 Windows 返回 os error 5、无法覆盖旧索引的问题。",
        "新缓存会在释放旧内存映射后原子替换；发布失败会恢复原文件，不留下半成品。",
        "持久化失败时改为明确显示仅本次会话可用，并记录可导出的诊断信息。"
      ]
    },
    {
      title: "完整性保护",
      items: [
        "明显残缺的系统盘缓存不再标记为 CACHED，而会在启动时自动废弃并重建。",
        "MFT 返回异常少量结果时自动改用完整目录扫描，避免把局部结果保存为全盘索引。",
        "扫描最终仍不完整时保持错误状态，不再显示索引已就绪。"
      ]
    },
    {
      title: "回归验证",
      items: [
        "新增 Windows 已有缓存覆盖、残缺缓存拒绝和原文件回滚自动化测试。",
        "缓存重启、增量重放、强制刷新和动态文件变化回归通过。",
        "616 万条真实持久化索引完成包含、完整词和模糊查询性能复测。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: typeof bundledReleaseNotes = {
  version: "0.0.8",
  summary:
    "This release fixes Windows cache replacement failures and prevents incomplete indexes from being reported as ready.",
  sections: [
    {
      title: "Index cache fix",
      items: [
        "Fixed os error 5 when a Windows refresh attempted to replace an existing persistent index.",
        "The old memory map is released before atomic publication; a failed publication restores the previous cache.",
        "A persistence failure is now reported as session-only index availability and recorded in exportable diagnostics."
      ]
    },
    {
      title: "Integrity safeguards",
      items: [
        "An obviously incomplete system-drive cache is rejected and rebuilt instead of being marked CACHED.",
        "An implausibly small MFT result automatically falls back to a complete directory scan.",
        "A scan that remains incomplete stays in an error state and is never published as ready."
      ]
    },
    {
      title: "Regression coverage",
      items: [
        "Automated tests now cover Windows replacement of an existing cache, incomplete-cache rejection, and rollback.",
        "Cache restart, delta replay, forced refresh, and live filesystem changes pass regression testing.",
        "Contains, whole-word, and fuzzy queries were rechecked against a real 6.16-million-entry cache."
      ]
    }
  ]
};
