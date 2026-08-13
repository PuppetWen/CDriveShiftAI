import {
  bundledReleaseNotes,
  bundledReleaseNotesEnglish,
  type BundledReleaseNote
} from "./releaseNotes";

const previousReleases: Array<{
  version: string;
  zh: Omit<BundledReleaseNote, "version">;
  en: Omit<BundledReleaseNote, "version">;
}> = [
  {
    version: "0.0.12",
    zh: {
      summary: "支持直接录入鼠标侧键和中键，以毫秒滑杆设置长按时间，并加入逐条折叠的离线更新历史。",
      sections: [
        {
          title: "鼠标快捷操作",
          items: [
            "点击录入区域后可直接按鼠标后退侧键、前进侧键或中键，设置会同步到全局监听器。",
            "长按时间使用 500–10000 毫秒滑杆，显示精确毫秒数并支持键盘调节。"
          ]
        },
        {
          title: "历史更新",
          items: [
            "更新与诊断内置从 0.0.1 开始的离线更新内容，每个版本可以独立展开或收起。",
            "历史列表较长时提供独立滚动条，并保留对应 GitHub Release 入口。"
          ]
        }
      ]
    },
    en: {
      summary: "Recorded mouse side and middle buttons directly, added a millisecond hold slider, and bundled independently collapsible offline release history.",
      sections: [
        {
          title: "Mouse shortcuts",
          items: [
            "The recorder captures back, forward, or middle mouse buttons and synchronizes the choice with the global listener.",
            "Hold time uses a 500–10000 millisecond slider with exact output and keyboard adjustment."
          ]
        },
        {
          title: "Release history",
          items: [
            "Update & diagnostics bundles offline notes back to 0.0.1 with independent expand and collapse state.",
            "Long history lists have their own scrollbar and retain links to each GitHub Release."
          ]
        }
      ]
    }
  },
  {
    version: "0.0.11",
    zh: {
      summary: "降低 Windows 临时目录占用造成的偶发迁移失败，记住浏览路径，并新增四档界面大小。",
      sections: [
        {
          title: "迁移与路径",
          items: [
            "临时目录重命名失败采用有限退避重试，目标冲突时立即停止。",
            "迁移、分析、搜索、内容索引和复制目标分别记住上次浏览路径。"
          ]
        },
        {
          title: "界面可读性",
          items: [
            "新增 90% 至 120% 四档整体界面大小并持久化。",
            "大屏内容宽度扩展到 1540px。"
          ]
        }
      ]
    },
    en: {
      summary: "Reduced intermittent Windows migration failures, remembered browse paths, and added four interface sizes.",
      sections: [
        {
          title: "Migration and paths",
          items: [
            "Transient rename failures use finite backoff retries and stop immediately on destination conflicts.",
            "Migration, analysis, search, content indexing, and copy destinations retain separate browse paths."
          ]
        },
        {
          title: "Readability",
          items: [
            "Added persistent 90% through 120% whole-interface scaling.",
            "Expanded large-screen content width to 1540px."
          ]
        }
      ]
    }
  },
  {
    version: "0.0.10",
    zh: {
      summary: "修复包含 Junction 或符号链接的目录无法安全迁移的问题。",
      sections: [
        {
          title: "链接安全迁移",
          items: [
            "Robocopy 保留 Junction、目录符号链接和文件符号链接本身，不展开目标。",
            "校验比较重解析点数量、相对路径和链接目标，并继续阻止真实扫描错误。"
          ]
        },
        {
          title: "运行风险",
          items: [
            "预检明确提示退出关联程序，防止文件占用或复制期间继续写入。"
          ]
        }
      ]
    },
    en: {
      summary: "Enabled safe migration of directories containing junctions or symbolic links.",
      sections: [
        {
          title: "Link-safe migration",
          items: [
            "Robocopy preserves junctions, directory symlinks, and file symlinks without expanding targets.",
            "Verification compares reparse-point counts, relative paths, and targets while still blocking genuine scan errors."
          ]
        },
        {
          title: "Runtime risk",
          items: [
            "Preflight clearly requires related applications to be closed before migration."
          ]
        }
      ]
    }
  },
  {
    version: "0.0.9",
    zh: {
      summary: "提高自动化测试、视觉回归和完整工作流验证的稳定性。",
      sections: [
        {
          title: "回归稳定性",
          items: [
            "稳定 Electron/CDP 页面目标发现和连接重试，并支持本地 dist 回退。",
            "覆盖搜索、设置、快捷键、迁移回放和持久化状态的完整回归。"
          ]
        },
        {
          title: "验证",
          items: ["46 项单元测试和 20 个项目测试命令通过。"]
        }
      ]
    },
    en: {
      summary: "Improved automation, visual-regression, and full-workflow test stability.",
      sections: [
        {
          title: "Regression stability",
          items: [
            "Stabilized Electron/CDP target discovery and retries with a local dist fallback.",
            "Expanded complete regression coverage for search, settings, shortcuts, migration replay, and persistence."
          ]
        },
        { title: "Validation", items: ["All 46 unit tests and 20 project test commands passed."] }
      ]
    }
  },
  {
    version: "0.0.8",
    zh: {
      summary: "增强系统盘索引缓存替换、完整性判断和失败回滚。",
      sections: [
        {
          title: "索引可靠性",
          items: [
            "释放旧内存映射后原子发布新缓存，修复 Windows os error 5。",
            "残缺缓存和不完整 MFT 结果不再冒充可用索引，并自动降级重建。"
          ]
        }
      ]
    },
    en: {
      summary: "Improved system-drive index replacement, integrity checks, and rollback.",
      sections: [
        {
          title: "Index reliability",
          items: [
            "Released old memory maps before atomically publishing new caches, fixing Windows error 5.",
            "Incomplete caches and MFT results no longer appear ready and automatically fall back to rebuilding."
          ]
        }
      ]
    }
  },
  {
    version: "0.0.7",
    zh: {
      summary: "完善搜索文件操作、多语言界面、侧栏交互和性能回归。",
      sections: [
        {
          title: "搜索与文件操作",
          items: [
            "完整路径提示支持自然换行，搜索结果新增受控强制删除。",
            "补齐目录搜索、分页排序、实时变更和内容搜索回归。"
          ]
        },
        {
          title: "多语言与界面",
          items: ["新增十余种语言，侧栏支持拖动调整宽度与折叠。"]
        }
      ]
    },
    en: {
      summary: "Expanded search file operations, localization, sidebar interactions, and performance coverage.",
      sections: [
        {
          title: "Search and files",
          items: [
            "Full-path tooltips wrap naturally and search results gained guarded force deletion.",
            "Completed regression coverage for pagination, sorting, live changes, and content search."
          ]
        },
        { title: "Localization and UI", items: ["Added more than ten languages plus resizable and collapsible sidebar behavior."] }
      ]
    }
  },
  {
    version: "0.0.6",
    zh: {
      summary: "重构极速搜索，新增两套主题并重新组织设置页。",
      sections: [
        {
          title: "极速搜索",
          items: [
            "采用后端分页和游标加载，支持包含、全词、模糊和正则匹配。",
            "结果表格支持列宽拖动，并提供可迁移目录快捷入口。"
          ]
        },
        {
          title: "主题与设置",
          items: ["新增熔橙和暖瓷主题，设置按更新、外观、系统和 AI 重新分组。"]
        }
      ]
    },
    en: {
      summary: "Reworked fast search, added two themes, and reorganized settings.",
      sections: [
        {
          title: "Fast search",
          items: [
            "Added backend pagination with contains, whole-word, fuzzy, and regex matching.",
            "Result columns became resizable and migratable folders gained a shortcut entry point."
          ]
        },
        { title: "Themes and settings", items: ["Added Ember and Ivory themes and regrouped settings by update, appearance, system, and AI."] }
      ]
    }
  },
  {
    version: "0.0.5",
    zh: {
      summary: "加入实时搜索刷新、系统代理更新通道和开机最小化。",
      sections: [
        {
          title: "实时搜索",
          items: ["原生索引增量会刷新可见搜索结果，托盘隐藏时暂停动态重查。"]
        },
        {
          title: "更新与启动",
          items: [
            "更新检查和下载遵循 Windows 系统代理/PAC。",
            "新增开机启动后最小化，并保留用户的桌面快捷方式选择。"
          ]
        }
      ]
    },
    en: {
      summary: "Added live search refresh, system-proxy updates, and minimized startup.",
      sections: [
        { title: "Live search", items: ["Native index deltas refresh visible results while tray-hidden windows suspend dynamic queries."] },
        {
          title: "Updates and startup",
          items: [
            "Update checks and downloads follow Windows system proxy and PAC settings.",
            "Added minimized login startup while preserving the user's desktop-shortcut choice."
          ]
        }
      ]
    }
  },
  {
    version: "0.0.4",
    zh: {
      summary: "修复自动更新启动权限问题，并新增本地日志和诊断导出。",
      sections: [
        {
          title: "更新修复",
          items: ["更新助手增加独立运行目录、短暂重试和 PowerShell 启动回退，失败时保留旧版本。"]
        },
        {
          title: "诊断与隐私",
          items: ["新增滚动 JSONL 日志、日志目录入口和脱敏诊断报告导出。"]
        }
      ]
    },
    en: {
      summary: "Fixed updater launch permissions and added local logs plus diagnostic export.",
      sections: [
        { title: "Updater fixes", items: ["Added an isolated helper directory, retries, and PowerShell launch fallback while retaining the old version on failure."] },
        { title: "Diagnostics and privacy", items: ["Added rotating JSONL logs, a log-folder shortcut, and redacted diagnostic exports."] }
      ]
    }
  },
  {
    version: "0.0.3",
    zh: {
      summary: "修复退出管道异常，并显著降低索引、渲染和托盘后台资源占用。",
      sections: [
        {
          title: "稳定性与性能",
          items: [
            "修复托盘退出时的 write EPIPE，并完善子进程有序关闭。",
            "索引延迟启动、紧凑存储并暂停隐藏窗口动画和后台重活。"
          ]
        }
      ]
    },
    en: {
      summary: "Fixed shutdown pipe failures and sharply reduced indexing, rendering, and tray resource use.",
      sections: [
        {
          title: "Stability and performance",
          items: [
            "Fixed write EPIPE during tray exit and improved orderly child-process shutdown.",
            "Deferred indexing, compacted storage, and suspended hidden-window animation and heavy work."
          ]
        }
      ]
    }
  },
  {
    version: "0.0.2",
    zh: {
      summary: "加入事务式自动更新、安装路径继承和更新失败恢复。",
      sections: [
        {
          title: "自动更新",
          items: [
            "提供下载、SHA-512 校验、替换、回滚和便携版更新流程。",
            "覆盖安装沿用已有目录，避免升级时重新选择路径。"
          ]
        }
      ]
    },
    en: {
      summary: "Added transactional auto-updates, install-path inheritance, and update failure recovery.",
      sections: [
        {
          title: "Auto update",
          items: [
            "Added download, SHA-512 verification, replacement, rollback, and portable-update flows.",
            "Upgrade installs retain the existing installation directory."
          ]
        }
      ]
    }
  },
  {
    version: "0.0.1",
    zh: {
      summary: "首个公开测试版本，提供全盘搜索、归属分析和事务式跨盘迁移。",
      sections: [
        {
          title: "主要功能",
          items: [
            "自研 MFT/目录扫描名称索引、内容搜索和磁盘目录归属地图。",
            "跨盘目录迁移、链接保留、恢复、再次迁移、主题、托盘和全局快捷键。"
          ]
        },
        {
          title: "性能基础",
          items: ["数百万条索引采用只读内存映射和紧凑元数据，隐藏时暂停后台重活。"]
        }
      ]
    },
    en: {
      summary: "Initial public preview with drive-wide search, ownership analysis, and transactional cross-drive migration.",
      sections: [
        {
          title: "Core features",
          items: [
            "First-party MFT/directory name indexing, content search, and a disk ownership map.",
            "Cross-drive migration, link preservation, recovery, reapply, themes, tray, and global shortcuts."
          ]
        },
        { title: "Performance foundation", items: ["Millions of index entries use read-only memory mapping and compact metadata while hidden windows suspend heavy work."] }
      ]
    }
  }
];

export const bundledReleaseHistory: BundledReleaseNote[] = [
  bundledReleaseNotes,
  ...previousReleases.map(({ version, zh }) => ({ version, ...zh }))
];

export const bundledReleaseHistoryEnglish: BundledReleaseNote[] = [
  bundledReleaseNotesEnglish,
  ...previousReleases.map(({ version, en }) => ({ version, ...en }))
];
