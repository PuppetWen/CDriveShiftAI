export type EffectMode = "aurora" | "matrix" | "calm" | "ember" | "ivory";
export type ViewId =
  | "overview"
  | "search"
  | "ownership-map"
  | "analyze"
  | "migrate"
  | "history"
  | "settings";

export interface DriveInfo {
  name: string;
  root: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  fileSystem: string;
}

export interface SystemOverview {
  drives: DriveInfo[];
  protectedPaths: string[];
  isElevated: boolean;
  hostname: string;
  platform: string;
  indexer: IndexerStatus;
}

export interface IndexerStatus {
  mode: "mft" | "hybrid" | "walker" | "cached" | "loading" | "unavailable";
  state: "idle" | "indexing" | "ready" | "error";
  entries: number;
  progress: number;
  root: string;
  updatedAt?: string;
  message?: string;
}

export interface ContentIndexerStatus {
  state: "idle" | "indexing" | "ready" | "error";
  root: string;
  filesVisited: number;
  filesIndexed: number;
  message?: string;
}

export type SearchCategory =
  | "folder"
  | "document"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "executable"
  | "code"
  | "other";

export type SearchSortField = "relevance" | "name" | "path" | "size" | "modified" | "type";
export type SearchSortDirection = "asc" | "desc";

export interface SearchFilters {
  kind: "all" | "folder" | "file";
  scope: string;
  scopes?: string[];
  categories?: SearchCategory[];
  extensions?: string[];
  minSize?: number;
  maxSize?: number;
  modifiedAfter?: string;
  modifiedBefore?: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  fuzzy?: boolean;
  matchPath?: boolean;
  regex?: boolean;
  sortBy?: SearchSortField;
  sortDirection?: SearchSortDirection;
}

export interface SearchWorkspaceState {
  version: 1;
  mode: "name" | "content";
  query: string;
  filters: SearchFilters;
  filterPanelOpen: boolean;
  extensionInput: string;
  datePreset: "any" | "today" | "week" | "month" | "year" | "custom";
  contentScope: string;
  results: SearchResult[];
  contentResults: ContentSearchResult[];
  directorySizes?: DirectorySizeResult[];
  selectedPath: string;
  elapsed?: number;
  savedAt: string;
}

export interface SearchBookmark {
  id: string;
  name: string;
  folderId?: string;
  mode: "name" | "content";
  query: string;
  filters: SearchFilters;
  filterPanelOpen: boolean;
  extensionInput: string;
  datePreset: "any" | "today" | "week" | "month" | "year" | "custom";
  contentScope: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchBookmarkFolder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface UiLayoutState {
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  searchResultColumnWidths?: SearchResultColumnWidths;
  searchRenamePosition?: {
    x: number;
    y: number;
  };
  mainWindowBounds?: WindowLayoutBounds;
  quickSearchWindowBounds?: WindowLayoutBounds;
}

export interface WindowLayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface SearchResult {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt?: string;
  score: number;
  source: "native-index" | "live-scan";
}

export interface SearchResultColumnWidths {
  name: number;
  path: number;
  type: number;
  size: number;
  modified: number;
  action: number;
}

export interface SearchPageOptions {
  cursor?: string;
  limit?: number;
}

export interface SearchPage<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
  totalMatches?: number;
  generation: number;
  cursorReset?: boolean;
}

export interface SearchIndexChangedEvent {
  changedCount: number;
  observedAt: string;
  generation?: number;
  contentScopes?: string[];
}

export interface SearchContextActionResult {
  action: "dismissed" | "revealed" | "opened" | "opened-with" | "analyze" | "deleted" | "error";
  message?: string;
}

export interface ForceDeleteProcess {
  pid: number;
  name: string;
  executablePath?: string;
  matchReason: "executable" | "command-line";
  canTerminate: boolean;
}

export interface ForceDeletePreview {
  verificationId: string;
  path: string;
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  highRisk: boolean;
  elevated: boolean;
  processes: ForceDeleteProcess[];
}

export interface ForceDeleteResult {
  deleted: boolean;
  terminatedProcesses: ForceDeleteProcess[];
}

export interface DirectorySizeResult {
  path: string;
  bytes: number;
  files: number;
  directories: number;
  complete: boolean;
}

export interface PathProperties {
  path: string;
  name: string;
  parentPath: string;
  extension: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  linkTarget?: string;
  size: number;
  allocatedBytes?: number;
  files?: number;
  directories?: number;
  scanComplete: boolean;
  createdAt?: string;
  modifiedAt?: string;
  accessedAt?: string;
  readable: boolean;
  writable: boolean;
}

export interface ContentSearchResult {
  path: string;
  name: string;
  preview: string;
  score: number;
  size?: number;
  modifiedAt?: string;
}

export interface ContentSearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  sortBy?: SearchSortField;
  sortDirection?: SearchSortDirection;
  minSize?: number;
  maxSize?: number;
  modifiedAfter?: string;
  modifiedBefore?: string;
}

export interface DirectorySummary {
  path: string;
  totalBytes: number;
  fileCount: number;
  directoryCount: number;
  lastModified?: string;
  extensionBreakdown: Array<{ extension: string; count: number; bytes: number }>;
  largestChildren: Array<{ path: string; bytes: number; isDirectory: boolean }>;
  sampleNames: string[];
  scanErrors: string[];
}

export interface OwnershipCandidate {
  appName: string;
  publisher?: string;
  confidence: number;
  reason: string;
  evidence: string[];
  installLocation?: string;
}

export type AnalysisCategory =
  | "application"
  | "application-data"
  | "cache"
  | "user-data"
  | "development"
  | "system"
  | "unknown";

export type AnalysisRisk = "low" | "medium" | "high" | "blocked";
export type AnalysisRecommendation = "migrate" | "review" | "keep";
export type AnalysisEvidenceSource =
  | "known-signature"
  | "installed-app"
  | "path-rule"
  | "ai"
  | "web";

export interface AnalysisWebSource {
  title: string;
  url: string;
}

export interface DirectoryInsight {
  path: string;
  name: string;
  purpose: string;
  producedBy?: string;
  howGenerated: string;
  category: AnalysisCategory;
  confidence: number;
  risk: AnalysisRisk;
  riskReason: string;
  source: AnalysisEvidenceSource;
  evidence: string[];
  webSources: AnalysisWebSource[];
}

export interface AnalysisSnapshot {
  analyzedAt: string;
  totalBytes: number;
  fileCount: number;
  directoryCount: number;
  lastModified?: string;
}

export interface AnalysisResult {
  summary: DirectorySummary;
  category: AnalysisCategory;
  risk: AnalysisRisk;
  recommendation: AnalysisRecommendation;
  explanation: string;
  purpose: string;
  producedBy?: string;
  howGenerated: string;
  confidence: number;
  riskReason: string;
  insights: DirectoryInsight[];
  snapshot: AnalysisSnapshot;
  candidates: OwnershipCandidate[];
  warnings: string[];
  source: "local" | "local+ai" | "local+ai+web";
  webResearchUsed: boolean;
  aiError?: string;
}

export interface OwnershipMapEntry {
  path: string;
  name: string;
  zone: "drive-root" | "program-files" | "program-data" | "app-data" | "user-profile";
  category: AnalysisResult["category"];
  risk: AnalysisResult["risk"];
  recommendation: AnalysisResult["recommendation"];
  explanation: string;
  owner?: OwnershipCandidate;
  candidateCount: number;
  lastModified?: string;
}

export interface OwnershipMapResult {
  drive: string;
  scannedAt: string;
  durationMs: number;
  installedApplications: number;
  portableExecutables: number;
  entries: OwnershipMapEntry[];
  scanErrors: string[];
}

export interface PreflightResult {
  allowed: boolean;
  source: string;
  destinationBase: string;
  finalDestination: string;
  requiredBytes: number;
  availableBytes: number;
  fileCount: number;
  directoryCount: number;
  risk: "low" | "medium" | "high" | "blocked";
  warnings: string[];
  blockers: string[];
  analysisStatus?: "current" | "not-analyzed" | "changed" | "source-missing";
  analysisMessage?: string;
  reanalysisRecommended?: boolean;
  lastAnalyzedAt?: string;
}

export type MigrationStage =
  | "preflight"
  | "copying"
  | "verifying"
  | "switching"
  | "linked"
  | "rolling-back"
  | "rolled-back"
  | "failed";

export interface MigrationRecord {
  id: string;
  source: string;
  destination: string;
  stagingPath?: string;
  backupPath?: string;
  stage: MigrationStage;
  linkType?: "symbolic-link" | "junction";
  totalBytes: number;
  copiedBytes: number;
  migrationCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  warnings: string[];
}

export interface AppSettings {
  effectMode: EffectMode;
  language: AppLanguage;
  launchAtLogin: boolean;
  launchMinimized: boolean;
  minimizeToTray: boolean;
  globalShortcut: string;
  quickSearchShortcut: string;
  mouseQuickSearchButton: MouseShortcutButton;
  mouseQuickSearchHoldMs: number;
  indexRoots: string[];
  excludedPaths: string[];
  ai: {
    enabled: boolean;
    provider: AiProviderId;
    protocol: AiProtocol;
    baseUrl: string;
    model: string;
    hasApiKey: boolean;
    privacyMode: "metadata-only" | "allow-samples";
    verifiedAt?: string;
  };
}

export type AppLanguage =
  | "system"
  | "zh-CN"
  | "zh-TW"
  | "en-US"
  | "ja-JP"
  | "ko-KR"
  | "es-ES"
  | "fr-FR"
  | "de-DE"
  | "pt-BR"
  | "ru-RU"
  | "ar-SA"
  | "hi-IN"
  | "id-ID"
  | "it-IT"
  | "tr-TR";

export type AiProtocol = "openai-compatible" | "anthropic" | "gemini";

export type AiProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "moonshot"
  | "zhipu"
  | "dashscope"
  | "siliconflow"
  | "volcengine"
  | "tencent-hunyuan"
  | "baidu-qianfan"
  | "minimax"
  | "openrouter"
  | "mistral"
  | "groq"
  | "xai"
  | "ollama"
  | "lmstudio"
  | "custom";

export interface AiConnectionInput {
  provider: AiProviderId;
  protocol: AiProtocol;
  baseUrl: string;
  model?: string;
  apiKey?: string;
  useSavedKey?: boolean;
}

export interface AiModelInfo {
  id: string;
  name: string;
  provider?: string;
  description?: string;
  createdAt?: string;
}

export interface AiModelListResult {
  models: AiModelInfo[];
  latencyMs: number;
}

export interface AiTestResult {
  ok: true;
  model: string;
  reply: string;
  latencyMs: number;
  verificationId: string;
}

export interface AiSaveInput extends AiConnectionInput {
  enabled: boolean;
  privacyMode: AppSettings["ai"]["privacyMode"];
  verificationId?: string;
}

export interface AiDraftSaveInput extends AiConnectionInput {
  privacyMode: AppSettings["ai"]["privacyMode"];
  replaceApiKey?: boolean;
}

export interface MigrationProgressEvent {
  record: MigrationRecord;
  message: string;
}

export interface AppNavigationEvent {
  view: ViewId;
  path?: string;
  focus?: "ai-settings" | "search-input";
}

export type MouseShortcutButton = "disabled" | "back" | "forward" | "middle";

export interface MouseShortcutStatus {
  available: boolean;
  button: MouseShortcutButton;
  holdMs: number;
  message: string;
}

export type ShortcutTarget = "main" | "quick-search";

export type SettingsModuleId = "update" | "appearance" | "system" | "ai";

export interface ShortcutCheckResult {
  available: boolean;
  active: boolean;
  shortcut: string;
  message: string;
}

export interface AppUpdateAsset {
  name: string;
  size: number;
  downloadUrl: string;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "verifying"
  | "ready"
  | "installing"
  | "cancelled"
  | "error"
  | "unavailable";

export interface AppUpdateProgress {
  transferred: number;
  total: number;
  percent: number;
  bytesPerSecond: number;
  retryAttempt: number;
  maxRetries: number;
}

export interface AppUpdateReleaseSection {
  title: string;
  items: string[];
}

export interface AppUpdateInfo {
  status: "checking" | "current" | "available" | "unavailable";
  phase: UpdatePhase;
  distribution: "installed" | "portable" | "development";
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  canAutoUpdate: boolean;
  releaseName?: string;
  releaseUrl?: string;
  publishedAt?: string;
  releaseSummary?: string;
  releaseSections?: AppUpdateReleaseSection[];
  assets: AppUpdateAsset[];
  selectedAsset?: AppUpdateAsset;
  progress?: AppUpdateProgress;
  message: string;
  checkedAt: string;
  errorCode?: string;
  network?: {
    mode: "system-proxy" | "direct" | "unavailable";
    label: string;
    resolvedAt: string;
  };
}

export interface DiagnosticExportResult {
  cancelled: boolean;
  path?: string;
}

export interface CDriveShiftApi {
  getOverview(): Promise<SystemOverview>;
  checkForUpdates(force?: boolean): Promise<AppUpdateInfo>;
  getUpdateState(): Promise<AppUpdateInfo>;
  startUpdate(): Promise<AppUpdateInfo>;
  cancelUpdate(): Promise<AppUpdateInfo>;
  openLogDirectory(): Promise<void>;
  exportDiagnosticReport(): Promise<DiagnosticExportResult>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<Omit<AppSettings, "ai">>): Promise<AppSettings>;
  checkGlobalShortcut(
    shortcut: string,
    target: ShortcutTarget
  ): Promise<ShortcutCheckResult>;
  testGlobalShortcut(target: ShortcutTarget): Promise<boolean>;
  getMouseShortcutStatus(): Promise<MouseShortcutStatus>;
  testMouseShortcut(): Promise<boolean>;
  listAiModels(input: AiConnectionInput): Promise<AiModelListResult>;
  testAiConnection(input: AiConnectionInput): Promise<AiTestResult>;
  saveAiDraft(input: AiDraftSaveInput): Promise<AppSettings>;
  saveAiSettings(input: AiSaveInput): Promise<AppSettings>;
  chooseDirectory(title?: string): Promise<string | null>;
  revealPath(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openWith(path: string): Promise<void>;
  copyText(text: string): Promise<void>;
  copyPathToDirectory(path: string, destination: string): Promise<string>;
  renamePath(path: string, newName: string): Promise<string>;
  getPathProperties(path: string): Promise<PathProperties>;
  trashPath(path: string): Promise<boolean>;
  previewForceDelete(path: string): Promise<ForceDeletePreview>;
  executeForceDelete(verificationId: string): Promise<ForceDeleteResult>;
  directorySizes(paths: string[]): Promise<DirectorySizeResult[]>;
  getSearchWorkspace(): Promise<SearchWorkspaceState | undefined>;
  saveSearchWorkspace(state: SearchWorkspaceState): Promise<void>;
  listSearchBookmarks(): Promise<SearchBookmark[]>;
  saveSearchBookmark(bookmark: SearchBookmark): Promise<SearchBookmark>;
  deleteSearchBookmark(id: string): Promise<boolean>;
  listSearchBookmarkFolders(): Promise<SearchBookmarkFolder[]>;
  saveSearchBookmarkFolder(folder: SearchBookmarkFolder): Promise<SearchBookmarkFolder>;
  deleteSearchBookmarkFolder(id: string): Promise<boolean>;
  getUiLayout(): Promise<UiLayoutState>;
  updateUiLayout(patch: Partial<UiLayoutState>): Promise<UiLayoutState>;
  navigateApp(event: AppNavigationEvent): Promise<void>;
  finishUtilityWindow(): Promise<void>;
  showSearchContextMenu(path: string, isDirectory: boolean): Promise<SearchContextActionResult>;
  openExternal(url: string): Promise<void>;
  search(query: string, filters: SearchFilters): Promise<SearchResult[]>;
  searchPage(
    query: string,
    filters: SearchFilters,
    options?: SearchPageOptions
  ): Promise<SearchPage<SearchResult>>;
  searchContent(
    query: string,
    scope: string,
    options?: ContentSearchOptions
  ): Promise<ContentSearchResult[]>;
  searchContentPage(
    query: string,
    scope: string,
    options?: ContentSearchOptions & SearchPageOptions
  ): Promise<SearchPage<ContentSearchResult>>;
  indexContent(scope: string): Promise<void>;
  contentIndexStatus(scope: string): Promise<ContentIndexerStatus>;
  indexerStatus(): Promise<IndexerStatus>;
  rebuildIndex(): Promise<void>;
  summarizeDirectory(path: string): Promise<DirectorySummary>;
  getLastAnalysis(): Promise<AnalysisResult | undefined>;
  getSavedAnalysis(path: string): Promise<AnalysisResult | undefined>;
  deleteSavedAnalysis(path: string): Promise<boolean>;
  analyzeDirectory(path: string, useAi?: boolean): Promise<AnalysisResult>;
  getSavedOwnershipMap(drive: string): Promise<OwnershipMapResult | undefined>;
  scanOwnershipMap(drive: string): Promise<OwnershipMapResult>;
  preflightMigration(source: string, destinationBase: string): Promise<PreflightResult>;
  executeMigration(source: string, destinationBase: string): Promise<MigrationRecord>;
  listMigrations(): Promise<MigrationRecord[]>;
  rollbackMigration(id: string): Promise<MigrationRecord>;
  reapplyMigration(id: string): Promise<MigrationRecord>;
  deleteMigrations(ids: string[]): Promise<number>;
  onIndexerStatus(listener: (status: IndexerStatus) => void): () => void;
  onSearchIndexChanged(listener: (event: SearchIndexChangedEvent) => void): () => void;
  onContentIndexerStatus(listener: (status: ContentIndexerStatus) => void): () => void;
  onMigrationProgress(listener: (event: MigrationProgressEvent) => void): () => void;
  onAppNavigation(listener: (event: AppNavigationEvent) => void): () => void;
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void;
  onUpdateStatus(listener: (status: AppUpdateInfo) => void): () => void;
}

declare global {
  interface Window {
    cDriveShiftAI?: CDriveShiftApi;
  }
}
