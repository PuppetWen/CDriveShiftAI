import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  "version": "0.2.4",
  "summary": "降低大索引和搜索分页的内存占用，修复更新页的系统代理状态。",
  "sections": [
    {
      "title": "搜索与内存",
      "items": [
        "压缩常驻文件索引，避免首次文件变动时复制并扩容整个索引。保留现有索引文件和全部搜索条件。",
        "结果分页复用已有路径和工作区快照，减少搜索时的临时内存和重复通信。"
      ]
    },
    {
      "title": "更新代理",
      "items": [
        "按更新请求的目标重新解析 Windows 系统代理和 PAC，避免缓存的版本结果恢复过期代理状态。",
        "分别显示系统代理或未匹配应用层代理，避免把 VPN 或 TUN 流量误标为直连。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  "version": "0.2.4",
  "summary": "Reduce memory use with large indexes and paged searches, and correct the update page's system proxy status.",
  "sections": [
    {
      "title": "Search and memory",
      "items": [
        "Compact the resident file index and avoid copying and growing the entire index on the first file change. Existing index files and search filters remain compatible.",
        "Reuse paths and workspace snapshots during pagination to reduce temporary memory and duplicate messages."
      ]
    },
    {
      "title": "Update proxy",
      "items": [
        "Resolve Windows system proxy and PAC rules per update destination. Cached release metadata no longer restores an outdated proxy status.",
        "Explain when no application proxy matches without implying traffic bypasses a VPN or TUN."
      ]
    }
  ]
};
