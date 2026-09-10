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
    version: "0.1.4",
    zh: {
      summary: "本版修复跨盘迁移、迁回和再次迁移的数据校验与恢复问题，新增管理员 PowerShell 强制删除及资源管理器右键菜单开关，并完善删除失败指引和设置保存。",
      sections: [
        {
          title: "迁移与恢复",
          items: [
            "迁移前后逐文件校验内容、目录结构与链接，复制并核验 NTFS 访问权限，识别复制期间的写入变化。",
            "修复内部绝对链接和外部相对链接在迁移、迁回后指向错误位置的问题，并核对原路径是否被替换。",
            "修复部分清理失败和中断恢复误判，保留可用数据与待清理状态，恢复后支持再次迁移。",
            "正确识别 Windows 8.3 短路径，避免将普通目录名称误判为目录重定向。"
          ]
        },
        {
          title: "管理员强制删除",
          items: [
            "常规删除及处理已确认的占用进程后仍失败时，自动尝试管理员 PowerShell，支持 UAC 等待、取消与结果反馈。",
            "删除时核对目标和父目录身份，不跟随链接删除外部内容，也不改写目标外硬链接的只读属性。",
            "仅处理本次确认且身份未变的普通相关进程，完成后检查目标确实不存在。系统、自身和迁移事务路径继续受保护。"
          ]
        },
        {
          title: "删除失败操作指引",
          items: [
            "按文件占用、权限拒绝、后台持续写入和受保护路径分别说明下一步，并保留具体错误与失败路径。",
            "提供定位文件、复制路径、任务管理器和已安装应用入口，以及重启、卸载和普通残留文件的安全模式操作说明。",
            "管理员权限无法解除所有驱动锁或系统限制；失败后必须重新预检与确认，不将未删除的目标报告为成功。"
          ]
        },
        {
          title: "资源管理器右键菜单",
          items: [
            "设置中可添加或取消文件、文件夹的“CDriveShiftAI 强制删除”菜单；Windows 11 可能需点击“显示更多选项”。",
            "右键请求打开同一预检确认窗口，支持冷启动、托盘恢复和连续请求排队，不覆盖正在确认的目标。",
            "菜单显示实际注册状态，失败时回滚设置；卸载只清理由当前安装拥有的菜单，升级保留菜单。"
          ]
        },
        {
          title: "配置与操作稳定性",
          items: [
            "修复设置并发保存覆盖新编辑、旧请求覆盖新配置等问题；读取或保存失败明确报错并保留原数据。",
            "保留仍在使用或含待恢复数据的迁移记录，迁移、恢复和文件操作互斥，退出等待正在执行的事务。",
            "修复连续迁移状态、过期预检和弹窗期间后台删除快捷键问题，并改善长路径与大字号下的删除提示。"
          ]
        }
      ]
    },
    en: {
      summary:
        "This release repairs migration and restore verification, adds elevated PowerShell deletion and an Explorer menu switch, and improves failure guidance and settings persistence.",
      sections: [
        {
          title: "Migration and restore",
          items: [
            "Verify individual file contents, structure, links, and NTFS permissions; detect writes during copying.",
            "Repair relocated link targets and reject replaced source paths during migration and restore.",
            "Preserve usable data after interrupted operations or partial cleanup, and allow migration again after restore.",
            "Recognize Windows 8.3 short names without mistaking ordinary directory names for redirected paths."
          ]
        },
        {
          title: "Elevated force deletion",
          items: [
            "Retry with elevated PowerShell when ordinary deletion and confirmed process handling fail; report UAC results.",
            "Verify target and parent identities without following links or changing external hard-link attributes.",
            "Only handle confirmed, unchanged ordinary processes; verify deletion and retain protected-path safeguards."
          ]
        },
        {
          title: "Deletion failure guidance",
          items: [
            "Show steps for locks, denied access, ongoing writes, and protected paths while retaining the actual error.",
            "Add file, clipboard, Task Manager, and uninstall links plus restart and Safe Mode steps for ordinary leftovers.",
            "Elevation cannot remove every driver lock or system restriction; retries require a fresh preview and consent."
          ]
        },
        {
          title: "Explorer context menu",
          items: [
            "Enable or remove the file and folder force-delete menu in Settings; Windows 11 may use Show more options.",
            "Open the same confirmation dialog from a cold start or tray, and queue requests without replacing a target.",
            "Read actual registration status, roll back failed changes, and remove only this installation's menu on uninstall."
          ]
        },
        {
          title: "Settings and reliability",
          items: [
            "Keep newer settings edits during concurrent saves and report read or write failures without losing old data.",
            "Protect active migration records, serialize file operations, and wait for active transactions before exit.",
            "Fix repeated migration, stale previews, background delete shortcuts during dialogs, and enlarged-text layouts."
          ]
        }
      ]
    }
  },
  {
    version: "0.1.3",
    zh: {
      summary: "修复更新完成后在安装目录旁遗留 CDriveShiftAI-Update-Runner 空目录的问题，并加强更新助手清理验证。",
      sections: [
        {
          title: "更新目录位置与清理",
          items: [
            "安装版与便携版的更新助手改用安装目录内部的专用目录，文件名包含目标版本。",
            "新版本启动确认后清除整个内部 runner 目录，并清理由旧版遗留且确实为空的同级目录。"
          ]
        },
        {
          title: "安装安全与验证",
          items: [
            "更新保留助手哈希校验、原安装路径和应用数据，严格限制清理范围。",
            "安装版和便携版完整更新测试覆盖助手启动、失败恢复及更新文件清理。"
          ]
        }
      ]
    },
    en: {
      summary: "Prevented updates from leaving an empty CDriveShiftAI-Update-Runner beside the installation and strengthened helper cleanup verification.",
      sections: [
        {
          title: "Runner location and cleanup",
          items: [
            "Installed and portable updates use an internal helper directory with versioned helper filenames.",
            "Startup acknowledgement removes the internal runner and any empty legacy sibling runner directory."
          ]
        },
        {
          title: "Installation safety and verification",
          items: [
            "Updates retain helper hashes, installation paths, and application data with strict cleanup boundaries.",
            "Installed and portable update tests cover helper startup, recovery, and update-file cleanup."
          ]
        }
      ]
    }
  },
  {
    version: "0.1.2",
    zh: {
      summary: "重做非系统盘归属扫描，深入识别安装应用、绿色便携应用及其应用数据，并修正受限目录统计。",
      sections: [
        {
          title: "深层扫描与识别",
          items: [
            "非系统盘递归扫描最多 8 层、60000 个目录，并显示扫描数量和截断状态。",
            "根据可执行文件、便携标记和 Steam 清单识别绿色应用与游戏。"
          ]
        },
        {
          title: "应用数据与受限路径",
          items: [
            "识别 data、config、profiles、saves、logs、userdata 等应用数据目录。",
            "不存在的标准目录不再误报为权限受限，旧浅层缓存自动失效。"
          ]
        }
      ]
    },
    en: {
      summary: "Rebuilt non-system-drive ownership discovery for installed apps, portable apps, and application data while correcting restricted-path reporting.",
      sections: [
        {
          title: "Deep scanning and identification",
          items: [
            "Non-system drives scan up to 8 levels and 60,000 directories with count and truncation reporting.",
            "Executables, portable markers, and Steam manifests identify unpacked applications and games."
          ]
        },
        {
          title: "Application data and restricted paths",
          items: [
            "Data, config, profiles, saves, logs, and userdata directories are associated with applications.",
            "Missing standard folders no longer report false access restrictions, and stale shallow caches are invalidated."
          ]
        }
      ]
    }
  },
  {
    version: "0.1.1",
    zh: {
      summary: "修复局部放大镜调节尺寸及滚轮缩放时的白屏、灰帧和抖动，并降低后台资源占用。",
      sections: [
        {
          title: "放大镜与滑杆",
          items: [
            "放大镜采用双缓冲画面交换，以鼠标为中心平滑缩放并隐藏放大的鼠标图标。",
            "尺寸滑杆只保存配置，松开后才同步最终宽高，修复拖动时整页白屏。"
          ]
        },
        {
          title: "常驻稳定性",
          items: [
            "全局监听增加单实例互斥，快捷键录入期间暂停监听。",
            "后台索引器降低优先级并收缩可回收工作集。"
          ]
        }
      ]
    },
    en: {
      summary: "Fixed blank, gray, and jumping desktop-lens frames during resizing and wheel zoom, while reducing background resource use.",
      sections: [
        {
          title: "Lens and sliders",
          items: [
            "Double-buffered frames zoom smoothly around the pointer and omit the magnified cursor.",
            "Size sliders only save configuration and synchronize final dimensions on release, fixing full-page blanking."
          ]
        },
        {
          title: "Resident stability",
          items: [
            "Global listeners use a single-instance guard and pause during shortcut recording.",
            "The background indexer lowers priority and trims reclaimable working-set pages."
          ]
        }
      ]
    }
  },
  {
    version: "0.1.0",
    zh: {
      summary: "加入 0–3000 毫秒鼠标触发滑杆、全应用字体缩放与跨程序的 Windows 局部放大镜。",
      sections: [
        {
          title: "鼠标与字体设置",
          items: [
            "鼠标触发时长调整为 0–3000 毫秒，0 毫秒可即时触发。",
            "全应用文字可在 50%–300% 范围内按 10% 步进调整，控件和布局保持原尺寸。"
          ]
        },
        {
          title: "全局局部放大镜",
          items: [
            "支持录入修饰键加滚轮的组合，在所有程序和显示器上以鼠标为中心放大。",
            "宽度和高度可独立设置，区域带边框并隐藏放大的鼠标图标。"
          ]
        }
      ]
    },
    en: {
      summary: "Added a 0–3000 ms mouse trigger slider, app-wide text sizing, and a cross-application Windows desktop lens.",
      sections: [
        {
          title: "Mouse and text settings",
          items: [
            "Mouse activation now spans 0–3000 milliseconds, including immediate activation at zero.",
            "App text scales from 50% to 300% in ten-percent steps without resizing controls or layout."
          ]
        },
        {
          title: "Global desktop lens",
          items: [
            "A recorded modifier-plus-wheel gesture magnifies around the pointer across applications and displays.",
            "Width and height are configurable independently, with a border and no magnified cursor icon."
          ]
        }
      ]
    }
  },
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
