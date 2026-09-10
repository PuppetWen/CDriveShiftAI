import { useCallback, useSyncExternalStore } from "react";
import type { AppLanguage } from "../types";

export interface LanguageOption {
  id: AppLanguage;
  nativeName: string;
  englishName: string;
  shortLabel: string;
}

export const languageOptions: readonly LanguageOption[] = [
  { id: "system", nativeName: "跟随系统", englishName: "Use system language", shortLabel: "AUTO" },
  { id: "zh-CN", nativeName: "简体中文", englishName: "Simplified Chinese", shortLabel: "简" },
  { id: "zh-TW", nativeName: "繁體中文", englishName: "Traditional Chinese", shortLabel: "繁" },
  { id: "en-US", nativeName: "English", englishName: "English", shortLabel: "EN" },
  { id: "ja-JP", nativeName: "日本語", englishName: "Japanese", shortLabel: "日" },
  { id: "ko-KR", nativeName: "한국어", englishName: "Korean", shortLabel: "한" },
  { id: "es-ES", nativeName: "Español", englishName: "Spanish", shortLabel: "ES" },
  { id: "fr-FR", nativeName: "Français", englishName: "French", shortLabel: "FR" },
  { id: "de-DE", nativeName: "Deutsch", englishName: "German", shortLabel: "DE" },
  { id: "pt-BR", nativeName: "Português (Brasil)", englishName: "Portuguese (Brazil)", shortLabel: "PT" },
  { id: "ru-RU", nativeName: "Русский", englishName: "Russian", shortLabel: "RU" },
  { id: "ar-SA", nativeName: "العربية", englishName: "Arabic", shortLabel: "AR" },
  { id: "hi-IN", nativeName: "हिन्दी", englishName: "Hindi", shortLabel: "HI" },
  { id: "id-ID", nativeName: "Bahasa Indonesia", englishName: "Indonesian", shortLabel: "ID" },
  { id: "it-IT", nativeName: "Italiano", englishName: "Italian", shortLabel: "IT" },
  { id: "tr-TR", nativeName: "Türkçe", englishName: "Turkish", shortLabel: "TR" }
];

type ResolvedLanguage = Exclude<AppLanguage, "system">;
type TranslationParameters = Record<string, string | number>;

const english = {
  "app.tagline": "Whole-disk search and safe AI-assisted migration",
  "nav.workbench": "Workspace",
  "nav.overview": "Space overview",
  "nav.search": "Fast search",
  "nav.ownership": "Disk ownership map",
  "nav.analyze": "AI ownership analysis",
  "nav.migrate": "Safe migration",
  "nav.history": "Migration history",
  "nav.settings": "Settings",
  "sidebar.expand": "Expand sidebar",
  "sidebar.collapse": "Collapse sidebar",
  "sidebar.mainNavigation": "Primary navigation",
  "sidebar.indexReady": "Index ready",
  "sidebar.indexBuilding": "Building index",
  "sidebar.entries": "{count} entries",
  "sidebar.indexPreparing": "Preparing first-party index",
  "sidebar.updateAvailable": "Version {latest} is available; current version is {current}. Open Settings to update.",
  "sidebar.updateStale": "Version {latest} was found earlier. This network recheck failed, but the known update remains available.",
  "sidebar.updateUnavailable": "Unable to check for updates: {message}. Open Settings for details.",
  "sidebar.updateCurrent": "Version {current} is up to date.",
  "sidebar.updateChecking": "Checking the GitHub Release version…",
  "top.indexReady": "First-party index · {mode}",
  "top.indexPreparing": "Preparing index",
  "top.aiEnabled": "AI: assisted",
  "top.aiLocal": "AI: local only",
  "top.aiEnabledTip": "AI assistance is enabled. Privacy settings control what is sent. Open settings.",
  "top.aiLocalTip": "Only local rules are active; no data is sent to an AI service. Configure AI.",
  "top.switchTheme": "Switch visual theme",
  "loading.page": "Opening feature",
  "loading.detail": "UI modules load on demand; indexes and stored data are not rebuilt.",
  "page.overviewTitle": "All drive space at a glance",
  "page.overviewDescription": "Find the data, identify its owner, then move it with a recoverable transaction.",
  "page.ownershipTitle": "Disk directory ownership map",
  "page.ownershipDescription": "Identify installations and application data across drive roots, application libraries, ProgramData, and the current user's AppData.",
  "page.analyzeTitle": "Who owns this directory?",
  "page.analyzeDescription": "Correlate installed apps and local evidence first, then use AI and web evidence only when confidence remains low.",
  "page.migrateTitle": "Free space without breaking the original path",
  "page.migrateDescription": "The path changes only after a complete copy and verification; failures restore the original directory.",
  "page.historyTitle": "Every move remains traceable",
  "page.historyDescription": "Persistent transaction records retain source, destination, link type, space, status, and recovery state.",
  "page.settingsTitle": "Set up CDriveShiftAI your way.",
  "page.settingsDescription": "Selections apply immediately; text fields are validated and saved when focus leaves them.",
  "settings.navigation": "Settings sections",
  "settings.module.update": "Updates & diagnostics",
  "settings.module.updateDescription": "Versions, update packages, and logs",
  "settings.module.appearance": "Appearance & language",
  "settings.module.appearanceDescription": "Language, themes, materials, and effects",
  "settings.module.system": "Index & shortcuts",
  "settings.module.systemDescription": "Indexing, background behavior, and global access",
  "settings.module.ai": "AI services",
  "settings.module.aiDescription": "Providers, models, and privacy",
  "settings.appearanceTitle": "Visual themes",
  "settings.appearanceDescription": "Five complete themes can be switched instantly.",
  "settings.languageTitle": "Application language",
  "settings.languageDescription": "Choose the language used by navigation, search, settings, window titles, and tray menus.",
  "settings.languageSearch": "Search languages",
  "settings.languageSystemOption": "Use system language",
  "settings.languageSystem": "Automatically follows the Windows display language ({language}).",
  "settings.languageFallback": "Untranslated text falls back to English instead of mixing with another language.",
  "settings.languageApplied": "Language changed to {language}",
  "settings.languageCount": "15 languages plus the system option",
  "settings.updateTitle": "Application updates",
  "settings.updateDescription": "Resumable downloads and two-pass SHA-512 verification; failures retain and restore the previous version.",
  "settings.currentVersion": "Current version",
  "settings.latestVersion": "Latest version",
  "settings.status": "Status",
  "settings.fetching": "Fetching…",
  "settings.updateIdle": "Checks once when the window opens; no repeated background polling.",
  "settings.portableUpdate": "Portable in-place replacement",
  "settings.installedUpdate": "Silent installed-app update",
  "settings.developmentMode": "Development mode",
  "settings.publishedAt": "Published {date}",
  "settings.checking": "Checking…",
  "settings.recheck": "Check again",
  "settings.retryUpdate": "Resume and retry",
  "settings.autoUpdate": "Download and update",
  "settings.pauseDownload": "Pause download",
  "settings.manualDownload": "Manual download",
  "settings.viewRelease": "View Release",
  "settings.releaseContent": "Version changes",
  "settings.thisUpdate": "What’s new",
  "settings.currentReleaseNotes": "Current version notes",
  "settings.fullReleaseNotes": "Full notes",
  "settings.releaseModules": "Update sections",
  "settings.diagnosticsTitle": "Runtime diagnostics",
  "settings.diagnosticsDescription": "Crash, update, and index lifecycle events are stored locally; API keys, search terms, and file contents are excluded.",
  "settings.diagnosticsError": "The update failure was logged. Export a report to diagnose local environment or permission issues.",
  "settings.openLogs": "Open log folder",
  "settings.exportDiagnostics": "Export diagnostic report",
  "settings.exportingDiagnostics": "Preparing…",
  "settings.updatePackage": "CDriveShiftAI update package",
  "settings.updatePhase.download": "Download package",
  "settings.updatePhase.verify": "Verify package",
  "settings.updatePhase.prepare": "Prepare replacement",
  "settings.updatePhase.install": "Safe update",
  "settings.updatePhase.paused": "Download paused",
  "settings.updatePhase.failed": "Update incomplete",
  "settings.updateRestart": "Restarting soon",
  "settings.updateStage.download": "Download",
  "settings.updateStage.verify": "Verify",
  "settings.updateStage.backup": "Backup",
  "settings.updateStage.replace": "Replace",
  "settings.updateStage.cleanup": "Clean up",
  "settings.updateAttempt": "Attempt {current}/{total}",
  "settings.shaVerifying": "Running SHA-512 verification",
  "quick.title": "CDriveShiftAI · Quick Search",
  "quick.indexEntries": "{count} indexed",
  "quick.indexPreparing": "Preparing index",
  "quick.switchTheme": "Switch interface theme",
  "quick.handoff": "Search, filters, regex, bookmarks, properties, and context actions are shared with the main app. Analyze or Migrate continues in the main window.",
  "search.nameMode": "Name search",
  "search.nameModeDescription": "Combine filters across all disks",
  "search.contentMode": "Content search",
  "search.contentModeDescription": "Full text in a selected directory",
  "search.chooseContentDirectory": "Choose content-index directory",
  "search.clearContentDirectory": "Clear selected directory",
  "search.fileTypes": "File types",
  "search.location": "Search location",
  "search.allComputer": "All drives",
  "search.entireComputer": "Entire computer",
  "search.matchMode": "Match mode",
  "search.sortAndProperties": "Sort & properties",
  "search.moreConditions": "More filters",
  "search.category.folder": "Folders",
  "search.category.document": "Documents",
  "search.category.image": "Images",
  "search.category.video": "Videos",
  "search.category.audio": "Audio",
  "search.category.archive": "Archives",
  "search.category.executable": "Programs",
  "search.category.code": "Code",
  "search.category.other": "Other",
  "search.category.all": "All",
  "search.match.contains": "Contains",
  "search.match.whole": "Whole word",
  "search.match.fuzzy": "Fuzzy",
  "search.match.regex": "Regular expression",
  "search.match.containsDetail": "The query appears continuously in the name",
  "search.match.wholeDetail": "Match only an independent complete word",
  "search.match.fuzzyDetail": "Smart match in character order",
  "search.match.regexDetail": "Use regular expression rules",
  "search.sort.relevance": "Relevance",
  "search.sort.name": "Name",
  "search.sort.path": "Path",
  "search.sort.size": "Size",
  "search.sort.modified": "Modified",
  "search.sort.type": "Type",
  "search.sortBy": "Sort by {field}",
  "search.emptyNameTitle": "Type a name to search the entire computer",
  "search.emptyContentTitle": "Search file contents in a selected directory",
  "effect.aurora.label": "Pixel",
  "effect.aurora.title": "Pixel Lake",
  "effect.aurora.subtitle": "Lake and hills · stepped motion",
  "effect.matrix.label": "Tech",
  "effect.matrix.title": "Future Hub",
  "effect.matrix.subtitle": "Holographic grid · data pulses",
  "effect.calm.label": "Crystal",
  "effect.calm.title": "Moonlit Crystal",
  "effect.calm.subtitle": "Frosted glass · soft glow",
  "effect.ember.label": "Ember",
  "effect.ember.title": "Ember Hive",
  "effect.ember.subtitle": "Orange facets · hive pulses",
  "effect.ivory.label": "Ivory",
  "effect.ivory.title": "Warm Ivory",
  "effect.ivory.subtitle": "Warm paper · terracotta shadow",
  "general.unknown": "Unknown",
  "general.close": "Close"
} as const;

export type TranslationKey = keyof typeof english;
type TranslationTable = Partial<Record<TranslationKey, string>>;

const zhCN: TranslationTable = {
  "app.tagline": "全盘 AI 智迁",
  "nav.workbench": "工作台",
  "nav.overview": "空间总览",
  "nav.search": "极速搜索",
  "nav.ownership": "磁盘归属地图",
  "nav.analyze": "AI 归属分析",
  "nav.migrate": "安全迁移",
  "nav.history": "迁移记录",
  "nav.settings": "设置",
  "sidebar.expand": "展开侧边栏",
  "sidebar.collapse": "折叠侧边栏",
  "sidebar.mainNavigation": "主要导航",
  "sidebar.indexReady": "索引已就绪",
  "sidebar.indexBuilding": "索引构建中",
  "sidebar.entries": "{count} 个条目",
  "sidebar.indexPreparing": "准备自研索引",
  "sidebar.updateAvailable": "发现新版本 v{latest}；当前为 v{current}。点击进入设置更新。",
  "sidebar.updateStale": "已检测到新版本 v{latest}；本次联网复查失败，但不会清除已确认的更新。",
  "sidebar.updateUnavailable": "暂时无法检查版本：{message}。点击进入设置查看。",
  "sidebar.updateCurrent": "当前版本 v{current}，已是最新版本。",
  "sidebar.updateChecking": "正在检查 GitHub Release 版本…",
  "top.indexReady": "自研索引 · {mode}",
  "top.indexPreparing": "正在准备索引",
  "top.aiEnabled": "AI：辅助分析",
  "top.aiLocal": "AI：仅本地",
  "top.aiEnabledTip": "AI 辅助已启用；发送范围由隐私设置控制。点击查看设置。",
  "top.aiLocalTip": "当前仅使用本地规则分析，不会向 AI 服务发送数据。点击配置 AI。",
  "top.switchTheme": "即时切换场景特效",
  "loading.page": "正在打开功能页面",
  "loading.detail": "界面模块按需载入，索引和数据不会重新构建。",
  "page.overviewTitle": "全盘空间，一目了然",
  "page.overviewDescription": "先找数据，再识别归属；通过可恢复事务迁往其他磁盘。",
  "page.ownershipTitle": "磁盘目录归属地图",
  "page.ownershipDescription": "识别盘符根目录、应用库、ProgramData 和当前用户 AppData 中的安装目录与应用数据。",
  "page.analyzeTitle": "这个目录，属于谁？",
  "page.analyzeDescription": "先核对已安装应用和本地证据，只有低可信结果才使用 AI 与网络补证。",
  "page.migrateTitle": "释放当前磁盘空间，不影响程序使用",
  "page.migrateDescription": "完整复制与校验通过后才切换路径；失败会恢复原目录。",
  "page.historyTitle": "每一次移动，都有迹可循。",
  "page.historyDescription": "事务记录持久保存源盘、目标盘、链接类型、空间、状态和恢复信息。",
  "page.settingsTitle": "按你的习惯设置 CDriveShiftAI。",
  "page.settingsDescription": "选择项即时生效，输入项在离开焦点后自动校验并保存。",
  "settings.navigation": "设置模块",
  "settings.module.update": "更新与诊断",
  "settings.module.updateDescription": "版本、更新包与日志",
  "settings.module.appearance": "界面与语言",
  "settings.module.appearanceDescription": "语言、主题、材质与交互效果",
  "settings.module.system": "索引与快捷操作",
  "settings.module.systemDescription": "索引、后台与全局唤起",
  "settings.module.ai": "AI 服务",
  "settings.module.aiDescription": "厂商、模型与隐私",
  "settings.appearanceTitle": "视觉特效",
  "settings.appearanceDescription": "五套完整背景与材质效果，可即时切换。",
  "settings.languageTitle": "应用语言",
  "settings.languageDescription": "统一切换导航、搜索、设置、窗口标题和托盘菜单的显示语言。",
  "settings.languageSearch": "搜索语言",
  "settings.languageSystemOption": "跟随系统",
  "settings.languageSystem": "自动跟随 Windows 显示语言（{language}）。",
  "settings.languageFallback": "尚未翻译的词条统一回退英文，避免混入其他语言。",
  "settings.languageApplied": "界面语言已切换为 {language}",
  "settings.languageCount": "15 种语言及跟随系统选项",
  "settings.updateTitle": "应用更新",
  "settings.updateDescription": "自动续传、SHA-512 双重校验；失败时保留并恢复旧版本。",
  "settings.currentVersion": "当前版本",
  "settings.latestVersion": "最新版本",
  "settings.status": "状态",
  "settings.fetching": "正在获取…",
  "settings.updateIdle": "打开界面后自动检查，不在后台循环请求。",
  "settings.portableUpdate": "便携版原路径替换",
  "settings.installedUpdate": "安装版静默更新",
  "settings.developmentMode": "开发模式",
  "settings.publishedAt": "发布于 {date}",
  "settings.checking": "检查中…",
  "settings.recheck": "重新检查",
  "settings.retryUpdate": "续传并重试",
  "settings.autoUpdate": "下载并自动更新",
  "settings.pauseDownload": "暂停下载",
  "settings.manualDownload": "手动下载",
  "settings.viewRelease": "查看 Release",
  "settings.releaseContent": "版本更新内容",
  "settings.thisUpdate": "本次更新",
  "settings.currentReleaseNotes": "当前版本说明",
  "settings.fullReleaseNotes": "完整说明",
  "settings.releaseModules": "更新模块",
  "settings.diagnosticsTitle": "运行诊断",
  "settings.diagnosticsDescription": "本地记录崩溃、更新和索引生命周期；不会写入 API Key、搜索词或文件正文。",
  "settings.diagnosticsError": "更新失败已写入日志；导出报告发给开发者即可定位环境与权限问题。",
  "settings.openLogs": "打开日志目录",
  "settings.exportDiagnostics": "导出诊断报告",
  "settings.exportingDiagnostics": "正在整理…",
  "settings.updatePackage": "CDriveShiftAI 更新包",
  "settings.updatePhase.download": "下载更新包",
  "settings.updatePhase.verify": "验证更新包",
  "settings.updatePhase.prepare": "准备替换",
  "settings.updatePhase.install": "安全更新",
  "settings.updatePhase.paused": "下载已暂停",
  "settings.updatePhase.failed": "更新未完成",
  "settings.updateRestart": "即将重启",
  "settings.updateStage.download": "下载",
  "settings.updateStage.verify": "校验",
  "settings.updateStage.backup": "备份",
  "settings.updateStage.replace": "替换",
  "settings.updateStage.cleanup": "清理",
  "settings.updateAttempt": "尝试 {current}/{total}",
  "settings.shaVerifying": "正在执行 SHA-512 校验",
  "quick.title": "CDriveShiftAI · 独立极速搜索",
  "quick.indexEntries": "{count} 条索引",
  "quick.indexPreparing": "正在准备索引",
  "quick.switchTheme": "切换界面主题",
  "quick.handoff": "搜索、筛选、正则、书签、属性与右键功能和主程序共用；分析或迁移会接续到主窗口。",
  "search.nameMode": "名称搜索",
  "search.nameModeDescription": "全盘组合筛选",
  "search.contentMode": "内容搜索",
  "search.contentModeDescription": "指定目录全文",
  "search.chooseContentDirectory": "选择内容索引目录",
  "search.clearContentDirectory": "清除已选目录",
  "search.fileTypes": "文件类型",
  "search.location": "搜索位置",
  "search.allComputer": "全电脑",
  "search.entireComputer": "整个电脑",
  "search.matchMode": "匹配方式",
  "search.sortAndProperties": "排序与属性",
  "search.moreConditions": "更多条件",
  "search.category.folder": "文件夹",
  "search.category.document": "文档",
  "search.category.image": "图片",
  "search.category.video": "视频",
  "search.category.audio": "音频",
  "search.category.archive": "压缩包",
  "search.category.executable": "程序",
  "search.category.code": "代码",
  "search.category.other": "其他",
  "search.category.all": "全部",
  "search.match.contains": "包含匹配",
  "search.match.whole": "完整词匹配",
  "search.match.fuzzy": "模糊匹配",
  "search.match.regex": "正则匹配",
  "search.match.containsDetail": "关键词连续出现在名称中",
  "search.match.wholeDetail": "只匹配独立完整词",
  "search.match.fuzzyDetail": "按字符顺序智能匹配",
  "search.match.regexDetail": "使用正则表达式规则",
  "search.sort.relevance": "相关度",
  "search.sort.name": "名称",
  "search.sort.path": "路径",
  "search.sort.size": "大小",
  "search.sort.modified": "修改时间",
  "search.sort.type": "类型",
  "search.sortBy": "按{field}排序",
  "search.emptyNameTitle": "整个电脑的名字，输入即出现",
  "search.emptyContentTitle": "在指定目录里，搜索文件正文",
  "effect.aurora.label": "方块",
  "effect.aurora.title": "像素湖境",
  "effect.aurora.subtitle": "湖光远山 · 阶梯动画",
  "effect.matrix.label": "科技",
  "effect.matrix.title": "未来中枢",
  "effect.matrix.subtitle": "全息网格 · 数据脉冲",
  "effect.calm.label": "晶境",
  "effect.calm.title": "月白晶境",
  "effect.calm.subtitle": "雾面玻璃 · 柔和微光",
  "effect.ember.label": "熔橙",
  "effect.ember.title": "熔芯蜂巢",
  "effect.ember.subtitle": "橙黑切面 · 蜂巢脉冲",
  "effect.ivory.label": "暖瓷",
  "effect.ivory.title": "暖瓷晨光",
  "effect.ivory.subtitle": "米白纸感 · 陶土柔影",
  "general.unknown": "未知",
  "general.close": "关闭"
};

const zhTW: TranslationTable = {
  ...zhCN,
  "app.tagline": "全碟 AI 智慧搬移",
  "nav.workbench": "工作區",
  "nav.overview": "空間總覽",
  "nav.search": "快速搜尋",
  "nav.ownership": "磁碟歸屬地圖",
  "nav.analyze": "AI 歸屬分析",
  "nav.migrate": "安全搬移",
  "nav.history": "搬移記錄",
  "nav.settings": "設定",
  "sidebar.indexReady": "索引已就緒",
  "sidebar.indexBuilding": "正在建立索引",
  "sidebar.entries": "{count} 個項目",
  "page.overviewTitle": "全碟空間，一目了然",
  "page.ownershipTitle": "磁碟目錄歸屬地圖",
  "page.analyzeTitle": "這個目錄屬於誰？",
  "page.migrateTitle": "釋放目前磁碟空間，不影響程式使用",
  "page.historyTitle": "每次搬移都有跡可循。",
  "page.settingsTitle": "依照你的習慣設定 CDriveShiftAI。",
  "settings.module.update": "更新與診斷",
  "settings.module.appearance": "介面與語言",
  "settings.module.system": "索引與快捷操作",
  "settings.languageTitle": "應用程式語言",
  "settings.languageDescription": "統一切換主視窗、獨立搜尋、對話方塊與系統匣選單的顯示語言。",
  "settings.languageApplied": "介面語言已切換為 {language}",
  "quick.title": "CDriveShiftAI · 獨立快速搜尋"
};

const compactTranslations: Record<ResolvedLanguage, TranslationTable> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  "en-US": {},
  "ja-JP": {
    "app.tagline": "全ドライブ検索と安全な AI 移行",
    "nav.workbench": "ワークスペース", "nav.overview": "容量概要", "nav.search": "高速検索", "nav.ownership": "ディスク所有マップ", "nav.analyze": "AI 所有分析", "nav.migrate": "安全な移行", "nav.history": "移行履歴", "nav.settings": "設定",
    "sidebar.indexReady": "インデックス準備完了", "sidebar.indexBuilding": "インデックスを作成中", "sidebar.entries": "{count} 件", "top.indexPreparing": "インデックスを準備中",
    "page.overviewTitle": "全ドライブの容量を一目で確認", "page.ownershipTitle": "ディレクトリ所有マップ", "page.analyzeTitle": "このディレクトリの所有者は？", "page.migrateTitle": "元のパスを保ったまま空き容量を確保", "page.historyTitle": "すべての移動を追跡", "page.settingsTitle": "CDriveShiftAI を好みに合わせて設定。",
    "settings.module.update": "更新と診断", "settings.module.appearance": "外観と言語", "settings.module.system": "インデックスとショートカット", "settings.module.ai": "AI サービス", "settings.languageTitle": "アプリの言語", "settings.languageDescription": "メイン画面、クイック検索、ダイアログ、トレイメニューの言語を選択します。", "settings.languageApplied": "言語を {language} に変更しました", "quick.title": "CDriveShiftAI · クイック検索"
  },
  "ko-KR": {
    "app.tagline": "전체 디스크 검색과 안전한 AI 마이그레이션",
    "nav.workbench": "작업 공간", "nav.overview": "공간 개요", "nav.search": "빠른 검색", "nav.ownership": "디스크 소유권 지도", "nav.analyze": "AI 소유권 분석", "nav.migrate": "안전한 이동", "nav.history": "이동 기록", "nav.settings": "설정",
    "sidebar.indexReady": "인덱스 준비 완료", "sidebar.indexBuilding": "인덱스 생성 중", "sidebar.entries": "{count}개 항목", "page.overviewTitle": "모든 드라이브 공간을 한눈에", "page.ownershipTitle": "디렉터리 소유권 지도", "page.analyzeTitle": "이 디렉터리의 소유자는?", "page.migrateTitle": "원래 경로를 유지하며 공간 확보", "page.historyTitle": "모든 이동을 추적", "page.settingsTitle": "원하는 방식으로 CDriveShiftAI 설정",
    "settings.module.update": "업데이트 및 진단", "settings.module.appearance": "화면 및 언어", "settings.module.system": "인덱스 및 바로가기", "settings.module.ai": "AI 서비스", "settings.languageTitle": "앱 언어", "settings.languageDescription": "메인 창, 빠른 검색, 대화 상자 및 트레이 메뉴의 언어를 선택합니다.", "settings.languageApplied": "언어가 {language}(으)로 변경되었습니다", "quick.title": "CDriveShiftAI · 빠른 검색"
  },
  "es-ES": {
    "app.tagline": "Búsqueda en todos los discos y migración segura con IA",
    "nav.workbench": "Espacio de trabajo", "nav.overview": "Resumen de espacio", "nav.search": "Búsqueda rápida", "nav.ownership": "Mapa de propiedad", "nav.analyze": "Análisis con IA", "nav.migrate": "Migración segura", "nav.history": "Historial", "nav.settings": "Configuración",
    "sidebar.indexReady": "Índice listo", "sidebar.indexBuilding": "Creando índice", "sidebar.entries": "{count} elementos", "page.overviewTitle": "Todo el espacio de tus discos de un vistazo", "page.ownershipTitle": "Mapa de propiedad de directorios", "page.analyzeTitle": "¿A quién pertenece este directorio?", "page.migrateTitle": "Libera espacio sin cambiar la ruta original", "page.historyTitle": "Cada movimiento queda registrado", "page.settingsTitle": "Configura CDriveShiftAI a tu manera.",
    "settings.module.update": "Actualizaciones y diagnóstico", "settings.module.appearance": "Apariencia e idioma", "settings.module.system": "Índice y atajos", "settings.module.ai": "Servicios de IA", "settings.languageTitle": "Idioma de la aplicación", "settings.languageDescription": "Elige el idioma de la ventana principal, búsqueda rápida, diálogos y menú de bandeja.", "settings.languageApplied": "Idioma cambiado a {language}", "quick.title": "CDriveShiftAI · Búsqueda rápida"
  },
  "fr-FR": {
    "app.tagline": "Recherche sur tous les disques et migration IA sécurisée",
    "nav.workbench": "Espace de travail", "nav.overview": "Vue de l’espace", "nav.search": "Recherche rapide", "nav.ownership": "Carte d’appartenance", "nav.analyze": "Analyse par IA", "nav.migrate": "Migration sécurisée", "nav.history": "Historique", "nav.settings": "Paramètres",
    "sidebar.indexReady": "Index prêt", "sidebar.indexBuilding": "Création de l’index", "sidebar.entries": "{count} éléments", "page.overviewTitle": "Tout l’espace disque en un coup d’œil", "page.ownershipTitle": "Carte d’appartenance des dossiers", "page.analyzeTitle": "À qui appartient ce dossier ?", "page.migrateTitle": "Libérez de l’espace sans changer le chemin d’origine", "page.historyTitle": "Chaque déplacement reste traçable", "page.settingsTitle": "Configurez CDriveShiftAI à votre façon.",
    "settings.module.update": "Mises à jour et diagnostic", "settings.module.appearance": "Apparence et langue", "settings.module.system": "Index et raccourcis", "settings.module.ai": "Services IA", "settings.languageTitle": "Langue de l’application", "settings.languageDescription": "Choisissez la langue de la fenêtre principale, de la recherche rapide, des dialogues et du menu de zone de notification.", "settings.languageApplied": "Langue remplacée par {language}", "quick.title": "CDriveShiftAI · Recherche rapide"
  },
  "de-DE": {
    "app.tagline": "Laufwerksweite Suche und sichere KI-Migration",
    "nav.workbench": "Arbeitsbereich", "nav.overview": "Speicherübersicht", "nav.search": "Schnellsuche", "nav.ownership": "Zuordnungskarte", "nav.analyze": "KI-Zuordnungsanalyse", "nav.migrate": "Sichere Migration", "nav.history": "Migrationsverlauf", "nav.settings": "Einstellungen",
    "sidebar.indexReady": "Index bereit", "sidebar.indexBuilding": "Index wird erstellt", "sidebar.entries": "{count} Einträge", "page.overviewTitle": "Alle Laufwerke auf einen Blick", "page.ownershipTitle": "Verzeichnis-Zuordnungskarte", "page.analyzeTitle": "Wem gehört dieses Verzeichnis?", "page.migrateTitle": "Speicher freigeben, Originalpfad beibehalten", "page.historyTitle": "Jede Verschiebung bleibt nachvollziehbar", "page.settingsTitle": "CDriveShiftAI nach Ihren Wünschen einrichten.",
    "settings.module.update": "Updates und Diagnose", "settings.module.appearance": "Darstellung und Sprache", "settings.module.system": "Index und Tastenkürzel", "settings.module.ai": "KI-Dienste", "settings.languageTitle": "Anwendungssprache", "settings.languageDescription": "Wählen Sie die Sprache für Hauptfenster, Schnellsuche, Dialoge und Infobereichsmenü.", "settings.languageApplied": "Sprache auf {language} geändert", "quick.title": "CDriveShiftAI · Schnellsuche"
  },
  "pt-BR": {
    "app.tagline": "Busca em todos os discos e migração segura com IA",
    "nav.workbench": "Área de trabalho", "nav.overview": "Visão do espaço", "nav.search": "Busca rápida", "nav.ownership": "Mapa de propriedade", "nav.analyze": "Análise por IA", "nav.migrate": "Migração segura", "nav.history": "Histórico", "nav.settings": "Configurações",
    "sidebar.indexReady": "Índice pronto", "sidebar.indexBuilding": "Criando índice", "sidebar.entries": "{count} itens", "page.overviewTitle": "Todo o espaço dos discos em um só lugar", "page.ownershipTitle": "Mapa de propriedade de diretórios", "page.analyzeTitle": "A quem pertence este diretório?", "page.migrateTitle": "Libere espaço mantendo o caminho original", "page.historyTitle": "Cada movimentação fica registrada", "page.settingsTitle": "Configure o CDriveShiftAI do seu jeito.",
    "settings.module.update": "Atualizações e diagnóstico", "settings.module.appearance": "Aparência e idioma", "settings.module.system": "Índice e atalhos", "settings.module.ai": "Serviços de IA", "settings.languageTitle": "Idioma do aplicativo", "settings.languageDescription": "Escolha o idioma da janela principal, busca rápida, caixas de diálogo e menu da bandeja.", "settings.languageApplied": "Idioma alterado para {language}", "quick.title": "CDriveShiftAI · Busca rápida"
  },
  "ru-RU": {
    "app.tagline": "Поиск по всем дискам и безопасный перенос с ИИ",
    "nav.workbench": "Рабочая область", "nav.overview": "Обзор места", "nav.search": "Быстрый поиск", "nav.ownership": "Карта принадлежности", "nav.analyze": "Анализ с ИИ", "nav.migrate": "Безопасный перенос", "nav.history": "История", "nav.settings": "Настройки",
    "sidebar.indexReady": "Индекс готов", "sidebar.indexBuilding": "Создание индекса", "sidebar.entries": "Записей: {count}", "page.overviewTitle": "Все диски как на ладони", "page.ownershipTitle": "Карта принадлежности каталогов", "page.analyzeTitle": "Кому принадлежит этот каталог?", "page.migrateTitle": "Освободите место, сохранив исходный путь", "page.historyTitle": "Каждое перемещение отслеживается", "page.settingsTitle": "Настройте CDriveShiftAI под себя.",
    "settings.module.update": "Обновления и диагностика", "settings.module.appearance": "Оформление и язык", "settings.module.system": "Индекс и сочетания клавиш", "settings.module.ai": "Сервисы ИИ", "settings.languageTitle": "Язык приложения", "settings.languageDescription": "Выберите язык главного окна, быстрого поиска, диалогов и меню в трее.", "settings.languageApplied": "Язык изменён на {language}", "quick.title": "CDriveShiftAI · Быстрый поиск"
  },
  "ar-SA": {
    "app.tagline": "بحث في جميع الأقراص ونقل آمن بمساعدة الذكاء الاصطناعي",
    "nav.workbench": "مساحة العمل", "nav.overview": "نظرة على المساحة", "nav.search": "بحث سريع", "nav.ownership": "خريطة ملكية القرص", "nav.analyze": "تحليل الملكية بالذكاء الاصطناعي", "nav.migrate": "نقل آمن", "nav.history": "سجل النقل", "nav.settings": "الإعدادات",
    "sidebar.indexReady": "الفهرس جاهز", "sidebar.indexBuilding": "جارٍ إنشاء الفهرس", "sidebar.entries": "{count} عنصر", "page.overviewTitle": "كل مساحة الأقراص بنظرة واحدة", "page.ownershipTitle": "خريطة ملكية المجلدات", "page.analyzeTitle": "لمن ينتمي هذا المجلد؟", "page.migrateTitle": "حرّر المساحة مع إبقاء المسار الأصلي", "page.historyTitle": "كل عملية نقل قابلة للتتبع", "page.settingsTitle": "اضبط CDriveShiftAI بالطريقة التي تناسبك.",
    "settings.module.update": "التحديثات والتشخيص", "settings.module.appearance": "المظهر واللغة", "settings.module.system": "الفهرس والاختصارات", "settings.module.ai": "خدمات الذكاء الاصطناعي", "settings.languageTitle": "لغة التطبيق", "settings.languageDescription": "اختر لغة النافذة الرئيسية والبحث السريع ومربعات الحوار وقائمة شريط النظام.", "settings.languageApplied": "تم تغيير اللغة إلى {language}", "quick.title": "CDriveShiftAI · بحث سريع"
  },
  "hi-IN": {
    "app.tagline": "सभी डिस्क में खोज और सुरक्षित AI माइग्रेशन",
    "nav.workbench": "कार्यस्थान", "nav.overview": "स्थान अवलोकन", "nav.search": "तेज़ खोज", "nav.ownership": "डिस्क स्वामित्व मानचित्र", "nav.analyze": "AI स्वामित्व विश्लेषण", "nav.migrate": "सुरक्षित माइग्रेशन", "nav.history": "माइग्रेशन इतिहास", "nav.settings": "सेटिंग्स",
    "sidebar.indexReady": "इंडेक्स तैयार", "sidebar.indexBuilding": "इंडेक्स बन रहा है", "sidebar.entries": "{count} प्रविष्टियाँ", "page.overviewTitle": "सभी ड्राइव का स्थान एक नज़र में", "page.ownershipTitle": "डायरेक्टरी स्वामित्व मानचित्र", "page.analyzeTitle": "यह डायरेक्टरी किसकी है?", "page.migrateTitle": "मूल पथ बनाए रखते हुए स्थान खाली करें", "page.historyTitle": "हर स्थानांतरण का रिकॉर्ड", "page.settingsTitle": "CDriveShiftAI को अपने तरीके से सेट करें।",
    "settings.module.update": "अपडेट और निदान", "settings.module.appearance": "रूप और भाषा", "settings.module.system": "इंडेक्स और शॉर्टकट", "settings.module.ai": "AI सेवाएँ", "settings.languageTitle": "ऐप की भाषा", "settings.languageDescription": "मुख्य विंडो, त्वरित खोज, संवाद और ट्रे मेनू की भाषा चुनें।", "settings.languageApplied": "भाषा {language} में बदली गई", "quick.title": "CDriveShiftAI · त्वरित खोज"
  },
  "id-ID": {
    "app.tagline": "Pencarian seluruh disk dan migrasi AI yang aman",
    "nav.workbench": "Ruang kerja", "nav.overview": "Ringkasan ruang", "nav.search": "Pencarian cepat", "nav.ownership": "Peta kepemilikan", "nav.analyze": "Analisis AI", "nav.migrate": "Migrasi aman", "nav.history": "Riwayat migrasi", "nav.settings": "Pengaturan",
    "sidebar.indexReady": "Indeks siap", "sidebar.indexBuilding": "Membangun indeks", "sidebar.entries": "{count} entri", "page.overviewTitle": "Semua ruang disk dalam satu tampilan", "page.ownershipTitle": "Peta kepemilikan direktori", "page.analyzeTitle": "Milik siapa direktori ini?", "page.migrateTitle": "Kosongkan ruang tanpa mengubah jalur asli", "page.historyTitle": "Setiap perpindahan dapat dilacak", "page.settingsTitle": "Atur CDriveShiftAI sesuai kebiasaan Anda.",
    "settings.module.update": "Pembaruan dan diagnostik", "settings.module.appearance": "Tampilan dan bahasa", "settings.module.system": "Indeks dan pintasan", "settings.module.ai": "Layanan AI", "settings.languageTitle": "Bahasa aplikasi", "settings.languageDescription": "Pilih bahasa untuk jendela utama, pencarian cepat, dialog, dan menu tray.", "settings.languageApplied": "Bahasa diubah ke {language}", "quick.title": "CDriveShiftAI · Pencarian cepat"
  },
  "it-IT": {
    "app.tagline": "Ricerca su tutti i dischi e migrazione IA sicura",
    "nav.workbench": "Area di lavoro", "nav.overview": "Panoramica spazio", "nav.search": "Ricerca rapida", "nav.ownership": "Mappa proprietà", "nav.analyze": "Analisi IA", "nav.migrate": "Migrazione sicura", "nav.history": "Cronologia", "nav.settings": "Impostazioni",
    "sidebar.indexReady": "Indice pronto", "sidebar.indexBuilding": "Creazione indice", "sidebar.entries": "{count} elementi", "page.overviewTitle": "Tutto lo spazio dei dischi a colpo d’occhio", "page.ownershipTitle": "Mappa proprietà delle cartelle", "page.analyzeTitle": "A chi appartiene questa cartella?", "page.migrateTitle": "Libera spazio mantenendo il percorso originale", "page.historyTitle": "Ogni spostamento resta tracciabile", "page.settingsTitle": "Configura CDriveShiftAI come preferisci.",
    "settings.module.update": "Aggiornamenti e diagnostica", "settings.module.appearance": "Aspetto e lingua", "settings.module.system": "Indice e scorciatoie", "settings.module.ai": "Servizi IA", "settings.languageTitle": "Lingua dell’app", "settings.languageDescription": "Scegli la lingua della finestra principale, ricerca rapida, finestre di dialogo e menu dell’area di notifica.", "settings.languageApplied": "Lingua cambiata in {language}", "quick.title": "CDriveShiftAI · Ricerca rapida"
  },
  "tr-TR": {
    "app.tagline": "Tüm disklerde arama ve güvenli yapay zekâ taşıması",
    "nav.workbench": "Çalışma alanı", "nav.overview": "Alan özeti", "nav.search": "Hızlı arama", "nav.ownership": "Sahiplik haritası", "nav.analyze": "Yapay zekâ analizi", "nav.migrate": "Güvenli taşıma", "nav.history": "Taşıma geçmişi", "nav.settings": "Ayarlar",
    "sidebar.indexReady": "Dizin hazır", "sidebar.indexBuilding": "Dizin oluşturuluyor", "sidebar.entries": "{count} öğe", "page.overviewTitle": "Tüm disk alanı tek bakışta", "page.ownershipTitle": "Dizin sahiplik haritası", "page.analyzeTitle": "Bu dizin kime ait?", "page.migrateTitle": "Özgün yolu koruyarak alan açın", "page.historyTitle": "Her taşıma izlenebilir", "page.settingsTitle": "CDriveShiftAI'ı istediğiniz gibi ayarlayın.",
    "settings.module.update": "Güncellemeler ve tanılama", "settings.module.appearance": "Görünüm ve dil", "settings.module.system": "Dizin ve kısayollar", "settings.module.ai": "Yapay zekâ hizmetleri", "settings.languageTitle": "Uygulama dili", "settings.languageDescription": "Ana pencere, hızlı arama, iletişim kutuları ve tepsi menüsünün dilini seçin.", "settings.languageApplied": "Dil {language} olarak değiştirildi", "quick.title": "CDriveShiftAI · Hızlı arama"
  }
};

const storageKey = "cdriveshiftai-language";
const supportedLanguages = new Set<AppLanguage>(languageOptions.map((item) => item.id));

function resolveSystemLanguage(): ResolvedLanguage {
  const candidate = typeof navigator === "undefined" ? "en-US" : navigator.language;
  const normalized = candidate.toLowerCase();
  if (normalized.startsWith("zh-hant") || ["zh-tw", "zh-hk", "zh-mo"].includes(normalized)) return "zh-TW";
  if (normalized.startsWith("zh")) return "zh-CN";
  const exact = languageOptions.find((item) => item.id !== "system" && item.id.toLowerCase() === normalized);
  if (exact) return exact.id as ResolvedLanguage;
  const prefix = normalized.split("-")[0];
  const matched = languageOptions.find((item) => item.id !== "system" && item.id.toLowerCase().startsWith(`${prefix}-`));
  return (matched?.id as ResolvedLanguage | undefined) ?? "en-US";
}

function storedLanguage(): AppLanguage {
  try {
    const value = globalThis.localStorage?.getItem(storageKey);
    return value && supportedLanguages.has(value as AppLanguage) ? (value as AppLanguage) : "zh-CN";
  } catch {
    return "zh-CN";
  }
}

let selectedLanguage = storedLanguage();
let revision = 0;
const listeners = new Set<() => void>();

export function resolvedLanguage(language: AppLanguage = selectedLanguage): ResolvedLanguage {
  return language === "system" ? resolveSystemLanguage() : language;
}

function applyDocumentLanguage(): void {
  if (typeof document === "undefined") return;
  const resolved = resolvedLanguage();
  document.documentElement.lang = resolved;
  document.documentElement.dir = resolved === "ar-SA" ? "rtl" : "ltr";
  document.documentElement.dataset.language = resolved;
}

export function setAppLanguage(language: AppLanguage): void {
  const next = supportedLanguages.has(language) ? language : "en-US";
  if (next === selectedLanguage) {
    applyDocumentLanguage();
    return;
  }
  selectedLanguage = next;
  try {
    globalThis.localStorage?.setItem(storageKey, next);
  } catch {
    // The persisted main-process setting remains authoritative when storage is unavailable.
  }
  applyDocumentLanguage();
  revision += 1;
  for (const listener of listeners) listener();
}

export function getAppLanguage(): AppLanguage {
  return selectedLanguage;
}

export function translate(
  key: TranslationKey,
  parameters?: TranslationParameters,
  language: AppLanguage = selectedLanguage
): string {
  const resolved = resolvedLanguage(language);
  const template = compactTranslations[resolved]?.[key] ?? english[key];
  if (!parameters) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(parameters, name) ? String(parameters[name]) : match
  );
}

export function languageName(language: AppLanguage, displayLanguage = selectedLanguage): string {
  if (language === "system") return languageOptions[0].nativeName;
  const option = languageOptions.find((item) => item.id === language);
  if (!option) return language;
  try {
    const names = new Intl.DisplayNames([resolvedLanguage(displayLanguage)], { type: "language" });
    return names.of(language) || option.nativeName;
  } catch {
    return option.nativeName;
  }
}

/**
 * Transitional localization helper for feature surfaces that pre-date the
 * keyed catalogue. Simplified Chinese remains the source locale; every other
 * locale receives an English fallback instead of leaking Chinese UI text.
 * New reusable copy should still use `t()` so individual locales can override
 * it without touching components.
 */
export function localizeUiText(
  simplifiedChinese: string,
  englishFallback: string,
  language: AppLanguage = selectedLanguage
): string {
  return resolvedLanguage(language) === "zh-CN" ? simplifiedChinese : englishFallback;
}

const runtimeEnglishReplacements: ReadonlyArray<readonly [RegExp, string]> = [
  [/^正在连接(?:全盘名称)?索引(?:核心)?$/u, "Connecting to the full-drive index"],
  [/^正在启动自研索引核心$/u, "Starting the first-party index core"],
  [/^正在准备索引$/u, "Preparing the index"],
  [/^已载入持久化索引，实时监听已接管$/u, "Persistent index loaded; live monitoring is active"],
  [/^已载入持久化索引并重放 ([\d,]+) 条增量，实时监听已接管$/u, "Persistent index loaded; replayed $1 changes and activated live monitoring"],
  [/^已载入持久化索引，但增量日志损坏（(.+)）；建议手动刷新$/u, "Persistent index loaded, but the change log is damaged ($1). A manual refresh is recommended."],
  [/^索引增量日志写入失败：(.+)$/u, "Unable to write the index change log: $1"],
  [/^无法初始化索引增量日志：(.+)$/u, "Unable to initialize the index change log: $1"],
  [/^索引可用，但增量日志读取失败：(.+)$/u, "The index is available, but its change log could not be read: $1"],
  [/^索引可用，但缓存写入失败：(.+)$/u, "The index is available for this session, but its persistent cache could not be written: $1"],
  [/^索引可用，但缓存和增量日志读取失败：(.+)；(.+)$/u, "The index is available for this session, but its cache and change log failed: $1; $2"],
  [/^检测到旧索引不完整或不可用，正在自动重建$/u, "The previous index is incomplete or unavailable and is being rebuilt automatically"],
  [/^(.+) 的 MFT 结果不完整（仅 ([\d,]+) 条），正在改用完整目录扫描$/u, "$1 returned an incomplete MFT result ($2 entries); switching to a complete directory scan"],
  [/^正在扫描(?:所有磁盘|磁盘)?$/u, "Scanning drives"],
  [/^全盘索引构建中$/u, "Building the full-drive index"],
  [/^索引构建中$/u, "Building index"],
  [/^索引可用$/u, "Index ready"],
  [/^全盘索引未完成，结果会持续补全$/u, "The index is still building; results will continue to appear"],
  [/^索引变更实时同步$/u, "Index changes are synchronized live"],
  [/^正在后台计算文件夹占用空间$/u, "Calculating folder sizes in the background"],
  [/^正在加载下一批$/u, "Loading the next page"],
  [/^正在查询…?$/u, "Searching…"],
  [/^正在建立内容索引$/u, "Building the content index"],
  [/^内容索引已就绪$/u, "Content index ready"],
  [/^需要为所选目录建立内容索引$/u, "Build a content index for the selected directory"],
  [/^索引请求超时$/u, "The index request timed out"],
  [/^没有找到匹配项$/u, "No matching items"],
  [/^完整路径已复制$/u, "Full path copied"],
  [/^名称已复制$/u, "Name copied"],
  [/^父路径已复制$/u, "Parent path copied"],
  [/^目录名称已复制$/u, "Folder name copied"],
  [/^重命名完成$/u, "Rename completed"],
  [/^名称不能为空$/u, "The name cannot be empty"],
  [/^正在交给 Windows 打开$/u, "Opening with Windows"],
  [/^已打开$/u, "Opened"],
  [/^打开失败$/u, "Open failed"],
  [/^输入表达式后，这里会实时检查格式。$/u, "Enter an expression to validate it as you type."],
  [/^表达式不能超过 1024 个字符。$/u, "The expression cannot exceed 1,024 characters."],
  [/^为保证大文件搜索稳定，暂不支持前后查找（lookaround）。$/u, "Lookaround is disabled to keep large-file searches stable."],
  [/^为保证线性时间搜索，暂不支持 \\1 这类反向引用。$/u, "Backreferences such as \\1 are disabled to preserve linear-time search."],
  [/^该表达式能匹配空内容，请增加一个明确字符或条件。$/u, "This expression matches empty content. Add an explicit character or condition."],
  [/^表达式有效。正文搜索会扫描本地索引，不会重新读取原文件。$/u, "The expression is valid. Content search scans the local index without rereading source files."],
  [/^格式错误：/u, "Invalid pattern: "],
  [/^未设置快捷键$/u, "Shortcut not set"],
  [/^与另一个 CDriveShiftAI 功能的快捷键冲突$/u, "Conflicts with another CDriveShiftAI shortcut"],
  [/^已注册，当前可以全局唤起$/u, "Registered and available globally"],
  [/^组合键可用，保存后即可全局唤起$/u, "The shortcut is available and can be registered globally"],
  [/^该快捷键已被 CDriveShiftAI 的其他功能占用$/u, "Another CDriveShiftAI feature already uses this shortcut"],
  [/^该快捷键已被其他程序或 Windows 占用$/u, "Another application or Windows already uses this shortcut"],
  [/^快捷键格式无效，请重新录入$/u, "Invalid shortcut format; record it again"],
  [/^鼠标快捷操作已关闭$/u, "Mouse shortcut disabled"],
  [/^全局鼠标监听可用；短按不会被拦截$/u, "Global mouse listener available; short clicks are not intercepted"],
  [/^鼠标监听尚未启动$/u, "Mouse listener has not started"],
  [/^鼠标全局监听正在启动$/u, "Starting the global mouse listener"],
  [/^浏览器预览不提供 Windows 全局局部放大镜$/u, "The Windows desktop lens is unavailable in browser preview"],
  [/^Windows (?:全屏)?局部放大镜正在启动$/u, "Starting the Windows desktop lens"],
  [/^Windows 局部放大镜尚未启动$/u, "The Windows desktop lens has not started"],
  [/^按住组合键时显示局部放大镜，滚动滚轮可调倍率$/u, "Hold the modifiers to show the desktop lens; scroll to adjust magnification"],
  [/^全屏局部放大镜已关闭$/u, "Desktop lens disabled"],
  [/^全屏局部放大镜可用$/u, "Desktop lens available"],
  [/^当前 Windows 环境无法创建全局局部放大镜$/u, "The desktop lens could not be created in this Windows environment"],
  [/^正在准备全盘索引$/u, "Preparing the full-drive index"],
  [/^并行扫描已发现 (\d[\d,]*) 个条目$/u, "Parallel scan found $1 entries"],
  [/^全盘索引构建中，结果会持续补全$/u, "The full-drive index is building; results will continue to appear"],
  [/^(\d[\d,]*) 个条目$/u, "$1 entries"],
  [/^已扫描 (\d[\d,]*) 个条目$/u, "Scanned $1 entries"],
  [/^已索引 (\d[\d,]*) 个文件$/u, "Indexed $1 files"],
  [/^当前已是最新版本\s+(.+)$/u, "You are using the latest version, $1"],
  [/^发现新版本\s+([^，]+)，可自动下载并更新$/u, "Version $1 is available and can be downloaded and installed automatically"],
  [/^发现新版本\s+([^，]+)，但该 Release 缺少自动更新清单$/u, "Version $1 is available, but its Release does not include an automatic-update manifest"],
  [/^系统网络 · 直连$/u, "System network · direct connection"],
  [/^Windows 系统代理$/u, "Windows system proxy"],
  [/^Windows 系统代理 · (.+)$/u, "Windows system proxy · $1"],
  [/^系统代理检测失败，按 Windows 默认网络继续$/u, "System proxy detection failed; continuing with the Windows default network"],
  [/^Windows 应用安装体系$/u, "Windows application installation system"],
  [/^Windows 用户配置体系$/u, "Windows user-profile system"],
  [/^Windows 与已安装应用$/u, "Windows and installed applications"],
  [/^Windows 用户配置与用户本人$/u, "Windows user profiles and the user"],
  [/^上级应用或系统组件$/u, "Parent application or system component"],
  [/^Node\.js 包管理器$/u, "Node.js package manager"],
  [/^Rust 工具链$/u, "Rust toolchain"],
  [/^Windows 操作系统核心文件、组件存储、驱动与运行时数据$/u, "Windows core files, component storage, drivers, and runtime data"],
  [/^系统级应用的默认安装根目录，包含多个相互独立的应用$/u, "Default installation root for system-wide applications; contains multiple independent applications"],
  [/^面向全体用户的共享应用配置、服务状态、缓存与数据库$/u, "Shared application settings, service state, caches, and databases for all users"],
  [/^本机用户配置文件与个人数据的容器目录$/u, "Container directory for local user profiles and personal data"],
  [/^卷影复制、还原点和文件系统服务数据$/u, "Volume Shadow Copy, restore-point, and file-system service data"],
  [/^该卷的回收站系统数据$/u, "Recycle Bin system data for this volume"],
  [/^Windows 磁盘卷根目录，承载该卷上的系统、应用与用户数据$/u, "Windows volume root containing system, application, and user data"],
  [/^Windows 或共享系统保护目录，不应迁移或删除。$/u, "Windows or shared system-protected directory; do not move or delete it."],
  [/^缓存或临时数据，优先使用所属应用的清理与存储位置设置。$/u, "Cache or temporary data; prefer the owning application's cleanup and storage-location settings."],
  [/^应用安装目录，可能包含程序、更新器、服务或运行库。$/u, "Application installation directory that may contain programs, updaters, services, or runtimes."],
  [/^应用运行数据、配置或共享数据；所属应用可能安装在其他磁盘。$/u, "Application runtime data, settings, or shared data; the owning application may be installed on another drive."],
  [/^开发工程、依赖或工具链数据，通常适合迁移到容量更大的磁盘。$/u, "Development projects, dependencies, or toolchain data; usually suitable for migration to a larger drive."],
  [/^用户文件或个人工作目录；已知文件夹优先使用 Windows“位置”功能。$/u, "User files or a personal workspace; prefer the Windows Location feature for known folders."],
  [/^尚未发现足够的应用或路径证据，需要进入详细分析确认。$/u, "Not enough application or path evidence was found; open detailed analysis to confirm."],
  [/^路径与 Windows 约定系统目录精确匹配$/u, "Exact match with a standard Windows system directory"],
  [/^路径与 Windows 已知用户文件夹精确匹配$/u, "Exact match with a known Windows user folder"],
  [/^标准目录签名匹配$/u, "Standard directory signature matched"],
  [/^路径与安装位置重合$/u, "Path overlaps the installation location"],
  [/^名称特征匹配$/u, "Name signature matched"],
  [/^Codex CLI、桌面端与 app-server 的用户状态或项目级配置数据$/u, "User-state or project-level configuration data for Codex CLI, desktop, and app-server"],
  [/^Claude Code 的用户配置、项目状态、命令或会话数据$/u, "Claude Code user settings, project state, commands, or session data"],
  [/^Cursor 编辑器的用户级配置、扩展、缓存或会话状态$/u, "Cursor user settings, extensions, caches, or session state"],
  [/^VS Code 的工作区配置、推荐扩展或用户级扩展数据$/u, "VS Code workspace settings, extension recommendations, or user-level extension data"],
  [/^Ollama 的本地模型、清单、密钥与运行状态数据$/u, "Ollama local models, manifests, keys, and runtime state"],
  [/^Docker 客户端配置、上下文、凭据辅助信息或 Docker Desktop 状态$/u, "Docker client settings, contexts, credential-helper data, or Docker Desktop state"],
  [/^npm、pnpm 或 Yarn 的软件包缓存、元数据与下载内容$/u, "Package caches, metadata, and downloads from npm, pnpm, or Yarn"],
  [/^当前 JavaScript\/TypeScript 项目的已安装依赖$/u, "Installed dependencies for the current JavaScript/TypeScript project"],
  [/^Gradle 构建缓存、下载的依赖、守护进程与构建状态$/u, "Gradle build caches, downloaded dependencies, daemons, and build state"],
  [/^Maven 本地依赖仓库和用户配置$/u, "Maven local dependency repository and user settings"],
  [/^\.NET NuGet 包缓存、插件与用户级配置$/u, ".NET NuGet package cache, plugins, and user-level settings"],
  [/^Cargo 包缓存、已安装工具或 Rustup 工具链$/u, "Cargo package cache, installed tools, or Rustup toolchains"],
  [/^当前仓库的版本历史、分支、对象数据库与仓库配置$/u, "Version history, branches, object database, and repository settings for the current repository"],
  [/^可重建的缓存或临时运行数据$/u, "Rebuildable cache or temporary runtime data"]
];

export function localizeRuntimeText(
  value: string | undefined,
  language: AppLanguage = selectedLanguage
): string {
  if (!value || resolvedLanguage(language) === "zh-CN") return value ?? "";
  for (const [pattern, replacement] of runtimeEnglishReplacements) {
    if (pattern.test(value)) return value.replace(pattern, replacement);
  }
  return value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): string {
  return `${selectedLanguage}:${revision}`;
}

export function useI18n() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const language = selectedLanguage;
  const locale = resolvedLanguage(language);
  const t = useCallback(
    (key: TranslationKey, parameters?: TranslationParameters) =>
      translate(key, parameters, language),
    [language]
  );
  const formatNumber = useCallback(
    (value: number) => new Intl.NumberFormat(locale).format(value),
    [locale]
  );
  const formatDate = useCallback(
    (value: Date | string | number, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale, options).format(new Date(value)),
    [locale]
  );
  const ui = useCallback(
    (simplifiedChinese: string, englishFallback: string) =>
      localizeUiText(simplifiedChinese, englishFallback, language),
    [language]
  );
  const runtimeText = useCallback(
    (value: string | undefined) => localizeRuntimeText(value, language),
    [language]
  );
  return {
    language,
    locale,
    direction: locale === "ar-SA" ? ("rtl" as const) : ("ltr" as const),
    t,
    ui,
    runtimeText,
    formatNumber,
    formatDate
  };
}

applyDocumentLanguage();
