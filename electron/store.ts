import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeDirectoryDialogPaths } from "./directory-dialog";
import {
  normalizeStoredMouseHoldMs,
  normalizeStoredUiScale
} from "./settings-normalization";
import type {
  AnalysisResult,
  AppSettings,
  ContentSearchResult,
  DirectorySizeResult,
  DirectoryDialogPurpose,
  MigrationRecord,
  SearchFilters,
  SearchBookmark,
  SearchBookmarkFolder,
  UiLayoutState,
  SearchResult,
  SearchWorkspaceState,
  OwnershipMapResult,
  StoreShape
} from "./types";

const defaults: StoreShape = {
  settings: {
    effectMode: "aurora",
    language: "zh-CN",
    uiScale: 1,
    launchAtLogin: false,
    launchMinimized: false,
    minimizeToTray: true,
    globalShortcut: "CommandOrControl+Alt+Space",
    quickSearchShortcut: "CommandOrControl+Alt+F",
    mouseQuickSearchButton: "back",
    mouseQuickSearchHoldMs: 3_000,
    magnifierEnabled: false,
    magnifierModifiers: "Ctrl",
    magnifierWidth: 480,
    magnifierHeight: 300,
    indexRoots: ["*"],
    excludedPaths: [
      "C:\\Windows\\WinSxS",
      "C:\\System Volume Information",
      "C:\\$Recycle.Bin"
    ],
    ai: {
      enabled: false,
      provider: "openai",
      protocol: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "",
      hasApiKey: false,
      privacyMode: "metadata-only"
    }
  },
  migrations: [],
  directoryDialogPaths: {},
  searchBookmarks: [],
  searchBookmarkFolders: [],
  uiLayout: {},
  analyses: [],
  ownershipMaps: []
};

interface DiskShape extends StoreShape {
  encryptedApiKey?: string;
}

const searchCategories = new Set([
  "folder",
  "document",
  "image",
  "video",
  "audio",
  "archive",
  "executable",
  "code",
  "other"
]);
const searchSortFields = new Set(["relevance", "name", "path", "size", "modified", "type"]);
const searchDatePresets = new Set(["any", "today", "week", "month", "year", "custom"]);

function safeString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sanitizeFilters(value: unknown): SearchFilters {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const kind = ["all", "folder", "file"].includes(String(input.kind))
    ? (input.kind as SearchFilters["kind"])
    : "all";
  const strings = (candidate: unknown, maxItems = 64) =>
    Array.isArray(candidate)
      ? candidate
          .filter((item): item is string => typeof item === "string")
          .slice(0, maxItems)
          .map((item) => item.slice(0, 32_768))
      : undefined;
  const categories = strings(input.categories)?.filter((item) => searchCategories.has(item));
  const sortBy = searchSortFields.has(String(input.sortBy))
    ? (input.sortBy as SearchFilters["sortBy"])
    : "relevance";
  const regex = Boolean(input.regex);
  const fuzzy = !regex && Boolean(input.fuzzy);
  const wholeWord = !regex && !fuzzy && Boolean(input.wholeWord);
  return {
    kind,
    scope: safeString(input.scope, 32_768) || "*",
    scopes: strings(input.scopes, 32),
    categories: categories as SearchFilters["categories"],
    extensions: strings(input.extensions)?.map((item) => item.slice(0, 24)),
    minSize: typeof input.minSize === "number" ? safeNumber(input.minSize) : undefined,
    maxSize: typeof input.maxSize === "number" ? safeNumber(input.maxSize) : undefined,
    modifiedAfter:
      typeof input.modifiedAfter === "string" ? input.modifiedAfter.slice(0, 64) : undefined,
    modifiedBefore:
      typeof input.modifiedBefore === "string" ? input.modifiedBefore.slice(0, 64) : undefined,
    caseSensitive: Boolean(input.caseSensitive),
    wholeWord,
    fuzzy,
    matchPath: Boolean(input.matchPath),
    regex,
    sortBy,
    sortDirection: input.sortDirection === "desc" ? "desc" : "asc"
  };
}

function sanitizeSearchResult(value: unknown): SearchResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const pathValue = safeString(input.path, 32_768);
  const name = safeString(input.name, 2_048);
  if (!pathValue || !name || typeof input.isDirectory !== "boolean") return undefined;
  return {
    path: pathValue,
    name,
    isDirectory: input.isDirectory,
    size: Math.max(0, safeNumber(input.size)),
    modifiedAt:
      typeof input.modifiedAt === "string" ? input.modifiedAt.slice(0, 64) : undefined,
    score: safeNumber(input.score),
    source: input.source === "live-scan" ? "live-scan" : "native-index"
  };
}

function sanitizeContentResult(value: unknown): ContentSearchResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const pathValue = safeString(input.path, 32_768);
  const name = safeString(input.name, 2_048);
  if (!pathValue || !name) return undefined;
  return {
    path: pathValue,
    name,
    preview: safeString(input.preview, 8_192),
    score: safeNumber(input.score),
    size: typeof input.size === "number" ? Math.max(0, safeNumber(input.size)) : undefined,
    modifiedAt:
      typeof input.modifiedAt === "string" ? input.modifiedAt.slice(0, 64) : undefined
  };
}

function sanitizeDirectorySize(value: unknown): DirectorySizeResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const pathValue = safeString(input.path, 32_768);
  if (!pathValue) return undefined;
  return {
    path: pathValue,
    bytes: Math.max(0, safeNumber(input.bytes)),
    files: Math.max(0, safeNumber(input.files)),
    directories: Math.max(0, safeNumber(input.directories)),
    complete: Boolean(input.complete)
  };
}

function sanitizeSearchWorkspace(value: unknown): SearchWorkspaceState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (input.version !== 1) return undefined;
  const results = (Array.isArray(input.results) ? input.results : [])
    .slice(0, 500)
    .map(sanitizeSearchResult)
    .filter((item): item is SearchResult => Boolean(item));
  const contentResults = (Array.isArray(input.contentResults) ? input.contentResults : [])
    .slice(0, 500)
    .map(sanitizeContentResult)
    .filter((item): item is ContentSearchResult => Boolean(item));
  const directorySizes = (Array.isArray(input.directorySizes) ? input.directorySizes : [])
    .slice(0, 500)
    .map(sanitizeDirectorySize)
    .filter((item): item is DirectorySizeResult => Boolean(item));
  const datePreset = searchDatePresets.has(String(input.datePreset))
    ? (input.datePreset as SearchWorkspaceState["datePreset"])
    : "any";
  return {
    version: 1,
    mode: input.mode === "content" ? "content" : "name",
    query: safeString(input.query, 4_096),
    filters: sanitizeFilters(input.filters),
    filterPanelOpen: Boolean(input.filterPanelOpen),
    extensionInput: safeString(input.extensionInput, 1_024),
    datePreset,
    contentScope: safeString(input.contentScope, 32_768) || "*",
    results,
    contentResults,
    directorySizes,
    selectedPath: safeString(input.selectedPath, 32_768),
    elapsed: typeof input.elapsed === "number" ? Math.max(0, safeNumber(input.elapsed)) : undefined,
    savedAt:
      typeof input.savedAt === "string" ? input.savedAt.slice(0, 64) : new Date().toISOString()
  };
}

function sanitizeSearchBookmark(value: unknown): SearchBookmark | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const id = safeString(input.id, 128).trim();
  const name = safeString(input.name, 80).trim();
  const query = safeString(input.query, 4_096).trim();
  if (!id || !name || !query) return undefined;
  const datePreset = searchDatePresets.has(String(input.datePreset))
    ? (input.datePreset as SearchBookmark["datePreset"])
    : "any";
  const now = new Date().toISOString();
  return {
    id,
    name,
    folderId:
      typeof input.folderId === "string"
        ? safeString(input.folderId, 128).trim() || undefined
        : undefined,
    mode: input.mode === "content" ? "content" : "name",
    query,
    filters: sanitizeFilters(input.filters),
    filterPanelOpen: Boolean(input.filterPanelOpen),
    extensionInput: safeString(input.extensionInput, 1_024),
    datePreset,
    contentScope: safeString(input.contentScope, 32_768) || "*",
    createdAt:
      typeof input.createdAt === "string" ? input.createdAt.slice(0, 64) : now,
    updatedAt:
      typeof input.updatedAt === "string" ? input.updatedAt.slice(0, 64) : now
  };
}

function sanitizeSearchBookmarkFolder(
  value: unknown
): SearchBookmarkFolder | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const id = safeString(input.id, 128).trim();
  const name = safeString(input.name, 80).trim();
  if (!id || !name) return undefined;
  const now = new Date().toISOString();
  return {
    id,
    name,
    createdAt:
      typeof input.createdAt === "string" ? input.createdAt.slice(0, 64) : now,
    updatedAt:
      typeof input.updatedAt === "string" ? input.updatedAt.slice(0, 64) : now
  };
}

function sanitizeUiLayout(value: unknown): UiLayoutState {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const position =
    input.searchRenamePosition &&
    typeof input.searchRenamePosition === "object"
      ? (input.searchRenamePosition as Record<string, unknown>)
      : undefined;
  const windowBounds = (
    candidate: unknown
  ): UiLayoutState["mainWindowBounds"] => {
    if (!candidate || typeof candidate !== "object") return undefined;
    const bounds = candidate as Record<string, unknown>;
    if (
      typeof bounds.x !== "number" ||
      !Number.isFinite(bounds.x) ||
      typeof bounds.y !== "number" ||
      !Number.isFinite(bounds.y) ||
      typeof bounds.width !== "number" ||
      !Number.isFinite(bounds.width) ||
      typeof bounds.height !== "number" ||
      !Number.isFinite(bounds.height)
    ) {
      return undefined;
    }
    return {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(480, Math.min(16_384, Math.round(bounds.width))),
      height: Math.max(360, Math.min(16_384, Math.round(bounds.height))),
      maximized: bounds.maximized === true
    };
  };
  const result: UiLayoutState = {};
  if (typeof input.sidebarCollapsed === "boolean") {
    result.sidebarCollapsed = input.sidebarCollapsed;
  }
  if (typeof input.sidebarWidth === "number" && Number.isFinite(input.sidebarWidth)) {
    result.sidebarWidth = Math.max(190, Math.min(360, Math.round(input.sidebarWidth)));
  }
  if (
    input.searchResultColumnWidths &&
    typeof input.searchResultColumnWidths === "object"
  ) {
    const widths = input.searchResultColumnWidths as Record<string, unknown>;
    const keys = ["name", "path", "type", "size", "modified", "action"] as const;
    if (
      keys.every(
        (key) =>
          typeof widths[key] === "number" &&
          Number.isFinite(widths[key]) &&
          Number(widths[key]) >= 4 &&
          Number(widths[key]) <= 60
      )
    ) {
      const total = keys.reduce((sum, key) => sum + Number(widths[key]), 0);
      if (total >= 80 && total <= 120) {
        const normalized = (key: (typeof keys)[number]) =>
          (Number(widths[key]) / total) * 100;
        result.searchResultColumnWidths = {
          name: normalized("name"),
          path: normalized("path"),
          type: normalized("type"),
          size: normalized("size"),
          modified: normalized("modified"),
          action: normalized("action")
        };
      }
    }
  }
  if (
    position &&
    typeof position.x === "number" &&
    Number.isFinite(position.x) &&
    typeof position.y === "number" &&
    Number.isFinite(position.y)
  ) {
    result.searchRenamePosition = {
      x: Math.max(0, safeNumber(position.x)),
      y: Math.max(0, safeNumber(position.y))
    };
  }
  const mainWindowBounds = windowBounds(input.mainWindowBounds);
  if (mainWindowBounds) result.mainWindowBounds = mainWindowBounds;
  const quickSearchWindowBounds = windowBounds(input.quickSearchWindowBounds);
  if (quickSearchWindowBounds) {
    result.quickSearchWindowBounds = quickSearchWindowBounds;
  }
  return result;
}

function analysisKey(value: string): string {
  return path.win32
    .normalize(value)
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase();
}

function sanitizeAnalysis(value: unknown): AnalysisResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<AnalysisResult>;
  if (
    !input.summary ||
    typeof input.summary.path !== "string" ||
    !input.snapshot ||
    typeof input.snapshot.analyzedAt !== "string" ||
    typeof input.purpose !== "string" ||
    typeof input.confidence !== "number" ||
    !Array.isArray(input.insights) ||
    !Array.isArray(input.candidates) ||
    !Array.isArray(input.warnings)
  ) {
    return undefined;
  }
  return structuredClone(input as AnalysisResult);
}

const migrationStages = new Set<MigrationRecord["stage"]>([
  "preflight",
  "copying",
  "verifying",
  "switching",
  "linked",
  "rolling-back",
  "rolled-back",
  "failed"
]);

function sanitizeMigration(value: unknown): MigrationRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const id = safeString(input.id, 128);
  const source = safeString(input.source, 32_768);
  const destination = safeString(input.destination, 32_768);
  const stage = input.stage as MigrationRecord["stage"];
  const startedAt = safeString(input.startedAt, 64);
  const updatedAt = safeString(input.updatedAt, 64);
  if (
    !id ||
    !source ||
    !destination ||
    !startedAt ||
    !updatedAt ||
    !migrationStages.has(stage)
  ) {
    return undefined;
  }
  return {
    id,
    source,
    destination,
    stagingPath:
      typeof input.stagingPath === "string"
        ? safeString(input.stagingPath, 32_768)
        : undefined,
    backupPath:
      typeof input.backupPath === "string"
        ? safeString(input.backupPath, 32_768)
        : undefined,
    stage,
    linkType:
      input.linkType === "symbolic-link" || input.linkType === "junction"
        ? input.linkType
        : undefined,
    totalBytes: Math.max(0, safeNumber(input.totalBytes)),
    copiedBytes: Math.max(0, safeNumber(input.copiedBytes)),
    migrationCount: Math.max(
      0,
      Math.floor(
        safeNumber(
          input.migrationCount,
          stage === "linked" || stage === "rolled-back" ? 1 : 0
        )
      )
    ),
    startedAt,
    updatedAt,
    completedAt:
      typeof input.completedAt === "string"
        ? safeString(input.completedAt, 64)
        : undefined,
    error:
      typeof input.error === "string"
        ? safeString(input.error, 8_192)
        : undefined,
    warnings: Array.isArray(input.warnings)
      ? input.warnings
          .filter((item): item is string => typeof item === "string")
          .slice(0, 128)
          .map((item) => item.slice(0, 8_192))
      : []
  };
}

function ownershipMapKey(value: string): string {
  const normalized = path.win32.normalize(value.trim());
  const root = path.win32.parse(normalized).root || normalized;
  return root.replace(/[\\/]+$/, "").toLocaleLowerCase();
}

function sanitizeOwnershipMap(value: unknown): OwnershipMapResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<OwnershipMapResult>;
  if (
    input.schemaVersion !== 3 ||
    typeof input.drive !== "string" ||
    typeof input.scannedAt !== "string" ||
    typeof input.durationMs !== "number" ||
    typeof input.scannedDirectories !== "number" ||
    typeof input.scanTruncated !== "boolean" ||
    typeof input.installedApplications !== "number" ||
    typeof input.portableExecutables !== "number" ||
    !Array.isArray(input.entries) ||
    !Array.isArray(input.scanErrors)
  ) {
    return undefined;
  }
  const validEntries = input.entries.every(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.path === "string" &&
      typeof entry.name === "string" &&
      typeof entry.category === "string" &&
      typeof entry.risk === "string"
  );
  if (!validEntries) return undefined;
  return structuredClone(input as OwnershipMapResult);
}

function mergeSettings(input?: Partial<AppSettings>): AppSettings {
  const aiInput = input?.ai as Partial<AppSettings["ai"]> | undefined;
  const provider =
    typeof aiInput?.provider === "string" ? aiInput.provider : defaults.settings.ai.provider;
  const protocol = ["openai-compatible", "anthropic", "gemini"].includes(
    aiInput?.protocol ?? ""
  )
    ? aiInput!.protocol!
    : defaults.settings.ai.protocol;
  const magnifierModifierParts =
    typeof input?.magnifierModifiers === "string"
      ? input.magnifierModifiers
          .split("+")
          .map((part) => part.trim().toLocaleLowerCase())
      : [];
  const magnifierModifiers = [
    magnifierModifierParts.includes("ctrl") || magnifierModifierParts.includes("control")
      ? "Ctrl"
      : undefined,
    magnifierModifierParts.includes("alt") ? "Alt" : undefined,
    magnifierModifierParts.includes("shift") ? "Shift" : undefined,
    magnifierModifierParts.includes("win") || magnifierModifierParts.includes("meta")
      ? "Win"
      : undefined
  ].filter((part): part is string => Boolean(part));
  return {
    ...defaults.settings,
    ...input,
    effectMode: ["aurora", "matrix", "calm", "ember", "ivory"].includes(
      input?.effectMode ?? ""
    )
      ? input!.effectMode!
      : defaults.settings.effectMode,
    language: [
      "system",
      "zh-CN",
      "zh-TW",
      "en-US",
      "ja-JP",
      "ko-KR",
      "es-ES",
      "fr-FR",
      "de-DE",
      "pt-BR",
      "ru-RU",
      "ar-SA",
      "hi-IN",
      "id-ID",
      "it-IT",
      "tr-TR"
    ].includes(input?.language ?? "")
      ? input!.language!
      : defaults.settings.language,
    uiScale: normalizeStoredUiScale(input?.uiScale, defaults.settings.uiScale),
    globalShortcut:
      typeof input?.globalShortcut === "string"
        ? input.globalShortcut.trim().slice(0, 128)
        : defaults.settings.globalShortcut,
    quickSearchShortcut:
      typeof input?.quickSearchShortcut === "string"
        ? input.quickSearchShortcut.trim().slice(0, 128)
        : defaults.settings.quickSearchShortcut,
    mouseQuickSearchButton: ["disabled", "back", "forward", "middle"].includes(
      input?.mouseQuickSearchButton ?? ""
    )
      ? input!.mouseQuickSearchButton!
      : defaults.settings.mouseQuickSearchButton,
    mouseQuickSearchHoldMs: normalizeStoredMouseHoldMs(
      input?.mouseQuickSearchHoldMs,
      defaults.settings.mouseQuickSearchHoldMs
    ),
    magnifierEnabled: Boolean(input?.magnifierEnabled),
    magnifierModifiers: magnifierModifiers.join("+") || defaults.settings.magnifierModifiers,
    magnifierWidth: Math.round(Math.min(1200, Math.max(160, Number(input?.magnifierWidth) || 480)) / 10) * 10,
    magnifierHeight: Math.round(Math.min(900, Math.max(120, Number(input?.magnifierHeight) || 300)) / 10) * 10,
    indexRoots: Array.isArray(input?.indexRoots) ? input.indexRoots : defaults.settings.indexRoots,
    excludedPaths: Array.isArray(input?.excludedPaths)
      ? input.excludedPaths
      : defaults.settings.excludedPaths,
    ai: {
      ...defaults.settings.ai,
      ...(aiInput ?? {}),
      provider,
      protocol,
      baseUrl:
        typeof aiInput?.baseUrl === "string" && aiInput.baseUrl.trim()
          ? aiInput.baseUrl
          : aiInput?.provider
            ? ""
            : defaults.settings.ai.baseUrl,
      hasApiKey: Boolean(aiInput?.hasApiKey),
      verifiedAt:
        typeof aiInput?.verifiedAt === "string" ? aiInput.verifiedAt : undefined
    }
  };
}

export class AppStore {
  private filePath = "";
  private data: DiskShape = structuredClone(defaults);
  private flushQueue: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    const directory = app.getPath("userData");
    this.filePath = path.join(directory, "cdriveshiftai-state.json");
    await mkdir(directory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<DiskShape>;
      this.data = {
        settings: mergeSettings(parsed.settings),
        migrations: (Array.isArray(parsed.migrations) ? parsed.migrations : [])
          .map(sanitizeMigration)
          .filter((item): item is MigrationRecord => Boolean(item))
          .slice(-2_000),
        directoryDialogPaths: sanitizeDirectoryDialogPaths(parsed.directoryDialogPaths),
        searchWorkspace: sanitizeSearchWorkspace(parsed.searchWorkspace),
        searchBookmarks: (
          Array.isArray(parsed.searchBookmarks) ? parsed.searchBookmarks : []
        )
          .map(sanitizeSearchBookmark)
          .filter((item): item is SearchBookmark => Boolean(item))
          .slice(-500),
        searchBookmarkFolders: (
          Array.isArray(parsed.searchBookmarkFolders)
            ? parsed.searchBookmarkFolders
            : []
        )
          .map(sanitizeSearchBookmarkFolder)
          .filter((item): item is SearchBookmarkFolder => Boolean(item))
          .slice(-100),
        uiLayout: sanitizeUiLayout(parsed.uiLayout),
        analyses: (Array.isArray(parsed.analyses) ? parsed.analyses : [])
          .map(sanitizeAnalysis)
          .filter((item): item is AnalysisResult => Boolean(item))
          .slice(-200),
        ownershipMaps: (Array.isArray(parsed.ownershipMaps) ? parsed.ownershipMaps : [])
          .map(sanitizeOwnershipMap)
          .filter((item): item is OwnershipMapResult => Boolean(item))
          .slice(-32),
        encryptedApiKey:
          typeof parsed.encryptedApiKey === "string" ? parsed.encryptedApiKey : undefined
      };
    } catch {
      await this.flush();
    }
  }

  getSettings(): AppSettings {
    return structuredClone(this.data.settings);
  }

  getDirectoryDialogPath(purpose: DirectoryDialogPurpose): string | undefined {
    return this.data.directoryDialogPaths[purpose];
  }

  async saveDirectoryDialogPath(
    purpose: DirectoryDialogPurpose,
    selectedPath: string
  ): Promise<void> {
    this.data.directoryDialogPaths[purpose] = selectedPath.slice(0, 32_768);
    await this.flush();
  }

  async updateSettings(
    patch: Partial<AppSettings> & { ai?: Partial<AppSettings["ai"]>; apiKey?: string }
  ): Promise<AppSettings> {
    const { apiKey, ...settingsPatch } = patch;
    this.data.settings = mergeSettings({
      ...this.data.settings,
      ...settingsPatch,
      ai: {
        ...this.data.settings.ai,
        ...(settingsPatch.ai ?? {})
      }
    });

    if (typeof apiKey === "string") {
      if (!apiKey) {
        delete this.data.encryptedApiKey;
        this.data.settings.ai.hasApiKey = false;
      } else if (safeStorage.isEncryptionAvailable()) {
        this.data.encryptedApiKey = safeStorage.encryptString(apiKey).toString("base64");
        this.data.settings.ai.hasApiKey = true;
      } else {
        throw new Error("Windows 安全存储当前不可用，API Key 未保存");
      }
    }

    app.setLoginItemSettings({
      openAtLogin: this.data.settings.launchAtLogin,
      args:
        this.data.settings.launchAtLogin && this.data.settings.launchMinimized
          ? ["--startup-minimized"]
          : []
    });
    await this.flush();
    return this.getSettings();
  }

  getApiKey(): string | undefined {
    if (!this.data.encryptedApiKey || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(this.data.encryptedApiKey, "base64"));
    } catch {
      return undefined;
    }
  }

  listMigrations(): MigrationRecord[] {
    return structuredClone(this.data.migrations).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  async saveMigration(record: MigrationRecord): Promise<void> {
    const index = this.data.migrations.findIndex((item) => item.id === record.id);
    if (index >= 0) this.data.migrations[index] = structuredClone(record);
    else this.data.migrations.push(structuredClone(record));
    await this.flush();
  }

  getMigration(id: string): MigrationRecord | undefined {
    const record = this.data.migrations.find((item) => item.id === id);
    return record ? structuredClone(record) : undefined;
  }

  async deleteMigrations(ids: string[]): Promise<number> {
    const selected = new Set(ids);
    const before = this.data.migrations.length;
    this.data.migrations = this.data.migrations.filter(
      (record) => !selected.has(record.id)
    );
    const deleted = before - this.data.migrations.length;
    if (deleted > 0) await this.flush();
    return deleted;
  }

  getSearchWorkspace(): SearchWorkspaceState | undefined {
    return this.data.searchWorkspace
      ? structuredClone(this.data.searchWorkspace)
      : undefined;
  }

  async saveSearchWorkspace(value: unknown): Promise<void> {
    const workspace = sanitizeSearchWorkspace(value);
    if (!workspace) throw new Error("搜索工作区状态无效");
    this.data.searchWorkspace = workspace;
    await this.flush();
  }

  listSearchBookmarks(): SearchBookmark[] {
    return structuredClone(this.data.searchBookmarks).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  async saveSearchBookmark(value: unknown): Promise<SearchBookmark> {
    const bookmark = sanitizeSearchBookmark(value);
    if (!bookmark) throw new Error("搜索书签无效，无法保存");
    const existing = this.data.searchBookmarks.find(
      (item) => item.id === bookmark.id
    );
    const saved = {
      ...bookmark,
      createdAt: existing?.createdAt ?? bookmark.createdAt,
      updatedAt: new Date().toISOString()
    };
    this.data.searchBookmarks = [
      ...this.data.searchBookmarks.filter((item) => item.id !== saved.id),
      saved
    ].slice(-500);
    await this.flush();
    return structuredClone(saved);
  }

  async deleteSearchBookmark(id: string): Promise<boolean> {
    const next = this.data.searchBookmarks.filter((item) => item.id !== id);
    if (next.length === this.data.searchBookmarks.length) return false;
    this.data.searchBookmarks = next;
    await this.flush();
    return true;
  }

  listSearchBookmarkFolders(): SearchBookmarkFolder[] {
    return structuredClone(this.data.searchBookmarkFolders).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
  }

  async saveSearchBookmarkFolder(value: unknown): Promise<SearchBookmarkFolder> {
    const folder = sanitizeSearchBookmarkFolder(value);
    if (!folder) throw new Error("搜索书签文件夹无效，无法保存");
    const existing = this.data.searchBookmarkFolders.find(
      (item) => item.id === folder.id
    );
    const saved = {
      ...folder,
      createdAt: existing?.createdAt ?? folder.createdAt,
      updatedAt: new Date().toISOString()
    };
    this.data.searchBookmarkFolders = [
      ...this.data.searchBookmarkFolders.filter((item) => item.id !== saved.id),
      saved
    ].slice(-100);
    await this.flush();
    return structuredClone(saved);
  }

  async deleteSearchBookmarkFolder(id: string): Promise<boolean> {
    const next = this.data.searchBookmarkFolders.filter((item) => item.id !== id);
    if (next.length === this.data.searchBookmarkFolders.length) return false;
    this.data.searchBookmarkFolders = next;
    this.data.searchBookmarks = this.data.searchBookmarks.map((bookmark) =>
      bookmark.folderId === id
        ? { ...bookmark, folderId: undefined, updatedAt: new Date().toISOString() }
        : bookmark
    );
    await this.flush();
    return true;
  }

  getUiLayout(): UiLayoutState {
    return structuredClone(this.data.uiLayout);
  }

  async updateUiLayout(value: unknown): Promise<UiLayoutState> {
    const patch = sanitizeUiLayout(value);
    this.data.uiLayout = {
      ...this.data.uiLayout,
      ...patch
    };
    await this.flush();
    return this.getUiLayout();
  }

  getAnalysis(targetPath: string): AnalysisResult | undefined {
    const key = analysisKey(targetPath);
    const result = this.data.analyses.find(
      (item) => analysisKey(item.summary.path) === key
    );
    return result ? structuredClone(result) : undefined;
  }

  getLastAnalysis(): AnalysisResult | undefined {
    const result = this.data.analyses.at(-1);
    return result ? structuredClone(result) : undefined;
  }

  async saveAnalysis(result: AnalysisResult): Promise<void> {
    const safe = sanitizeAnalysis(result);
    if (!safe) throw new Error("分析结果无效，无法保存");
    const key = analysisKey(safe.summary.path);
    this.data.analyses = [
      ...this.data.analyses.filter(
        (item) => analysisKey(item.summary.path) !== key
      ),
      safe
    ].slice(-200);
    await this.flush();
  }

  async deleteAnalysis(targetPath: string): Promise<boolean> {
    const key = analysisKey(targetPath);
    const next = this.data.analyses.filter(
      (item) => analysisKey(item.summary.path) !== key
    );
    if (next.length === this.data.analyses.length) return false;
    this.data.analyses = next;
    await this.flush();
    return true;
  }

  getOwnershipMap(drive: string): OwnershipMapResult | undefined {
    const key = ownershipMapKey(drive);
    const result = this.data.ownershipMaps.find(
      (item) => ownershipMapKey(item.drive) === key
    );
    return result ? structuredClone(result) : undefined;
  }

  async saveOwnershipMap(result: OwnershipMapResult): Promise<void> {
    const safe = sanitizeOwnershipMap(result);
    if (!safe) throw new Error("归属地图结果无效，无法保存");
    const key = ownershipMapKey(safe.drive);
    this.data.ownershipMaps = [
      ...this.data.ownershipMaps.filter(
        (item) => ownershipMapKey(item.drive) !== key
      ),
      safe
    ].slice(-32);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.filePath) return;
    const temporaryPath = `${this.filePath}.tmp`;
    const snapshot = JSON.stringify(this.data, null, 2);
    this.flushQueue = this.flushQueue
      .catch(() => undefined)
      .then(async () => {
        await writeFile(temporaryPath, snapshot, "utf8");
        await rename(temporaryPath, this.filePath);
      });
    await this.flushQueue;
  }
}
