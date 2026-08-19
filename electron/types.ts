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

export interface SearchResult {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt?: string;
  score: number;
  source: "native-index" | "live-scan";
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

export interface DriveInfo {
  name: string;
  root: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  fileSystem: string;
}

export interface DirectorySummary {
  path: string;
  totalBytes: number;
  fileCount: number;
  directoryCount: number;
  reparsePointCount: number;
  reparsePoints?: Array<{ relativePath: string; target: string }>;
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
  zone:
    | "drive-root"
    | "program-files"
    | "application-library"
    | "application-data"
    | "program-data"
    | "app-data"
    | "user-profile";
  category: AnalysisResult["category"];
  risk: AnalysisResult["risk"];
  recommendation: AnalysisResult["recommendation"];
  explanation: string;
  owner?: OwnershipCandidate;
  candidateCount: number;
  lastModified?: string;
}

export interface OwnershipMapResult {
  schemaVersion: number;
  drive: string;
  scannedAt: string;
  durationMs: number;
  scannedDirectories: number;
  scanTruncated: boolean;
  installedApplications: number;
  portableExecutables: number;
  entries: OwnershipMapEntry[];
  scanErrors: string[];
}

export interface AppSettings {
  effectMode: "aurora" | "matrix" | "calm" | "ember" | "ivory";
  language: AppLanguage;
  uiScale: UiScale;
  launchAtLogin: boolean;
  launchMinimized: boolean;
  minimizeToTray: boolean;
  globalShortcut: string;
  quickSearchShortcut: string;
  mouseQuickSearchButton: MouseShortcutButton;
  mouseQuickSearchHoldMs: number;
  magnifierEnabled: boolean;
  magnifierModifiers: string;
  magnifierWidth: number;
  magnifierHeight: number;
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

export type UiScale = number;

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

export type MouseShortcutButton = "disabled" | "back" | "forward" | "middle";

export interface MouseShortcutStatus {
  available: boolean;
  button: MouseShortcutButton;
  holdMs: number;
  message: string;
}

export type ShortcutTarget = "main" | "quick-search";

export interface ShortcutCheckResult {
  available: boolean;
  active: boolean;
  shortcut: string;
  message: string;
}

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

export interface PreflightResult {
  allowed: boolean;
  source: string;
  destinationBase: string;
  finalDestination: string;
  requiredBytes: number;
  availableBytes: number;
  fileCount: number;
  directoryCount: number;
  reparsePointCount: number;
  risk: "low" | "medium" | "high" | "blocked";
  warnings: string[];
  blockers: string[];
  analysisStatus?: "current" | "not-analyzed" | "changed" | "source-missing";
  analysisMessage?: string;
  reanalysisRecommended?: boolean;
  lastAnalyzedAt?: string;
}

export interface InstalledApplication {
  name: string;
  publisher?: string;
  installLocation?: string;
  displayIcon?: string;
  executablePath?: string;
  source?: "registry" | "appx" | "app-path" | "portable-executable";
}

export interface StoreShape {
  settings: AppSettings;
  migrations: MigrationRecord[];
  directoryDialogPaths: Partial<Record<DirectoryDialogPurpose, string>>;
  searchWorkspace?: SearchWorkspaceState;
  searchBookmarks: SearchBookmark[];
  searchBookmarkFolders: SearchBookmarkFolder[];
  uiLayout: UiLayoutState;
  analyses: AnalysisResult[];
  ownershipMaps: OwnershipMapResult[];
}

export interface MagnifierStatus {
  available: boolean;
  enabled: boolean;
  modifiers: string;
  width: number;
  height: number;
  message: string;
}

export type DirectoryDialogPurpose =
  | "migration-source"
  | "migration-destination"
  | "analysis"
  | "search-scope"
  | "content-index"
  | "copy-destination"
  | "general";

export interface NativeResponse {
  id?: number;
  event?: string;
  ok?: boolean;
  error?: string;
  status?: IndexerStatus | ContentIndexerStatus;
  results?: SearchResult[] | ContentSearchResult[];
  changedCount?: number;
  hasMore?: boolean;
  nextCursor?: string;
  totalMatches?: number;
  generation?: number;
  cursorReset?: boolean;
  contentScopes?: string[];
}

export interface SearchResultColumnWidths {
  name: number;
  path: number;
  type: number;
  size: number;
  modified: number;
  action: number;
}

export interface SearchIndexChangedEvent {
  changedCount: number;
  observedAt: string;
  generation?: number;
  contentScopes?: string[];
}
