import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { access, lstat, readdir, stat } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";
import type {
  ContentIndexerStatus,
  ContentSearchOptions,
  ContentSearchResult,
  DirectorySizeResult,
  IndexerStatus,
  MouseShortcutButton,
  MouseShortcutStatus,
  MagnifierStatus,
  NativeResponse,
  SearchCategory,
  SearchIndexChangedEvent,
  SearchFilters,
  SearchPage,
  SearchPageOptions,
  SearchResult
} from "./types";
import { getLocalDriveRoots, isPathWithin, normalizeWindowsPath } from "./system";
import {
  determineIndexRefreshReason,
  INDEX_REFRESH_INTERVAL_MS
} from "./index-refresh-policy";
import { logger, serializeError } from "./logger";
import { LatestSearchScheduler, SEARCH_SUPERSEDED } from "./search-scheduler";

interface PendingRequest {
  resolve: (response: NativeResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ResultMetadata {
  fileSize?: number;
  modifiedAt: string;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

const wordCharacterPattern = /[\p{L}\p{N}_]/u;
const FOREGROUND_REFRESH_DELAY_MS = 30_000;
const LIVE_SEARCH_MS = 1_200;
const LIVE_DIRECTORY_LIMIT = 320;
const LIVE_ENTRY_LIMIT = 25_000;
const LIVE_RESULT_LIMIT = 240;

// Match the indexer's category filters while the persisted name index is unavailable.
const extensionsByCategory: Partial<Record<SearchCategory, string>> = {
  document: "doc docx odt pdf ppt pptx rtf txt csv xls xlsx",
  image: "apng avif bmp gif heic ico jpeg jpg png svg tif tiff webp",
  video: "avi flv m2ts m4v mkv mov mp4 mpeg mpg webm wmv",
  audio: "aac aiff alac ape flac m4a mp3 ogg opus wav wma",
  archive: "7z bz2 cab gz iso rar tar tgz xz zip zst",
  executable: "appx bat cmd com dll exe msi msix ps1 scr",
  code: "c cc cpp cs css go h hpp html java js jsx json kt kts lua md php pl py rb rs scss sh sql swift toml ts tsx vue xml yaml yml"
};
const categoryByExtension = new Map<string, SearchCategory>();
for (const [category, extensions] of Object.entries(extensionsByCategory)) {
  for (const extension of extensions.split(" ")) categoryByExtension.set(extension, category as SearchCategory);
}

function fileExtension(name: string): string {
  return path.win32.extname(name).slice(1).toLowerCase();
}

function scopedSearchRoots(filters: SearchFilters): string[] {
  const selected = filters.scopes?.length ? filters.scopes : [filters.scope];
  return selected.map((scope) => scope.trim())
    .filter((scope) => scope && scope !== "*" && scope.toLowerCase() !== "all")
    .map((scope) => normalizeWindowsPath(/^[a-z]:$/i.test(scope) ? `${scope}\\` : scope));
}

function containsCompleteWord(target: string, needle: string): boolean {
  let start = target.indexOf(needle);
  while (start >= 0) {
    const before = Array.from(target.slice(0, start)).at(-1);
    const after = Array.from(target.slice(start + needle.length))[0];
    if (
      (!before || !wordCharacterPattern.test(before)) &&
      (!after || !wordCharacterPattern.test(after))
    ) {
      return true;
    }
    start = target.indexOf(needle, start + Math.max(1, needle.length));
  }
  return false;
}

function fuzzySubsequenceScore(target: string, needle: string): number | undefined {
  const wanted = Array.from(needle);
  if (wanted.length === 0) return undefined;
  let wantedIndex = 0;
  let first = -1;
  let last = -1;
  let consecutivePairs = 0;
  let position = 0;
  for (const character of target) {
    if (character === wanted[wantedIndex]) {
      if (first < 0) first = position;
      if (last >= 0 && position === last + 1) consecutivePairs += 1;
      last = position;
      wantedIndex += 1;
      if (wantedIndex === wanted.length) {
        const span = last - first + 1;
        return (
          48 +
          (wanted.length / Math.max(1, span)) * 22 +
          (consecutivePairs / Math.max(1, wanted.length - 1)) * 15 +
          (1 / (1 + first * 0.15)) * 9 +
          (needle.length / Math.max(needle.length, target.length)) * 6
        );
      }
    }
    position += 1;
  }
  return undefined;
}

export class SearchService {
  private child?: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private status: IndexerStatus = {
    mode: "loading",
    state: "idle",
    entries: 0,
    progress: 0,
    root: "本机所有磁盘",
    message: "正在启动自研索引核心"
  };
  private stopping = false;
  private restartCount = 0;
  private executableCatalogCache?: { expiresAt: number; paths: string[] };
  private cachePath?: string;
  private dailyRefreshTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private childStopPromise?: Promise<void>;
  private driveRefreshPromise?: Promise<boolean>;
  private driveRefreshRequested = false;
  private driveRefreshForced = false;
  private driveRefreshRestarted = false;
  private restartingForDrives = false;
  private indexedRoots?: string[];
  private forceNextInitialization = false;
  private hasReadyNameIndex = false;
  private lastFullRefreshRequestedAt = 0;
  private refreshDue = false;
  private backgroundMode = false;
  private readonly queryScheduler = new LatestSearchScheduler();
  private readonly metadataCache = new Map<string, { expiresAt: number; result: ResultMetadata }>();
  private readonly metadataPending = new Map<string, Promise<ResultMetadata>>();
  private resultCacheEpoch = 0;
  private resultCacheExpiryTimer?: NodeJS.Timeout;
  private resultCacheExpiryAt = Infinity;
  private readonly directorySizeCache = new Map<string, { expiresAt: number; result: DirectorySizeResult }>();
  private mouseShortcutStatus: MouseShortcutStatus;
  private magnifierStatus: MagnifierStatus;

  constructor(
    private readonly onStatus: (status: IndexerStatus) => void,
    private readonly onContentStatus: (status: ContentIndexerStatus) => void,
    private readonly onIndexChanged: (event: SearchIndexChangedEvent) => void,
    private readonly onMouseShortcutHold: () => void,
    initialMouseShortcut: { button: MouseShortcutButton; holdMs: number },
    initialMagnifier: { enabled: boolean; modifiers: string; width: number; height: number }
  ) {
    this.mouseShortcutStatus = {
      available: false,
      button: initialMouseShortcut.button,
      holdMs: initialMouseShortcut.holdMs,
      message: "鼠标全局监听正在启动"
    };
    this.magnifierStatus = {
      available: false,
      ...initialMagnifier,
      message: "Windows 全屏局部放大镜正在启动"
    };
  }

  start(): Promise<void> {
    if (this.restartingForDrives) return this.driveRefreshPromise?.then(() => undefined) ?? Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startIndexer().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async startIndexer(): Promise<void> {
    if (this.stopping || this.child) return;
    const executable = app.isPackaged
      ? path.join(process.resourcesPath, "bin", "cshift-indexer.exe")
      : path.resolve(__dirname, "..", "native", "indexer", "target", "release", "cshift-indexer.exe");
    if (!(await fileExists(executable))) {
      this.updateStatus({
        mode: "unavailable",
        state: "error",
        entries: 0,
        progress: 0,
        root: "本机所有磁盘",
        message: "原生索引核心尚未构建；搜索将使用限时实时扫描"
      });
      return;
    }
    if (this.stopping) return;

    const child = spawn(executable, ["--serve"], {
      cwd: app.getPath("userData"),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.hasReadyNameIndex = false;
    this.indexedRoots = undefined;
    logger.info("indexer.spawn_requested", {
      executable,
      backgroundMode: this.backgroundMode
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => { if (this.child === child) this.handleLine(line); });
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.status.message = message.slice(-300);
      if (message) {
        logger.warn("indexer.stderr", { message: message.slice(-2_000) });
      }
      if (message && process.env.CDRIVESHIFTAI_TRIM_DIAGNOSTICS === "1") {
        process.stderr.write(`${message}\n`);
      }
    });
    // A pipe can close between the writable-state check and write(). Node emits
    // an "error" event in addition to invoking the write callback; without a
    // listener that EPIPE becomes an uncaught main-process exception.
    child.stdin.on("error", (error) => {
      logger.warn("indexer.stdin_error", {
        stopping: this.stopping,
        error: serializeError(error)
      });
      if (this.child === child) this.rejectPending(this.restartingForDrives ? new Error(SEARCH_SUPERSEDED) : error);
    });
    child.on("error", (error) => {
      logger.error("indexer.process_error", {
        stopping: this.stopping,
        error: serializeError(error)
      });
      if (this.child === child) this.rejectPending(this.restartingForDrives ? new Error(SEARCH_SUPERSEDED) : error);
    });
    child.on("exit", (code, signal) => {
      logger.info("indexer.exited", {
        code,
        signal,
        stopping: this.stopping,
        restartCount: this.restartCount
      });
      lines.close();
      if (this.child !== child) return;
      this.child = undefined;
      this.rejectPending(new Error(this.restartingForDrives ? SEARCH_SUPERSEDED : `索引进程已退出（${code ?? "unknown"}）`));
      if (!this.stopping && !this.restartingForDrives && this.restartCount < 2) {
        this.restartCount += 1;
        this.updateStatus({ ...this.status, state: "error", message: "索引核心意外退出，正在重启" });
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          void this.start().catch(() => {
            // The child lifecycle handlers already publish the degraded state.
          });
        }, 1_500 * this.restartCount);
      } else if (!this.stopping && !this.restartingForDrives) {
        this.updateStatus({
          ...this.status,
          mode: "unavailable",
          state: "error",
          message: "索引核心不可用；搜索将使用限时实时扫描"
        });
      }
    });

    const cachePath = path.join(app.getPath("userData"), "search-index-v1.bin");
    this.cachePath = cachePath;
    const contentCacheDir = path.join(app.getPath("userData"), "content-indexes");
    try {
      const cacheStats = await stat(cachePath);
      this.refreshDue = determineIndexRefreshReason(
        cacheStats.mtimeMs,
        Date.now(),
        uptime()
      ) != null;
    } catch {
      // A missing cache is the normal first-run case; the native indexer builds it.
      this.refreshDue = false;
    }
    const initialized = await this.request(
      {
        op: "init",
        root: "*",
        forceRebuild: this.forceNextInitialization,
        cachePath,
        contentCacheDir,
        background: this.backgroundMode,
        mouseButton: this.mouseShortcutStatus.button,
        mouseHoldMs: this.mouseShortcutStatus.holdMs,
        magnifierEnabled: this.magnifierStatus.enabled,
        magnifierModifiers: this.magnifierStatus.modifiers,
        magnifierWidth: this.magnifierStatus.width,
        magnifierHeight: this.magnifierStatus.height
      },
      90_000
    );
    this.forceNextInitialization = false;
    this.indexedRoots = initialized.indexedRoots?.map((root) => normalizeWindowsPath(root));
    if (this.backgroundMode) {
      // An indexer that starts directly in tray mode does not observe a later
      // foreground-to-background transition. Re-send the background command
      // after init so it applies the same process-tree working-set trim used
      // when a visible window is closed, without stopping watchers or search.
      await this.request(
        { op: "setBackground", background: true, processId: process.pid },
        3_000
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.queryScheduler.cancelAll();
    this.clearResultCaches();
    logger.info("indexer.stop_started", {
      hasChild: this.child != null,
      pendingRequests: this.pending.size
    });
    this.stopPromise = this.closeIndexer(new Error("索引服务已停止"));
    return this.stopPromise;
  }

  refreshDrives(force = false): Promise<boolean> {
    if (this.stopping) return Promise.resolve(false);
    this.driveRefreshRequested = true;
    // Repeated device notifications for the same insertion share one restart.
    if (!this.driveRefreshRestarted) this.driveRefreshForced ||= force;
    if (!this.driveRefreshPromise) {
      this.driveRefreshPromise = this.refreshDriveSet().catch((error) => {
        if (this.stopping) return false;
        throw error;
      }).finally(() => {
        this.driveRefreshPromise = undefined;
        this.driveRefreshRestarted = false;
      });
    }
    return this.driveRefreshPromise;
  }

  private async refreshDriveSet(): Promise<boolean> {
    let restarted = false;
    while (this.driveRefreshRequested && !this.stopping) {
      this.driveRefreshRequested = false;
      if (this.startPromise) await this.startPromise;
      const roots = await getLocalDriveRoots();
      // Focus can race the deferred initial start while drive discovery awaits.
      if (this.startPromise) await this.startPromise;
      if (this.stopping) break;
      const rootKey = (values: string[]) => [...new Set(values.map((root) => normalizeWindowsPath(root).toLowerCase()))].sort().join("|");
      const force = this.driveRefreshForced;
      this.driveRefreshForced = false;
      if (!force && this.child && this.indexedRoots && rootKey(roots) === rootKey(this.indexedRoots)) continue;

      this.restartingForDrives = true;
      this.driveRefreshRestarted = true;
      this.hasReadyNameIndex = false;
      this.queryScheduler.cancelAll();
      this.clearResultCaches();
      this.updateStatus({ mode: "loading", state: "idle", entries: 0, progress: 0,
        root: "本机所有磁盘", message: "检测到磁盘变化，正在更新名称索引" });
      try {
        await this.closeIndexer(new Error(SEARCH_SUPERSEDED));
      } finally {
        this.restartingForDrives = false;
      }
      if (this.stopping) break;
      this.restartCount = 0;
      this.forceNextInitialization ||= force;
      await this.start();
      restarted = true;
    }
    return restarted;
  }

  private closeIndexer(reason: Error): Promise<void> {
    if (this.childStopPromise) return this.childStopPromise;
    this.childStopPromise = (async () => {
      if (this.dailyRefreshTimer) {
        clearTimeout(this.dailyRefreshTimer);
        this.dailyRefreshTimer = undefined;
      }
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
      }
      const child = this.child;
      if (!child) return;
      if (child.exitCode != null || child.signalCode != null) {
        this.child = undefined;
        this.rejectPending(reason);
        return;
      }
      const exited = once(child, "exit").then(() => true).catch(() => true);
      try {
        await this.requestWithChild(child, { op: "quit" }, 1_500);
      } catch {
        // The process may already be closing. The exit wait and bounded kill
        // below complete shutdown without surfacing a JavaScript error dialog.
      }
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      const graceful = await Promise.race([
        exited,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500))
      ]);
      if (!graceful && child.exitCode == null && !child.killed) {
        logger.warn("indexer.stop_forced", { childPid: child.pid });
        child.kill();
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 500))
        ]);
      }
      if (child.exitCode == null && child.signalCode == null) throw new Error("索引进程尚未退出，稍后重试磁盘刷新");
      if (this.child === child) this.child = undefined;
      this.rejectPending(reason);
      logger.info("indexer.stop_completed", { childPid: child.pid });
    })().finally(() => { this.childStopPromise = undefined; });
    return this.childStopPromise;
  }

  getStatus(): IndexerStatus {
    return structuredClone(this.status);
  }

  getMouseShortcutStatus(): MouseShortcutStatus {
    return structuredClone(this.mouseShortcutStatus);
  }

  async configureMouseShortcut(
    button: MouseShortcutButton,
    holdMs: number
  ): Promise<MouseShortcutStatus> {
    this.mouseShortcutStatus = {
      ...this.mouseShortcutStatus,
      button,
      holdMs,
      message:
        button === "disabled"
          ? "鼠标快捷操作已关闭"
          : this.mouseShortcutStatus.available
            ? "全局鼠标监听可用；短按不会被拦截"
            : "鼠标监听暂不可用"
    };
    if (this.child && !this.restartingForDrives) {
      const response = (await this.request(
        { op: "setMouseShortcut", mouseButton: button, mouseHoldMs: holdMs },
        3_000
      )) as NativeResponse & { available?: boolean };
      this.mouseShortcutStatus.available = response.available === true;
      this.mouseShortcutStatus.message =
        button === "disabled"
          ? "鼠标快捷操作已关闭"
          : response.available
            ? "全局鼠标监听可用；短按不会被拦截"
            : "Windows Raw Input 监听不可用";
    }
    return this.getMouseShortcutStatus();
  }

  getMagnifierStatus(): MagnifierStatus {
    return structuredClone(this.magnifierStatus);
  }

  async setMagnifierCapture(active: boolean): Promise<boolean> {
    if (this.child && !this.restartingForDrives) {
      await this.request(
        { op: "setMagnifierCapture", magnifierCaptureActive: active },
        3_000
      );
    }
    return active;
  }

  async configureMagnifier(
    enabled: boolean,
    modifiers: string,
    width: number,
    height: number
  ): Promise<MagnifierStatus> {
    this.magnifierStatus = {
      ...this.magnifierStatus,
      enabled,
      modifiers,
      width,
      height,
      message: enabled
        ? "按住组合键时显示局部放大镜，滚动滚轮可调倍率"
        : "全屏局部放大镜已关闭"
    };
    if (this.child && !this.restartingForDrives) {
      const response = (await this.request(
        {
          op: "setMagnifier",
          magnifierEnabled: enabled,
          magnifierModifiers: modifiers,
          magnifierWidth: width,
          magnifierHeight: height
        },
        3_000
      )) as NativeResponse & { available?: boolean };
      this.magnifierStatus.available = response.available === true;
      this.magnifierStatus.message = response.available
        ? enabled
          ? "按住组合键时显示局部放大镜，滚动滚轮可调倍率"
          : "全屏局部放大镜已关闭"
        : "当前 Windows 环境无法创建全局局部放大镜";
    }
    return this.getMagnifierStatus();
  }

  setBackgroundMode(background: boolean, force = false): void {
    if (!force && this.backgroundMode === background) return;
    this.backgroundMode = background;
    if (background) {
      this.queryScheduler.cancelAll();
      this.clearResultCaches();
    } else if (this.refreshDue && this.status.state === "ready" && !this.dailyRefreshTimer) {
      this.scheduleRefreshTimer(FOREGROUND_REFRESH_DELAY_MS);
    }
    if (!this.child || this.restartingForDrives) return;
    void this.request(
      { op: "setBackground", background, processId: process.pid },
      3_000
    ).catch(() => {
      // The process may be between a crash and its automatic restart. start()
      // includes the current mode in init, so no retry loop is needed here.
    });
  }

  private clearResultCaches(): void {
    this.executableCatalogCache = undefined;
    this.metadataCache.clear();
    this.metadataPending.clear();
    this.resultCacheEpoch++;
    this.directorySizeCache.clear();
    if (this.resultCacheExpiryTimer) clearTimeout(this.resultCacheExpiryTimer);
    this.resultCacheExpiryTimer = undefined;
    this.resultCacheExpiryAt = Infinity;
  }

  private scheduleResultCacheExpiry(expiresAt: number): void {
    // Batch expirations from nearby stats so a large page needs one cleanup.
    expiresAt = Math.ceil(expiresAt / 1_000) * 1_000;
    if (expiresAt >= this.resultCacheExpiryAt || this.stopping) return;
    if (this.resultCacheExpiryTimer) clearTimeout(this.resultCacheExpiryTimer);
    this.resultCacheExpiryAt = expiresAt;
    this.resultCacheExpiryTimer = setTimeout(() => {
      this.resultCacheExpiryTimer = undefined;
      this.resultCacheExpiryAt = Infinity;
      const now = Date.now();
      let earliest = Infinity;
      for (const cache of [this.metadataCache, this.directorySizeCache]) {
        for (const [key, entry] of cache) {
          if (entry.expiresAt <= now) cache.delete(key);
          else earliest = Math.min(earliest, entry.expiresAt);
        }
      }
      if (this.executableCatalogCache) {
        if (this.executableCatalogCache.expiresAt <= now) this.executableCatalogCache = undefined;
        else earliest = Math.min(earliest, this.executableCatalogCache.expiresAt);
      }
      this.scheduleResultCacheExpiry(earliest);
    }, Math.max(0, expiresAt - Date.now()));
    this.resultCacheExpiryTimer.unref();
  }

  cancelWindowSearch(ownerId: number): void {
    this.queryScheduler.cancel(`query:${ownerId}`);
    this.queryScheduler.cancel(`sizes:${ownerId}`);
    this.queryScheduler.cancel(`properties:${ownerId}`);
  }

  private async cachedMetadata(target: string): Promise<ResultMetadata> {
    const key = target.toLocaleLowerCase();
    const cached = this.metadataCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    const pending = this.metadataPending.get(key);
    if (pending) return pending;
    const epoch = this.resultCacheEpoch;
    const request = lstat(target).then((stats) => {
      const result = {
        fileSize: stats.isFile() ? stats.size : undefined,
        modifiedAt: stats.mtime.toISOString()
      };
      if (epoch === this.resultCacheEpoch && !this.backgroundMode && !this.stopping) {
        if (this.metadataCache.size >= 4_096) this.metadataCache.delete(this.metadataCache.keys().next().value!);
        const expiresAt = Date.now() + 5_000;
        this.metadataCache.set(key, { result, expiresAt });
        this.scheduleResultCacheExpiry(expiresAt);
      }
      return result;
    }).finally(() => { if (this.metadataPending.get(key) === request) this.metadataPending.delete(key); });
    this.metadataPending.set(key, request);
    return request;
  }

  async rebuild(automatic = false): Promise<void> {
    if (!this.child) {
      await this.start();
      if (!this.child) throw new Error("原生索引核心不可用");
    }
    await this.request({ op: "rebuild", ...(automatic ? { rebuildReason: "daily" } : {}) }, 5_000);
    this.executableCatalogCache = undefined;
  }

  async listExecutablePaths(): Promise<string[]> {
    if (
      this.executableCatalogCache &&
      Date.now() < this.executableCatalogCache.expiresAt
    ) {
      return [...this.executableCatalogCache.paths];
    }
    if (!this.child || this.status.state === "error") return [];
    const epoch = this.resultCacheEpoch;
    const response = await this.request(
      { op: "executableCatalog", limit: 30_000 },
      20_000
    );
    const paths = ((response.results ?? []) as SearchResult[])
      .filter((item) => !item.isDirectory && item.path.toLocaleLowerCase().endsWith(".exe"))
      .map((item) => item.path);
    if (epoch === this.resultCacheEpoch && !this.backgroundMode && !this.stopping) {
      const expiresAt = Date.now() + 10 * 60_000;
      this.executableCatalogCache = { expiresAt, paths };
      this.scheduleResultCacheExpiry(expiresAt);
    }
    return [...paths];
  }

  async indexContent(scope: string): Promise<void> {
    if (!this.child) throw new Error("原生索引核心不可用");
    await this.request({ op: "contentIndex", scope }, 8_000);
  }

  async contentIndexStatus(scope: string): Promise<ContentIndexerStatus> {
    if (!this.child) throw new Error("原生索引核心不可用");
    const response = await this.request({ op: "contentStatus", scope }, 8_000);
    return response.status as ContentIndexerStatus;
  }

  async searchContent(
    query: string,
    scope: string,
    options: ContentSearchOptions = {}
  ): Promise<ContentSearchResult[]> {
    return (await this.searchContentPage(query, scope, options)).items;
  }

  async searchContentPage(
    query: string,
    scope: string,
    options: ContentSearchOptions & SearchPageOptions = {},
    ownerId: number | string = "default"
  ): Promise<SearchPage<ContentSearchResult>> {
    if (this.backgroundMode || this.stopping) return { items: [], hasMore: false, generation: 0 };
    this.queryScheduler.cancel(`sizes:${ownerId}`);
    return this.queryScheduler.run(`query:${ownerId}`, (isCurrent) => this.runContentSearchPage(query, scope, options, isCurrent));
  }

  private async runContentSearchPage(
    query: string,
    scope: string,
    options: ContentSearchOptions & SearchPageOptions,
    isCurrent: () => boolean
  ): Promise<SearchPage<ContentSearchResult>> {
    const limit = Math.min(2_000, Math.max(1, Math.trunc(options.limit ?? 80)));
    if (!this.child) throw new Error("原生索引核心不可用");
    const response = await this.request(
      {
        op: "contentQuery",
        query: query.trim(),
        keywords: options.keywords,
        keywordMatch: "any",
        scope,
        regex: options.regex === true,
        caseSensitive: options.caseSensitive === true,
        sortBy: options.sortBy ?? "relevance",
        sortDirection: options.sortDirection ?? "desc",
        minSize: options.minSize,
        maxSize: options.maxSize,
        modifiedAfterMs: options.modifiedAfter
          ? Date.parse(options.modifiedAfter)
          : undefined,
        modifiedBeforeMs: options.modifiedBefore
          ? Date.parse(options.modifiedBefore)
          : undefined,
        cursor: options.cursor,
        limit
      },
      options.regex ? 30_000 : 15_000
    );
    if (!isCurrent()) throw new Error(SEARCH_SUPERSEDED);
    const nativeResults = (response.results ?? []) as Array<ContentSearchResult & { modifiedAtMs?: number }>;
    const results: ContentSearchResult[] = [];
    for (let offset = 0; offset < nativeResults.length; offset += 32) {
      if (!isCurrent()) throw new Error(SEARCH_SUPERSEDED);
      const batch = await Promise.all(nativeResults.slice(offset, offset + 32).map(async (result) => {
        // Content search already reads size and timestamp from its indexed row.
        // Avoid a second disk read for every hit on every keystroke.
        if (Number.isFinite(result.modifiedAtMs) && result.modifiedAtMs! > 0) {
          return { ...result, modifiedAt: new Date(result.modifiedAtMs!).toISOString() };
        }
        try {
          const metadata = await this.cachedMetadata(result.path);
          return { ...result, size: metadata.fileSize ?? 0, modifiedAt: metadata.modifiedAt };
        } catch { return result; }
      }));
      results.push(...batch);
    }
    return {
      items: results,
      hasMore: response.hasMore === true,
      nextCursor: response.nextCursor,
      totalMatches: response.totalMatches,
      generation: response.generation ?? 0,
      cursorReset: response.cursorReset === true
    };
  }

  async search(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    return (await this.searchPage(query, filters)).items;
  }

  async searchPage(
    query: string,
    filters: SearchFilters,
    options: SearchPageOptions = {},
    ownerId: number | string = "default"
  ): Promise<SearchPage<SearchResult>> {
    if (this.backgroundMode || this.stopping) return { items: [], hasMore: false, generation: 0 };
    this.queryScheduler.cancel(`sizes:${ownerId}`);
    return this.queryScheduler.run(`query:${ownerId}`, (isCurrent) => this.runSearchPage(query, filters, options, isCurrent));
  }

  private async runSearchPage(
    query: string,
    filters: SearchFilters,
    options: SearchPageOptions,
    isCurrent: () => boolean
  ): Promise<SearchPage<SearchResult>> {
    const trimmed = query.trim();
    if (!trimmed) {
      return { items: [], hasMore: false, generation: 0 };
    }
    const limit = Math.min(10_000, Math.max(1, Math.trunc(options.limit ?? 240)));
    const roots = scopedSearchRoots(filters);
    let results: SearchResult[];
    let hasMore = false;
    let nextCursor: string | undefined;
    let totalMatches: number | undefined;
    let generation = 0;
    let cursorReset = false;
    const indexAvailable = Boolean(this.child && this.status.state !== "error");
    const usingNative = indexAvailable && (this.hasReadyNameIndex || this.status.state === "ready");
    if (usingNative) {
      const response = await this.request(
        {
          op: "query",
          query: trimmed,
          keywords: filters.keywords,
          keywordMatch: "any",
          kind: filters.kind,
          scope: roots[0] ?? "*",
          scopes: roots,
          categories: filters.categories ?? [],
          extensions: filters.extensions ?? [],
          caseSensitive: filters.caseSensitive ?? false,
          wholeWord: filters.wholeWord ?? false,
          fuzzy: filters.fuzzy ?? false,
          matchPath: filters.matchPath ?? false,
          regex: filters.regex ?? false,
          sortBy: filters.sortBy ?? "relevance",
          sortDirection: filters.sortDirection ?? "desc",
          minSize: filters.minSize,
          maxSize: filters.maxSize,
          modifiedAfterMs: filters.modifiedAfter
            ? Date.parse(filters.modifiedAfter)
            : undefined,
          modifiedBeforeMs: filters.modifiedBefore
            ? Date.parse(filters.modifiedBefore)
            : undefined,
          cursor: options.cursor,
          limit
        },
        filters.regex ||
          filters.matchPath ||
          filters.sortBy === "size" ||
          filters.sortBy === "modified" ||
          filters.minSize != null ||
          filters.maxSize != null ||
          filters.modifiedAfter != null ||
          filters.modifiedBefore != null
          ? 60_000
          : 20_000
      );
      results = (response.results ?? []) as SearchResult[];
      hasMore = response.hasMore === true;
      nextCursor = response.nextCursor;
      totalMatches = response.totalMatches;
      generation = response.generation ?? 0;
      cursorReset = response.cursorReset === true;
    } else {
      // During startup, keep regex on the native linear-time matcher once it is ready.
      results = filters.regex && indexAvailable ? [] : await this.liveSearch(trimmed, roots, filters, isCurrent);
    }

    const enriched: SearchResult[] = [];
    const statConcurrency = 48;
    for (let offset = 0; offset < results.length; offset += statConcurrency) {
      if (!isCurrent()) throw new Error(SEARCH_SUPERSEDED);
      const batch = results.slice(offset, offset + statConcurrency);
      const resolved = await Promise.all(
        batch.map(async (result): Promise<SearchResult | undefined> => {
          try {
            const metadata = await this.cachedMetadata(result.path);
            return {
              ...result,
              size: metadata.fileSize ?? result.size,
              modifiedAt: metadata.modifiedAt
            };
          } catch {
            // 缓存加载后若某项在应用关闭期间已被删除，不向用户返回失效路径。
            return undefined;
          }
        })
      );
      enriched.push(
        ...resolved.filter((item): item is SearchResult => Boolean(item))
      );
    }

    if (!usingNative) return this.liveSearchPage(enriched, filters, options, limit);
    return {
      items: enriched,
      hasMore,
      nextCursor,
      totalMatches,
      generation,
      cursorReset
    };
  }

  private liveSearchPage(results: SearchResult[], filters: SearchFilters, options: SearchPageOptions, limit: number): SearchPage<SearchResult> {
    const modifiedAfter = Date.parse(filters.modifiedAfter ?? "");
    const modifiedBefore = Date.parse(filters.modifiedBefore ?? "");
    const modifiedAt = (item: SearchResult) => Date.parse(item.modifiedAt ?? "");
    const filtered = results.filter((item) =>
      !(filters.minSize != null && item.size < filters.minSize) &&
      !(filters.maxSize != null && item.size > filters.maxSize) &&
      !(modifiedAt(item) < modifiedAfter) && !(modifiedAt(item) > modifiedBefore)
    );
    const direction = filters.sortDirection === "asc" ? 1 : -1;
    const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
    const category = (item: SearchResult) => item.isDirectory ? "folder" : categoryByExtension.get(fileExtension(item.name)) ?? "other";
    filtered.sort((first, second) => {
      let comparison: number;
      switch (filters.sortBy) {
        case "name": comparison = collator.compare(first.name, second.name); break;
        case "path": comparison = collator.compare(first.path, second.path); break;
        case "size": comparison = first.size - second.size; break;
        case "modified": comparison = modifiedAt(first) - modifiedAt(second); break;
        case "type": comparison = category(first).localeCompare(category(second)) || fileExtension(first.name).localeCompare(fileExtension(second.name)); break;
        default: comparison = first.score - second.score;
      }
      return comparison * direction || collator.compare(first.path, second.path);
    });
    const cursor = /^fallback:(\d{1,4})$/.exec(options.cursor ?? "");
    const offset = cursor ? Number(cursor[1]) : 0;
    const items = filtered.slice(offset, offset + limit);
    const hasMore = offset + items.length < filtered.length;
    return {
      items,
      hasMore,
      nextCursor: hasMore ? `fallback:${offset + items.length}` : undefined,
      generation: 0,
      cursorReset: options.cursor != null && !cursor,
      partial: true
    };
  }

  async directorySizes(inputPaths: string[], ownerId: number | string = "default", purpose: "search" | "properties" = "search"): Promise<DirectorySizeResult[]> {
    if (this.backgroundMode || this.stopping) {
      if (purpose === "properties") throw new Error("窗口已隐藏或程序正在退出，目录统计已暂停；请重新打开属性");
      return [];
    }
    const key = purpose === "properties" ? `properties:${ownerId}` : `sizes:${ownerId}`;
    return this.queryScheduler.run(key, (isCurrent) => this.runDirectorySizes(inputPaths, isCurrent, purpose));
  }

  private async runDirectorySizes(inputPaths: string[], isCurrent: () => boolean, purpose: "search" | "properties"): Promise<DirectorySizeResult[]> {
    const epoch = this.resultCacheEpoch;
    const ready: DirectorySizeResult[] = [];
    const normalizedTargets = new Map<
      string,
      { path: string; bytes: number; files: number; directories: number; complete: boolean }
    >();
    for (const candidate of inputPaths.slice(0, 24)) {
      const value = path.resolve(candidate);
      const key = value.toLocaleLowerCase();
      const cached = this.directorySizeCache.get(key);
      if (cached && cached.expiresAt > Date.now() && (purpose !== "properties" || cached.result.complete)) {
        if (!ready.some((result) => result.path.toLocaleLowerCase() === key)) ready.push({ ...cached.result });
        continue;
      }
      if (!normalizedTargets.has(key)) {
        normalizedTargets.set(key, {
          path: value,
          bytes: 0,
          files: 0,
          directories: 1,
          complete: true
        });
      }
    }
    if (normalizedTargets.size === 0) return ready;

    const roots: string[] = [];
    for (const target of [...normalizedTargets.values()].sort(
      (first, second) => first.path.length - second.path.length
    )) {
      const lower = target.path.toLocaleLowerCase();
      if (
        !roots.some((root) => {
          const rootLower = root.toLocaleLowerCase();
          return lower === rootLower || lower.startsWith(`${rootLower}\\`);
        })
      ) {
        roots.push(target.path);
      }
    }

    const markAncestors = (
      parentPath: string,
      bytes: number,
      files: number,
      directories: number
    ) => {
      let current = path.resolve(parentPath);
      while (true) {
        const target = normalizedTargets.get(current.toLocaleLowerCase());
        if (target) {
          target.bytes += bytes;
          target.files += files;
          target.directories += directories;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    };

    const deadline = Date.now() + (purpose === "properties" ? 25_000 : 2_000);
    const maximumEntries = purpose === "properties" ? 1_000_000 : 25_000;
    let visited = 0;
    const scanRoot = async (root: string) => {
      const queue = [root];
      let queueOffset = 0;
      let complete = true;
      while (queueOffset < queue.length) {
        if (!isCurrent() || this.backgroundMode || this.stopping) throw new Error(SEARCH_SUPERSEDED);
        if (Date.now() > deadline || visited >= maximumEntries) {
          complete = false;
          break;
        }
        const current = queue[queueOffset++];
        try {
          const entries = await readdir(current, { withFileTypes: true });
          for (const entry of entries) {
            if (!isCurrent() || this.backgroundMode || this.stopping) throw new Error(SEARCH_SUPERSEDED);
            visited += 1;
            if (entry.isSymbolicLink()) continue;
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
              queue.push(entryPath);
              markAncestors(current, 0, 0, 1);
              continue;
            }
            if (!entry.isFile()) continue;
            try {
              const stats = await lstat(entryPath);
              markAncestors(current, stats.size, 1, 0);
            } catch {
              complete = false;
            }
            if (Date.now() > deadline || visited >= maximumEntries) {
              complete = false;
              break;
            }
          }
        } catch (error) {
          if (error instanceof Error && error.message === SEARCH_SUPERSEDED) throw error;
          complete = false;
        }
      }
      if (!complete) {
        const rootLower = root.toLocaleLowerCase();
        for (const [key, target] of normalizedTargets) {
          if (key === rootLower || key.startsWith(`${rootLower}\\`)) {
            target.complete = false;
          }
        }
      }
    };

    for (let offset = 0; offset < roots.length; offset += 2) {
      await Promise.all(roots.slice(offset, offset + 2).map(scanRoot));
    }
    if (!isCurrent() || this.backgroundMode || this.stopping) throw new Error(SEARCH_SUPERSEDED);
    const results = [...normalizedTargets.values()];
    if (epoch === this.resultCacheEpoch && !this.backgroundMode && !this.stopping) {
      for (const result of results) {
        // Incomplete counts are estimates and expire quickly.
        if (this.directorySizeCache.size >= 256) this.directorySizeCache.delete(this.directorySizeCache.keys().next().value!);
        const expiresAt = Date.now() + (result.complete ? 30_000 : 2_000);
        this.directorySizeCache.set(result.path.toLocaleLowerCase(), { result: { ...result }, expiresAt });
        this.scheduleResultCacheExpiry(expiresAt);
      }
    }
    return [...ready, ...results];
  }

  private async liveSearch(
    query: string,
    roots: string[],
    filters: SearchFilters,
    isCurrent: () => boolean
  ): Promise<SearchResult[]> {
    const deadline = Date.now() + LIVE_SEARCH_MS;
    const normalizedQuery = filters.caseSensitive ? query : query.toLocaleLowerCase();
    const rawTokens = filters.keywords?.length ? filters.keywords : filters.regex ? [query] : query.split(/\s+/).filter(Boolean);
    const tokens = rawTokens.map((token) => filters.caseSensitive ? token : token.toLocaleLowerCase());
    const expressions = filters.regex ? rawTokens.map((token) => new RegExp(token, filters.caseSensitive ? "u" : "iu")) : undefined;
    const categories = new Set(filters.categories);
    const extensions = new Set(filters.extensions?.map((value) => value.replace(/^\.+/, "").toLowerCase()));
    const queue: string[] = [];
    const queued = new Set<string>();
    const addDirectory = (candidate: string) => {
      const key = candidate.toLowerCase();
      if (queue.length >= LIVE_DIRECTORY_LIMIT || queued.has(key)) return;
      queued.add(key);
      queue.push(candidate);
    };
    // Exact folders take precedence. With a broad scope the user's usual file locations
    // are more useful than traversing Windows and Program Files before Downloads.
    const driveRoot = /^[a-z]:\\$/i;
    for (const root of roots) if (!driveRoot.test(root)) addDirectory(root);
    for (const folder of ["downloads", "desktop", "documents"] as const) {
      try {
        const candidate = normalizeWindowsPath(app.getPath(folder));
        if (roots.length ? roots.some((root) => isPathWithin(candidate, root)) : /^[a-z]:\\/i.test(candidate)) {
          addDirectory(candidate);
        }
      } catch {
        // A known folder may not exist on this Windows profile.
      }
    }
    for (const root of roots) addDirectory(root);
    if (roots.length === 0) {
      void getLocalDriveRoots().then((drives) => {
        for (const drive of drives) addDirectory(drive);
      }).catch(() => undefined);
      const homeDrive = path.win32.parse(app.getPath("home")).root;
      if (driveRoot.test(homeDrive)) addDirectory(homeDrive);
    }
    const results: SearchResult[] = [];
    let visitedEntries = 0;
    for (let offset = 0; offset < queue.length && Date.now() < deadline && results.length < LIVE_RESULT_LIMIT; offset++) {
      if (!isCurrent() || this.backgroundMode || this.stopping) throw new Error(SEARCH_SUPERSEDED);
      const current = queue[offset];
      try {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          if (!isCurrent() || this.backgroundMode || this.stopping) throw new Error(SEARCH_SUPERSEDED);
          if (++visitedEntries > LIVE_ENTRY_LIMIT || Date.now() >= deadline) return results;
          if (entry.isSymbolicLink()) continue;
          const entryPath = path.win32.join(current, entry.name);
          const isDirectory = entry.isDirectory();
          if (isDirectory) addDirectory(entryPath);
          if ((filters.kind === "folder" && !isDirectory) || (filters.kind === "file" && !entry.isFile())) continue;
          if (categories.size || extensions.size) {
            const extension = fileExtension(entry.name);
            const category = isDirectory ? "folder" : categoryByExtension.get(extension) ?? "other";
            if (categories.size && !categories.has(category)) continue;
            if (extensions.size && (isDirectory || !extensions.has(extension))) continue;
          }
          const originalTarget = filters.matchPath ? entryPath : entry.name;
          const target = filters.caseSensitive
            ? originalTarget
            : originalTarget.toLocaleLowerCase();
          let score: number | undefined;
          if (expressions?.some((expression) => expression.test(originalTarget))) {
            score = 72;
          } else if (!expressions && filters.fuzzy) {
            const tokenScores = tokens.map((token) => fuzzySubsequenceScore(target, token));
            if (tokenScores.some((value) => value != null)) {
              score = tokenScores.reduce<number>((sum, value) => sum + (value ?? 0), 0) /
                Math.max(1, tokenScores.length);
            }
          } else if (
            !expressions &&
            filters.wholeWord &&
            tokens.some((token) => containsCompleteWord(target, token))
          ) {
            score = 82;
          } else if (!expressions && !filters.fuzzy && !filters.wholeWord &&
            tokens.some((token) => target.includes(token))) {
            score = target === normalizedQuery ? 100 : target.startsWith(normalizedQuery) ? 92 : 70;
          }
          if (score != null) {
            results.push({
              path: entryPath,
              name: entry.name,
              isDirectory,
              size: 0,
              score,
              source: "live-scan"
            });
            if (results.length >= LIVE_RESULT_LIMIT) return results;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message === SEARCH_SUPERSEDED) throw error;
        // Access-denied directories are expected during fallback scanning.
      }
    }
    return results;
  }

  private request(
    payload: Record<string, unknown>,
    timeout = 10_000
  ): Promise<NativeResponse> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("索引核心未运行"));
    return this.requestWithChild(child, payload, timeout);
  }

  private requestWithChild(
    child: ChildProcessWithoutNullStreams,
    payload: Record<string, unknown>,
    timeout: number
  ): Promise<NativeResponse> {
    if (
      child.exitCode != null ||
      child.killed ||
      child.stdin.destroyed ||
      child.stdin.writableEnded ||
      !child.stdin.writable
    ) {
      return Promise.reject(new Error("索引通信管道已关闭"));
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logger.warn("indexer.request_timeout", {
          operation: typeof payload.op === "string" ? payload.op : "unknown",
          timeout,
          stopping: this.stopping
        });
        reject(new Error("索引请求超时"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          logger.warn("indexer.request_write_failed", {
            operation: typeof payload.op === "string" ? payload.op : "unknown",
            stopping: this.stopping,
            error: serializeError(error)
          });
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        logger.warn("indexer.request_write_threw", {
          operation: typeof payload.op === "string" ? payload.op : "unknown",
          stopping: this.stopping,
          error: serializeError(error)
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let response: NativeResponse;
    try {
      response = JSON.parse(line) as NativeResponse;
    } catch {
      return;
    }
    if (this.restartingForDrives && response.event) return;
    if (response.event === "status" && response.status) {
      this.updateStatus(response.status as IndexerStatus);
      return;
    }
    if (
      (response as NativeResponse & { event?: string; status?: ContentIndexerStatus }).event ===
        "contentStatus" &&
      (response as NativeResponse & { status?: ContentIndexerStatus }).status
    ) {
      this.onContentStatus(
        (response as NativeResponse & { status: ContentIndexerStatus }).status
      );
      return;
    }
    if (response.event === "mouseShortcutHold") {
      this.onMouseShortcutHold();
      return;
    }
    if (response.event === "indexChanged") {
      const changedCount = response.changedCount ?? 1;
      if (changedCount > 0) this.clearResultCaches();
      this.onIndexChanged({
        changedCount,
        observedAt: new Date().toISOString(),
        generation: response.generation,
        contentScopes: response.contentScopes
      });
      return;
    }
    if (response.event === "mouseShortcutStatus") {
      const event = response as NativeResponse & {
        available?: boolean;
        errorCode?: number;
      };
      this.mouseShortcutStatus.available = event.available === true;
      this.mouseShortcutStatus.message = event.available
        ? this.mouseShortcutStatus.button === "disabled"
          ? "鼠标快捷操作已关闭"
          : "全局鼠标监听可用；短按不会被拦截"
        : `Windows Raw Input 监听不可用${
            event.errorCode ? `（错误 ${event.errorCode}）` : ""
          }`;
      return;
    }
    if (response.event === "magnifierStatus") {
      const event = response as NativeResponse & { available?: boolean; errorCode?: number };
      this.magnifierStatus.available = event.available === true;
      this.magnifierStatus.message = event.available
        ? this.magnifierStatus.enabled
          ? "全屏局部放大镜可用"
          : "全屏局部放大镜已关闭"
        : `Windows 放大镜不可用${event.errorCode ? `（错误 ${event.errorCode}）` : ""}`;
      return;
    }
    if (response.id == null) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok === false) pending.reject(new Error(response.error || "索引请求失败"));
    else pending.resolve(response);
  }

  private updateStatus(status: IndexerStatus): void {
    const previousState = this.status.state;
    const previousMode = this.status.mode;
    if (status.state === "indexing" && previousState !== "indexing") {
      this.lastFullRefreshRequestedAt = Date.now();
      this.refreshDue = false;
      if (this.dailyRefreshTimer) {
        clearTimeout(this.dailyRefreshTimer);
        this.dailyRefreshTimer = undefined;
      }
    }
    this.status = structuredClone(status);
    if (status.state === "ready") this.hasReadyNameIndex = true;
    if (status.state !== previousState || status.mode !== previousMode) {
      logger.info("indexer.status_changed", {
        previousState,
        previousMode,
        state: status.state,
        mode: status.mode,
        entries: status.entries,
        progress: status.progress,
        message: status.message
      });
    }
    this.onStatus(this.getStatus());
    if (status.state === "ready" && previousState !== "ready") {
      void this.scheduleDailyRefresh();
    }
  }

  private async scheduleDailyRefresh(): Promise<void> {
    if (this.dailyRefreshTimer) {
      clearTimeout(this.dailyRefreshTimer);
      this.dailyRefreshTimer = undefined;
    }
    if (this.stopping || !this.cachePath) return;
    // Make cached results usable before starting a scan after a reboot or
    // when yesterday's cache is still present.
    if (this.refreshDue) {
      if (!this.backgroundMode) this.scheduleRefreshTimer(FOREGROUND_REFRESH_DELAY_MS);
      return;
    }

    let cacheModifiedAt = 0;
    try {
      cacheModifiedAt = (await stat(this.cachePath)).mtimeMs;
    } catch {
      // A completed scan normally creates the cache. If writing failed, retry
      // no sooner than 24 hours after the scan attempt to avoid a rebuild loop.
    }
    const refreshBase = Math.max(
      cacheModifiedAt,
      this.lastFullRefreshRequestedAt,
      Date.now() - INDEX_REFRESH_INTERVAL_MS + 1_000
    );
    const delay = Math.max(
      1_000,
      refreshBase + INDEX_REFRESH_INTERVAL_MS - Date.now()
    );
    if (!this.stopping && this.status.state === "ready") this.scheduleRefreshTimer(delay);
  }

  private scheduleRefreshTimer(delay: number): void {
    if (this.dailyRefreshTimer) clearTimeout(this.dailyRefreshTimer);
    this.dailyRefreshTimer = setTimeout(() => {
      this.dailyRefreshTimer = undefined;
      if (this.stopping) return;
      if (this.backgroundMode) {
        this.refreshDue = true;
        return;
      }
      this.refreshDue = false;
      void this.rebuild(true).catch((error) => {
        this.updateStatus({
          ...this.status,
          state: "error",
          message: `每日自动刷新索引失败：${
            error instanceof Error ? error.message : String(error)
          }`
        });
      });
    }, delay);
  }
}
