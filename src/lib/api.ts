import type {
  AnalysisResult,
  AppSettings,
  ContentSearchResult,
  DirectorySummary,
  IndexerStatus,
  CDriveShiftApi,
  MigrationProgressEvent,
  MigrationRecord,
  OwnershipMapResult,
  PreflightResult,
  SearchFilters,
  SearchBookmark,
  SearchBookmarkFolder,
  SearchResult,
  SearchWorkspaceState,
  SystemOverview
} from "../types";

const mockOverview: SystemOverview = {
  drives: [
    {
      name: "System",
      root: "C:\\",
      totalBytes: 512 * 1024 ** 3,
      freeBytes: 146 * 1024 ** 3,
      usedBytes: 366 * 1024 ** 3,
      fileSystem: "NTFS"
    },
    {
      name: "Drive D",
      root: "D:\\",
      totalBytes: 1024 * 1024 ** 3,
      freeBytes: 612 * 1024 ** 3,
      usedBytes: 412 * 1024 ** 3,
      fileSystem: "NTFS"
    },
    {
      name: "Drive E",
      root: "E:\\",
      totalBytes: 1024 * 1024 ** 3,
      freeBytes: 380 * 1024 ** 3,
      usedBytes: 644 * 1024 ** 3,
      fileSystem: "NTFS"
    }
  ],
  protectedPaths: ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)"],
  isElevated: false,
  hostname: "DESKTOP",
  platform: "win32",
  indexer: {
    mode: "mft",
    state: "ready",
    entries: 1_842_671,
    progress: 1,
    root: "C:\\",
    updatedAt: new Date().toISOString()
  }
};

const mockSettings: AppSettings = {
  effectMode: "aurora",
  launchAtLogin: false,
  launchMinimized: false,
  minimizeToTray: true,
  globalShortcut: "CommandOrControl+Alt+Space",
  quickSearchShortcut: "CommandOrControl+Alt+F",
  mouseQuickSearchButton: "back",
  mouseQuickSearchHoldMs: 3_000,
  indexRoots: ["*"],
  excludedPaths: ["C:\\Windows\\WinSxS", "C:\\System Volume Information"],
  ai: {
    enabled: false,
    provider: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    hasApiKey: false,
    privacyMode: "metadata-only"
  }
};

let mockSearchWorkspace: SearchWorkspaceState | undefined;
const mockAnalyses = new Map<string, AnalysisResult>();
const mockOwnershipMaps = new Map<string, OwnershipMapResult>();
let mockSearchBookmarks: SearchBookmark[] = [];
let mockSearchBookmarkFolders: SearchBookmarkFolder[] = [];
let mockUiLayout = {};
let mockMigrations: MigrationRecord[] = [];
const mockMigrationListeners = new Set<(event: MigrationProgressEvent) => void>();

function emitMockMigration(record: MigrationRecord, message: string): void {
  const event = { record: structuredClone(record), message };
  for (const listener of mockMigrationListeners) listener(event);
}

function mockDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function createMockAnalysis(targetPath: string, useAi = false): AnalysisResult {
  const analyzedAt = new Date().toISOString();
  const childPaths = [
    `${targetPath}\\sessions`,
    `${targetPath}\\skills`,
    `${targetPath}\\logs`,
    `${targetPath}\\plugins`
  ];
  const summary: DirectorySummary = {
    path: targetPath,
    totalBytes: 3.8 * 1024 ** 3,
    fileCount: 18_426,
    directoryCount: 1_284,
    lastModified: analyzedAt,
    extensionBreakdown: [
      { extension: ".jsonl", count: 7_210, bytes: 1.4 * 1024 ** 3 },
      { extension: ".sqlite", count: 18, bytes: 920 * 1024 ** 2 },
      { extension: ".md", count: 2_180, bytes: 340 * 1024 ** 2 }
    ],
    largestChildren: childPaths.map((path, index) => ({
      path,
      bytes: (1.4 - index * 0.24) * 1024 ** 3,
      isDirectory: true
    })),
    sampleNames: ["sessions", "skills", "logs", "plugins"],
    scanErrors: []
  };
  const targetInsight: AnalysisResult["insights"][number] = {
    path: targetPath,
    name: targetPath.split(/[\\/]/).filter(Boolean).at(-1) ?? targetPath,
    purpose: "Codex 的用户状态、配置、会话、技能与本地数据库",
    producedBy: "OpenAI Codex",
    howGenerated: "由 Codex 在登录、保存配置、运行任务和加载技能时创建。",
    category: "application-data",
    confidence: 0.99,
    risk: "high",
    riskReason: "可能包含认证与活动会话数据；迁移前必须完全退出 Codex。",
    source: "known-signature",
    evidence: ["标准目录签名", "本机应用资产匹配"],
    webSources: []
  };
  return {
    summary,
    category: "application-data",
    risk: "high",
    recommendation: "review",
    explanation: "本机应用清单与标准目录约定均指向 OpenAI Codex。",
    purpose: targetInsight.purpose,
    producedBy: targetInsight.producedBy,
    howGenerated: targetInsight.howGenerated,
    confidence: 0.99,
    riskReason: targetInsight.riskReason,
    insights: [
      targetInsight,
      ...childPaths.map((path, index) => ({
        path,
        name: path.split(/[\\/]/).at(-1) ?? path,
        purpose: ["任务会话记录", "可复用技能与工作流", "运行日志", "插件缓存与元数据"][index],
        producedBy: "OpenAI Codex",
        howGenerated: "由 Codex 运行时按功能自动创建和维护。",
        category: "application-data" as const,
        confidence: 0.88 - index * 0.03,
        risk: "high" as const,
        riskReason: "属于活动应用数据，迁移前必须退出 Codex。",
        source: "ai" as const,
        evidence: ["父目录归属与子目录名称特征"],
        webSources: []
      }))
    ],
    snapshot: {
      analyzedAt,
      totalBytes: summary.totalBytes,
      fileCount: summary.fileCount,
      directoryCount: summary.directoryCount,
      lastModified: summary.lastModified
    },
    candidates: [
      {
        appName: "OpenAI Codex",
        publisher: "OpenAI",
        confidence: 0.99,
        reason: "本机应用与目录签名匹配",
        evidence: ["标准目录签名", "全盘可执行文件资产匹配"]
      }
    ],
    warnings: ["迁移前必须退出 Codex，并确认没有任务或索引进程仍在写入。"],
    source: useAi ? "local+ai" : "local",
    webResearchUsed: false
  };
}

function unavailable<T>(): Promise<T> {
  return Promise.reject(new Error("此功能需要在 CDriveShiftAI 桌面应用中运行"));
}

const browserFallback: CDriveShiftApi = {
  async getOverview() {
    return mockOverview;
  },
  async checkForUpdates() {
    if (new URLSearchParams(window.location.search).has("update-demo")) {
      return {
        status: "available",
        phase: "downloading",
        distribution: "portable",
        currentVersion: "0.0.4",
        latestVersion: "0.0.5",
        updateAvailable: true,
        canAutoUpdate: true,
        releaseName: "CDriveShiftAI 0.0.5",
        releaseUrl: "https://github.com/PuppetWen/CDriveShiftAI/releases/latest",
        publishedAt: new Date().toISOString(),
        assets: [],
        selectedAsset: {
          name: "CDriveShiftAI-x64-portable.exe",
          size: 104_053_922,
          downloadUrl: "https://github.com/PuppetWen/CDriveShiftAI/releases/latest"
        },
        progress: {
          transferred: 67_634_688,
          total: 104_053_922,
          percent: 64.9996,
          bytesPerSecond: 7_864_320,
          retryAttempt: 1,
          maxRetries: 3
        },
        message: "正在下载更新包…",
        checkedAt: new Date().toISOString()
      } as const;
    }
    return {
      status: "current",
      phase: "current",
      distribution: "development",
      currentVersion: "0.0.5",
      latestVersion: "0.0.5",
      updateAvailable: false,
      canAutoUpdate: false,
      releaseName: "CDriveShiftAI 0.0.5",
      releaseUrl: "https://github.com/PuppetWen/CDriveShiftAI/releases/latest",
      assets: [],
      message: "当前已是最新版本 0.0.5",
      checkedAt: new Date().toISOString()
    } as const;
  },
  async getUpdateState() {
    return this.checkForUpdates();
  },
  async startUpdate() {
    return this.checkForUpdates();
  },
  async cancelUpdate() {
    return this.checkForUpdates();
  },
  async openLogDirectory() {
    return unavailable<void>();
  },
  async exportDiagnosticReport() {
    return unavailable<never>();
  },
  async getSettings() {
    return mockSettings;
  },
  async updateSettings(patch) {
    Object.assign(mockSettings, patch);
    return mockSettings;
  },
  async checkGlobalShortcut(shortcut, target) {
    const value = shortcut.trim();
    const current =
      target === "main"
        ? mockSettings.globalShortcut
        : mockSettings.quickSearchShortcut;
    const other =
      target === "main"
        ? mockSettings.quickSearchShortcut
        : mockSettings.globalShortcut;
    if (!value) {
      return {
        available: false,
        active: false,
        shortcut: value,
        message: "未设置快捷键"
      };
    }
    if (value.toLocaleLowerCase() === other.trim().toLocaleLowerCase()) {
      return {
        available: false,
        active: false,
        shortcut: value,
        message: "与另一个 CDriveShiftAI 功能的快捷键冲突"
      };
    }
    const active =
      value.toLocaleLowerCase() === current.trim().toLocaleLowerCase();
    return {
      available: true,
      active,
      shortcut: value,
      message: active
        ? "已注册，当前可以全局唤起"
        : "组合键可用，保存后即可全局唤起"
    };
  },
  async testGlobalShortcut() {
    return true;
  },
  async getMouseShortcutStatus() {
    return {
      available: true,
      button: mockSettings.mouseQuickSearchButton,
      holdMs: mockSettings.mouseQuickSearchHoldMs,
      message:
        mockSettings.mouseQuickSearchButton === "disabled"
          ? "鼠标快捷操作已关闭"
          : "全局鼠标监听可用；短按不会被拦截"
    };
  },
  async testMouseShortcut() {
    return true;
  },
  async listAiModels(input) {
    const prefix =
      input.protocol === "anthropic"
        ? "claude"
        : input.protocol === "gemini"
          ? "gemini"
          : input.provider === "ollama" || input.provider === "lmstudio"
            ? "local"
            : input.provider;
    return {
      models: [
        { id: `${prefix}-fast`, name: `${prefix}-fast`, provider: input.provider },
        { id: `${prefix}-reasoning`, name: `${prefix}-reasoning`, provider: input.provider },
        { id: `${prefix}-pro`, name: `${prefix}-pro`, provider: input.provider }
      ],
      latencyMs: 86
    };
  },
  async testAiConnection(input) {
    if (!input.model) throw new Error("请先选择模型");
    return {
      ok: true,
      model: input.model,
      reply: "CDriveShiftAI AI 服务连接成功",
      latencyMs: 328,
      verificationId: "browser-preview-verification"
    };
  },
  async saveAiDraft(input) {
    const connectionChanged =
      mockSettings.ai.provider !== input.provider ||
      mockSettings.ai.protocol !== input.protocol ||
      mockSettings.ai.baseUrl.replace(/\/+$/, "") !==
        input.baseUrl.trim().replace(/\/+$/, "") ||
      mockSettings.ai.model !== (input.model ?? "") ||
      Boolean(input.replaceApiKey);
    mockSettings.ai = {
      ...mockSettings.ai,
      enabled: connectionChanged ? false : mockSettings.ai.enabled,
      provider: input.provider,
      protocol: input.protocol,
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
      model: input.model?.trim() ?? "",
      hasApiKey: input.replaceApiKey
        ? Boolean(input.apiKey)
        : mockSettings.ai.provider === input.provider && mockSettings.ai.hasApiKey,
      privacyMode: input.privacyMode,
      verifiedAt: connectionChanged ? undefined : mockSettings.ai.verifiedAt
    };
    return mockSettings;
  },
  async saveAiSettings(input) {
    mockSettings.ai = {
      enabled: input.enabled,
      provider: input.provider,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      model: input.model ?? "",
      hasApiKey: Boolean(input.apiKey || input.useSavedKey),
      privacyMode: input.privacyMode,
      verifiedAt: input.enabled ? new Date().toISOString() : mockSettings.ai.verifiedAt
    };
    return mockSettings;
  },
  async chooseDirectory() {
    return null;
  },
  revealPath: () => Promise.resolve(),
  openPath: () => Promise.resolve(),
  openWith: () => Promise.resolve(),
  copyText: async (text) => {
    await navigator.clipboard?.writeText(text);
  },
  async copyPathToDirectory(path, destination) {
    return `${destination}\\${path.split(/[\\/]/).pop() ?? ""}`;
  },
  async renamePath(path, newName) {
    return path.replace(/[^\\/]+$/, newName);
  },
  async getPathProperties(targetPath) {
    const name = targetPath.split(/[\\/]/).pop() || targetPath;
    const isDirectory = !/\.[a-z0-9]{1,12}$/i.test(name);
    return {
      path: targetPath,
      name,
      parentPath: targetPath.replace(/[\\/][^\\/]+[\\/]?$/, ""),
      extension: isDirectory ? "" : name.split(".").pop()?.toLocaleLowerCase() ?? "",
      isDirectory,
      isSymbolicLink: false,
      size: isDirectory ? 4.8 * 1024 ** 3 : 42.7 * 1024 ** 2,
      allocatedBytes: isDirectory ? undefined : 42.8 * 1024 ** 2,
      files: isDirectory ? 8_426 : undefined,
      directories: isDirectory ? 318 : undefined,
      scanComplete: true,
      createdAt: new Date(Date.now() - 42 * 86_400_000).toISOString(),
      modifiedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      accessedAt: new Date().toISOString(),
      readable: true,
      writable: true
    };
  },
  trashPath: () => Promise.resolve(false),
  async directorySizes(paths) {
    return paths.map((path, index) => ({
      path,
      bytes: (index + 1) * 1.7 * 1024 ** 3,
      files: (index + 1) * 842,
      directories: (index + 1) * 64,
      complete: true
    }));
  },
  async getSearchWorkspace() {
    return mockSearchWorkspace ? structuredClone(mockSearchWorkspace) : undefined;
  },
  async saveSearchWorkspace(state) {
    mockSearchWorkspace = structuredClone(state);
  },
  async listSearchBookmarks() {
    return structuredClone(mockSearchBookmarks);
  },
  async saveSearchBookmark(bookmark) {
    const saved = { ...structuredClone(bookmark), updatedAt: new Date().toISOString() };
    mockSearchBookmarks = [
      saved,
      ...mockSearchBookmarks.filter((item) => item.id !== saved.id)
    ];
    return structuredClone(saved);
  },
  async deleteSearchBookmark(id) {
    const previousLength = mockSearchBookmarks.length;
    mockSearchBookmarks = mockSearchBookmarks.filter((item) => item.id !== id);
    return mockSearchBookmarks.length !== previousLength;
  },
  async listSearchBookmarkFolders() {
    return structuredClone(mockSearchBookmarkFolders);
  },
  async saveSearchBookmarkFolder(folder) {
    const saved = {
      ...structuredClone(folder),
      updatedAt: new Date().toISOString()
    };
    mockSearchBookmarkFolders = [
      ...mockSearchBookmarkFolders.filter((item) => item.id !== saved.id),
      saved
    ];
    return structuredClone(saved);
  },
  async deleteSearchBookmarkFolder(id) {
    const previousLength = mockSearchBookmarkFolders.length;
    mockSearchBookmarkFolders = mockSearchBookmarkFolders.filter(
      (item) => item.id !== id
    );
    mockSearchBookmarks = mockSearchBookmarks.map((bookmark) =>
      bookmark.folderId === id ? { ...bookmark, folderId: undefined } : bookmark
    );
    return mockSearchBookmarkFolders.length !== previousLength;
  },
  async getUiLayout() {
    return structuredClone(mockUiLayout);
  },
  async updateUiLayout(patch) {
    mockUiLayout = { ...mockUiLayout, ...structuredClone(patch) };
    return structuredClone(mockUiLayout);
  },
  async navigateApp() {
    return undefined;
  },
  async finishUtilityWindow() {
    return undefined;
  },
  showSearchContextMenu: async () => ({ action: "dismissed" }),
  openExternal: (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  },
  async search(query) {
    if (!query.trim()) return [];
    return [
      {
        path: `C:\\Users\\You\\AppData\\Local\\${query}`,
        name: query,
        isDirectory: true,
        size: 4.8 * 1024 ** 3,
        score: 96,
        modifiedAt: new Date().toISOString(),
        source: "native-index"
      }
    ] as SearchResult[];
  },
  async searchContent(query, scope, options) {
    if (!query.trim() || !scope) return [];
    const preview = options?.regex
      ? `… 正则表达式〔${query}〕匹配到的示例内容 …`
      : `… 这里包含〔${query}〕的示例内容 …`;
    return [
      {
        path: `${scope}\\example.txt`,
        name: "example.txt",
        preview,
        score: 1
      }
    ] as ContentSearchResult[];
  },
  indexContent: () => Promise.resolve(),
  contentIndexStatus: async (scope) => ({
    state: "ready",
    root: scope,
    filesVisited: 58_578,
    filesIndexed: 58_578,
    message: "已载入该目录的本地内容索引"
  }),
  indexerStatus: async () => mockOverview.indexer,
  rebuildIndex: () => Promise.resolve(),
  summarizeDirectory: () => unavailable<DirectorySummary>(),
  async getLastAnalysis() {
    return [...mockAnalyses.values()].at(-1);
  },
  async getSavedAnalysis(targetPath) {
    return mockAnalyses.get(targetPath.toLocaleLowerCase());
  },
  async deleteSavedAnalysis(targetPath) {
    return mockAnalyses.delete(targetPath.toLocaleLowerCase());
  },
  async analyzeDirectory(targetPath, useAi) {
    const result = createMockAnalysis(targetPath, useAi);
    mockAnalyses.set(targetPath.toLocaleLowerCase(), result);
    return result;
  },
  async getSavedOwnershipMap(drive) {
    const value = mockOwnershipMaps.get(drive.slice(0, 2).toLocaleLowerCase());
    return value ? structuredClone(value) : undefined;
  },
  async scanOwnershipMap(drive) {
    const entries: OwnershipMapResult["entries"] = [
      {
        path: `${drive}Program Files\\Example Studio`,
        name: "Example Studio",
        zone: "program-files",
        category: "application",
        risk: "high",
        recommendation: "keep",
        explanation: "应用安装目录，可能包含更新器与运行库。",
        owner: {
          appName: "Example Studio",
          publisher: "Example Software",
          confidence: 0.94,
          reason: "路径与安装位置重合",
          evidence: ["路径与安装位置重合"],
          installLocation: `${drive}Program Files\\Example Studio`
        },
        candidateCount: 1,
        lastModified: new Date().toISOString()
      },
      {
        path: `${drive}Users\\You\\AppData\\Roaming\\Example Studio`,
        name: "Example Studio",
        zone: "app-data",
        category: "application-data",
        risk: "medium",
        recommendation: "review",
        explanation: "应用配置与运行数据。",
        owner: {
          appName: "Example Studio",
          publisher: "Example Software",
          confidence: 0.68,
          reason: "名称特征匹配",
          evidence: ["名称特征匹配"],
          installLocation: "E:\\Apps\\Example Studio"
        },
        candidateCount: 1,
        lastModified: new Date().toISOString()
      },
      {
        path: `${drive}Windows`,
        name: "Windows",
        zone: "drive-root",
        category: "system",
        risk: "blocked",
        recommendation: "keep",
        explanation: "Windows 系统保护目录。",
        candidateCount: 0,
        lastModified: new Date().toISOString()
      },
      {
        path: `${drive}Users\\You\\Documents`,
        name: "Documents",
        zone: "user-profile",
        category: "user-data",
        risk: "low",
        recommendation: "migrate",
        explanation: "用户文档目录。",
        candidateCount: 0,
        lastModified: new Date().toISOString()
      },
      {
        path: `${drive}UnknownVendor`,
        name: "UnknownVendor",
        zone: "drive-root",
        category: "unknown",
        risk: "medium",
        recommendation: "review",
        explanation: "需要详细分析确认。",
        candidateCount: 0,
        lastModified: new Date().toISOString()
      }
    ];
    const result: OwnershipMapResult = {
      drive,
      scannedAt: new Date().toISOString(),
      durationMs: 182,
      installedApplications: 286,
      portableExecutables: 1_462,
      entries,
      scanErrors: []
    };
    mockOwnershipMaps.set(drive.slice(0, 2).toLocaleLowerCase(), structuredClone(result));
    return result;
  },
  async preflightMigration(source, destinationBase) {
    const name = source.split(/[\\/]/).filter(Boolean).at(-1) ?? "Data";
    return {
      allowed: true,
      source,
      destinationBase,
      finalDestination: `${destinationBase}\\${name}`,
      requiredBytes: 4.8 * 1024 ** 3,
      availableBytes: 612 * 1024 ** 3,
      fileCount: 8_426,
      directoryCount: 318,
      risk: "medium",
      warnings: ["演示模式：迁移前请完全退出关联应用。"],
      blockers: [],
      analysisStatus: "current",
      analysisMessage: "目录与已保存分析一致。",
      reanalysisRecommended: false,
      lastAnalyzedAt: new Date().toISOString()
    };
  },
  async executeMigration(source, destinationBase) {
    const name = source.split(/[\\/]/).filter(Boolean).at(-1) ?? "Data";
    const startedAt = new Date().toISOString();
    const record: MigrationRecord = {
      id: `preview-${Date.now()}`,
      source,
      destination: `${destinationBase}\\${name}`,
      stage: "copying",
      totalBytes: 4.8 * 1024 ** 3,
      copiedBytes: 1.6 * 1024 ** 3,
      migrationCount: 0,
      startedAt,
      updatedAt: startedAt,
      warnings: []
    };
    emitMockMigration(record, "正在分批复制目录数据");
    await mockDelay(1_200);
    record.stage = "verifying";
    record.copiedBytes = record.totalBytes;
    record.updatedAt = new Date().toISOString();
    emitMockMigration(record, "正在核对文件数、目录数与字节数");
    await mockDelay(1_200);
    record.stage = "switching";
    record.updatedAt = new Date().toISOString();
    emitMockMigration(record, "正在原子切换源目录");
    await mockDelay(1_200);
    record.stage = "linked";
    record.linkType = "symbolic-link";
    record.migrationCount = 1;
    record.completedAt = new Date().toISOString();
    record.updatedAt = record.completedAt;
    emitMockMigration(record, "符号链接已建立，迁移完成");
    mockMigrations = [structuredClone(record), ...mockMigrations];
    return structuredClone(record);
  },
  listMigrations: async () => structuredClone(mockMigrations),
  rollbackMigration: () => unavailable<MigrationRecord>(),
  reapplyMigration: () => unavailable<MigrationRecord>(),
  async deleteMigrations(ids) {
    const selected = new Set(ids);
    const before = mockMigrations.length;
    mockMigrations = mockMigrations.filter((record) => !selected.has(record.id));
    return before - mockMigrations.length;
  },
  onIndexerStatus: () => () => undefined,
  onSearchIndexChanged: () => () => undefined,
  onContentIndexerStatus: () => () => undefined,
  onMigrationProgress(listener) {
    mockMigrationListeners.add(listener);
    return () => mockMigrationListeners.delete(listener);
  },
  onAppNavigation: () => () => undefined,
  onSettingsChanged: () => () => undefined,
  onUpdateStatus: () => () => undefined
};

export const api: CDriveShiftApi = window.cDriveShiftAI ?? browserFallback;

export type {
  AnalysisResult,
  DirectorySummary,
  IndexerStatus,
  MigrationProgressEvent,
  MigrationRecord,
  PreflightResult,
  SearchFilters,
  SearchResult
};
