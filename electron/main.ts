import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type OpenDialogOptions
} from "electron";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, readlink, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeLocally, scanOwnershipMap, summarizeDirectory } from "./analyzer";
import { enhanceAnalysisWithAi } from "./ai";
import {
  completeAiText,
  discoverAiModels,
  validateAiConnection,
  type ResolvedAiConnection
} from "./ai-client";
import { configureApplicationDataPaths } from "./data-root";
import { createDiagnosticReport } from "./diagnostics";
import { normalizeDirectoryDialogPurpose } from "./directory-dialog";
import { openDeleteHelper } from "./delete-helper";
import { ExplorerContextMenuService } from "./explorer-context-menu";
import { createForceDeleteLaunchData, ForceDeleteLaunchQueue, parseForceDeleteLaunch } from "./force-delete-launch";
import { ForceDeleteService } from "./force-delete";
import { assertNoMigrationPathMutation, assertRenameDestinationAvailable, migrationRecordDeletionReason } from "./file-operation-guard";
import { nativeStrings, resolveNativeLanguage } from "./i18n";
import {
  configureLogger,
  getLogDirectory,
  logger,
  serializeError
} from "./logger";
import { MigrationService } from "./migration";
import { SearchService } from "./search";
import { normalizeStoredUiScale } from "./settings-normalization";
import { AppStore } from "./store";
import { createTrayMenuIcon, type TrayIconKind } from "./tray-icons";
import {
  completePendingUpdate,
  UpdateService,
  type AppUpdateInfo
} from "./update";
import {
  getDriveInfo,
  getLocalDriveRoots,
  isElevated,
  isHighRiskApplicationPath,
  PROTECTED_PATHS,
  protectedReason,
  systemIdentity
} from "./system";
import type {
  AiConnectionInput,
  AiDraftSaveInput,
  AiSaveInput,
  AppSettings,
  AiProviderId,
  ShortcutCheckResult,
  ShortcutTarget,
  SearchCategory,
  SearchContextActionResult,
  SearchFilters,
  SearchSortDirection,
  SearchSortField,
  WindowLayoutBounds
} from "./types";

const applicationDataRoot = configureApplicationDataPaths();
configureLogger(applicationDataRoot);
crashReporter.start({ uploadToServer: false, compress: false });

process.on("uncaughtException", (error) => {
  const details = serializeError(error);
  logger.error("process.uncaught_exception", { error: details, isQuitting });
  if ((error as NodeJS.ErrnoException).code === "EPIPE" || isQuitting) return;
  if (app.isReady()) {
    dialog.showErrorBox(
      "CDriveShiftAI 运行错误",
      `程序已记录错误。请在设置中导出诊断报告，或打开日志目录后将最新日志发给开发者。\n\n${error.message}`
    );
  }
});

process.on("unhandledRejection", (reason) => {
  logger.error("process.unhandled_rejection", { error: serializeError(reason) });
});

let mainWindow: BrowserWindow | undefined;
let quickSearchWindow: BrowserWindow | undefined;
let uninstallRestoreWindow: BrowserWindow | undefined;
let forceDeleteWindow: BrowserWindow | undefined;
let searchService: SearchService | undefined;
let updateService: UpdateService | undefined;
let tray: Tray | undefined;
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | undefined;
let visibleUpdateCheckTimer: NodeJS.Timeout | undefined;
let mainWindowRecoveryTimer: NodeJS.Timeout | undefined;
let lastVisibleUpdateCheckAt = 0;
const store = new AppStore();
const explorerContextMenu = new ExplorerContextMenuService({
  isPackaged: app.isPackaged,
  executablePath: process.execPath,
  appPath: app.getAppPath(),
  portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE
});
const forceDeleteLaunches = new ForceDeleteLaunchQueue();
let fileRequestWindowReady = false;
let migrationService: MigrationService;
const aiVerifications = new Map<string, { fingerprint: string; expiresAt: number }>();
const forceDeleteService = new ForceDeleteService({
  applicationExecutable: process.execPath,
  applicationDataRoot,
  createVerificationId: randomUUID,
  assertPathAllowed: assertFileMutationAllowed
});
let settingsUpdateQueue: Promise<unknown> = Promise.resolve();
let fileMutationCount = 0;
const pendingFileMutations = new Set<Promise<unknown>>();

async function assertFileMutationAllowed(targetPath: string): Promise<void> {
  if (migrationService?.isBusy()) throw new Error("迁移或恢复正在执行，请完成后再删除或重命名");
  await assertNoMigrationPathMutation(targetPath, store.listMigrations(), [path.dirname(process.execPath), applicationDataRoot]);
}

async function runFileMutation<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
  if (isQuitting) throw new Error("程序正在退出，无法开始新的文件操作");
  if (forceDeleteService.isBusy() || fileMutationCount > 0) throw new Error("其他文件操作正在执行，请完成后重试");
  fileMutationCount++;
  const pending = (async () => {
    await assertFileMutationAllowed(targetPath);
    return operation();
  })();
  pendingFileMutations.add(pending);
  try {
    return await pending;
  } finally { fileMutationCount--; pendingFileMutations.delete(pending); }
}

function assertMigrationCanStart(): void {
  if (isQuitting) throw new Error("程序正在退出，无法开始新的迁移或恢复");
  if (fileMutationCount > 0 || forceDeleteService.isBusy()) throw new Error("文件操作正在执行，请完成后再迁移或恢复");
}

function serializeSettingsUpdate<T>(operation: () => Promise<T>): Promise<T> {
  if (isQuitting) return Promise.reject(new Error("程序正在退出，无法保存新设置"));
  const pending = settingsUpdateQueue.catch(() => undefined).then(operation);
  settingsUpdateQueue = pending.catch(() => undefined);
  return pending;
}

function applyLoginSettings(settings: AppSettings): void {
  const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE?.trim();
  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    ...(portableExecutable ? { path: portableExecutable } : {}),
    args: [
      ...(!app.isPackaged ? [app.getAppPath()] : []),
      ...(settings.launchAtLogin && settings.launchMinimized ? ["--startup-minimized"] : [])
    ]
  });
}

function syncSearchBackgroundMode(): void {
  const hasVisibleWindow = [mainWindow, quickSearchWindow, uninstallRestoreWindow].some(
    (window) =>
      window != null &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized()
  );
  searchService?.setBackgroundMode(!hasVisibleWindow);
}

function trackWindowActivity(window: BrowserWindow, role: "main" | "quick" | "force-delete"): void {
  const sync = () => setImmediate(syncSearchBackgroundMode);
  window.on("show", sync);
  window.on("hide", sync);
  window.on("minimize", sync);
  window.on("restore", sync);
  window.on("closed", sync);
  window.on("unresponsive", () => {
    logger.warn("window.unresponsive", {
      title: window.getTitle(),
      url: window.webContents.getURL()
    });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logger.error("renderer.gone", {
      title: window.getTitle(),
      reason: details.reason,
      exitCode: details.exitCode
    });
    if (
      role === "main" &&
      !isQuitting &&
      window.isVisible() &&
      details.reason !== "clean-exit"
    ) {
      if (mainWindowRecoveryTimer) clearTimeout(mainWindowRecoveryTimer);
      mainWindowRecoveryTimer = setTimeout(() => {
        mainWindowRecoveryTimer = undefined;
        if (isQuitting || mainWindow !== window) return;
        logger.warn("renderer.recovering", { reason: details.reason });
        if (!window.isDestroyed()) window.destroy();
        mainWindow = createWindow();
      }, 250);
      mainWindowRecoveryTimer.unref();
    }
  });
}

const effectColors: Record<
  AppSettings["effectMode"],
  { background: string; symbols: string; nativeTheme: "dark" | "light" }
> = {
  aurora: { background: "#183841", symbols: "#f2e7c6", nativeTheme: "dark" },
  matrix: { background: "#050815", symbols: "#a8eefa", nativeTheme: "dark" },
  calm: { background: "#edf4f5", symbols: "#526f7e", nativeTheme: "light" },
  ember: { background: "#0b0705", symbols: "#ffb078", nativeTheme: "dark" },
  ivory: { background: "#f6f2ea", symbols: "#75534b", nativeTheme: "light" }
};

function applyNativeEffect(
  effect: AppSettings["effectMode"],
  window?: BrowserWindow
): void {
  const colors = effectColors[effect];
  nativeTheme.themeSource = colors.nativeTheme;
  if (!window || window.isDestroyed()) return;
  window.setBackgroundColor(colors.background);
  if (process.platform === "win32" && window !== forceDeleteWindow) {
    window.setTitleBarOverlay({
      color: "#00000000",
      symbolColor: colors.symbols,
      height: 48
    });
  }
}

function rendererUrl(
  baseUrl: string,
  effect: AppSettings["effectMode"],
  parameters: Record<string, string> = {}
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("effect", effect);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function applicationIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "assets", "icon.png")
    : path.resolve(__dirname, "..", "build", "icon.png");
}

function loadRenderer(
  window: BrowserWindow,
  effect: AppSettings["effectMode"],
  parameters: Record<string, string> = {}
): void {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void window.loadURL(rendererUrl(devServerUrl, effect, parameters));
    return;
  }
  void window.loadURL(
    rendererUrl(
      pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).toString(),
      effect,
      parameters
    )
  );
}

function assertString(value: unknown, label: string, maxLength = 32_768): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function resolveAiConnection(raw: unknown): {
  input: AiConnectionInput;
  connection: ResolvedAiConnection;
} {
  if (!raw || typeof raw !== "object") throw new Error("AI 连接配置无效");
  const input = raw as AiConnectionInput;
  const current = store.getSettings().ai;
  let apiKey =
    typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : undefined;
  if (!apiKey && input.useSavedKey) {
    if (current.provider !== input.provider || !current.hasApiKey) {
      throw new Error("当前厂商没有可复用的已保存 API Key，请重新填写");
    }
    apiKey = store.getApiKey();
    if (!apiKey) throw new Error("无法解密已保存的 API Key，请重新填写");
  }
  return {
    input,
    connection: validateAiConnection({ ...input, apiKey })
  };
}

function aiFingerprint(connection: ResolvedAiConnection): string {
  const keyHash = createHash("sha256").update(connection.apiKey ?? "").digest("hex");
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: connection.provider,
        protocol: connection.protocol,
        baseUrl: connection.baseUrl,
        model: connection.model ?? "",
        keyHash
      })
    )
    .digest("hex");
}

function pruneAiVerifications(): void {
  const now = Date.now();
  for (const [id, verification] of aiVerifications) {
    if (verification.expiresAt <= now) aiVerifications.delete(id);
  }
}

function restoreWindowBounds(
  saved: WindowLayoutBounds | undefined,
  minWidth: number,
  minHeight: number
): WindowLayoutBounds | undefined {
  if (!saved) return undefined;
  const bounds = {
    x: saved.x,
    y: saved.y,
    width: Math.max(minWidth, saved.width),
    height: Math.max(minHeight, saved.height)
  };
  const display = screen.getAllDisplays().find(({ workArea }) => {
    const overlapWidth = Math.max(
      0,
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
        Math.max(bounds.x, workArea.x)
    );
    const overlapHeight = Math.max(
      0,
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
        Math.max(bounds.y, workArea.y)
    );
    return overlapWidth >= 120 && overlapHeight >= 48;
  });
  if (!display) return undefined;
  const width = Math.min(bounds.width, display.workArea.width);
  const height = Math.min(bounds.height, display.workArea.height);
  return {
    x: Math.max(
      display.workArea.x,
      Math.min(bounds.x, display.workArea.x + display.workArea.width - width)
    ),
    y: Math.max(
      display.workArea.y,
      Math.min(bounds.y, display.workArea.y + display.workArea.height - height)
    ),
    width,
    height,
    maximized: saved.maximized
  };
}

function trackWindowBounds(
  window: BrowserWindow,
  key: "mainWindowBounds" | "quickSearchWindowBounds"
): void {
  let timer: NodeJS.Timeout | undefined;
  const persist = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    void store.updateUiLayout({
      [key]: {
        ...bounds,
        maximized: window.isMaximized()
      }
    });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 250);
  };
  window.on("move", schedule);
  window.on("resize", schedule);
  window.on("maximize", persist);
  window.on("unmaximize", persist);
  window.on("close", persist);
  window.on("closed", () => {
    if (timer) clearTimeout(timer);
  });
}

function showAsSoonAsRenderable(window: BrowserWindow, maximized = false): void {
  let shown = false;
  const show = () => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    if (maximized) window.maximize();
    window.show();
  };
  // ready-to-show may be delayed by GPU initialization or a busy first paint.
  // dom-ready is sufficient because the document has an effect-matched opaque
  // background, so showing here improves perceived startup without a white flash.
  window.webContents.once("dom-ready", show);
  window.once("ready-to-show", show);
  const fallback = setTimeout(show, 1_200);
  fallback.unref();
  window.once("closed", () => clearTimeout(fallback));
}

function applyUiScale(window: BrowserWindow, scale: AppSettings["uiScale"]): void {
  if (!window.isDestroyed()) window.webContents.send("settings:text-scale-preview", scale);
}

function initializeUiScale(window: BrowserWindow, scale: AppSettings["uiScale"]): void {
  applyUiScale(window, scale);
  window.webContents.on("did-finish-load", () => {
    applyUiScale(window, store.getSettings().uiScale);
  });
}

function createWindow(): BrowserWindow {
  const settings = store.getSettings();
  const effect = settings.effectMode;
  const strings = nativeStrings(settings.language);
  const colors = effectColors[effect];
  const restored = restoreWindowBounds(
    store.getUiLayout().mainWindowBounds,
    1100,
    720
  );
  const window = new BrowserWindow({
    width: restored?.width ?? 1480,
    height: restored?.height ?? 920,
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: colors.background,
    icon: applicationIconPath(),
    title: `CDriveShiftAI · ${strings.tagline}`,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: colors.symbols,
      height: 48
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: true,
      devTools: !app.isPackaged
    }
  });

  initializeUiScale(window, settings.uiScale);
  window.setMenuBarVisibility(false);
  trackWindowActivity(window, "main");
  window.on("restore", () => triggerVisibleUpdateCheck("main-window-restored"));
  trackWindowBounds(window, "mainWindowBounds");
  window.on("close", (event) => {
    if (isQuitting || !store.getSettings().minimizeToTray) return;
    event.preventDefault();
    window.hide();
    // Force a native background notification even if visibility events raced
    // during startup. Besides pausing heavy work, this trims reclaimable pages
    // across the resident process tree after the renderer is released.
    searchService?.setBackgroundMode(true, true);
    createTray();
    // A hidden Chromium renderer and its GPU surfaces otherwise remain the
    // largest part of the tray working set. Search, watchers, global
    // shortcuts and the tray all live in the main/native processes, so the UI
    // can be destroyed after its persisted layout/state has been saved and
    // recreated on demand without reducing background accuracy.
    setTimeout(() => {
      if (!window.isDestroyed() && !window.isVisible()) window.destroy();
    }, 150);
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  showAsSoonAsRenderable(window, Boolean(restored?.maximized));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith("file:");
    if (!allowed) event.preventDefault();
  });

  loadRenderer(window, effect);
  return window;
}

function emitSettingsChanged(settings: AppSettings): void {
  const strings = nativeStrings(settings.language);
  for (const window of [mainWindow, quickSearchWindow, forceDeleteWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("settings:changed", settings);
      applyNativeEffect(settings.effectMode, window);
      applyUiScale(window, settings.uiScale);
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(`CDriveShiftAI · ${strings.tagline}`);
  }
  if (quickSearchWindow && !quickSearchWindow.isDestroyed()) {
    quickSearchWindow.setTitle(strings.quickWindow);
  }
  if (forceDeleteWindow && !forceDeleteWindow.isDestroyed()) {
    forceDeleteWindow.setTitle(forceDeleteWindowTitle(settings.language));
  }
  if (uninstallRestoreWindow && !uninstallRestoreWindow.isDestroyed()) {
    uninstallRestoreWindow.setTitle(strings.uninstallWindow);
    applyUiScale(uninstallRestoreWindow, settings.uiScale);
  }
}

function emitUpdateState(state: AppUpdateInfo): void {
  for (const window of [mainWindow, quickSearchWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("app:update-status", state);
    }
  }
}

function triggerVisibleUpdateCheck(reason: string, delayMs = 0): void {
  if (!updateService || isQuitting) return;
  const busyPhases = new Set(["checking", "downloading", "verifying", "ready", "installing"]);
  if (busyPhases.has(updateService.getState().phase)) return;
  if (visibleUpdateCheckTimer) {
    clearTimeout(visibleUpdateCheckTimer);
    visibleUpdateCheckTimer = undefined;
  }
  const run = () => {
    visibleUpdateCheckTimer = undefined;
    if (!updateService || isQuitting) return;
    if (busyPhases.has(updateService.getState().phase)) return;
    if (Date.now() - lastVisibleUpdateCheckAt < 1_500) return;
    lastVisibleUpdateCheckAt = Date.now();
    logger.info("update.visible_check", { reason });
    void updateService.check(true).catch((error) => {
      logger.warn("update.visible_check_failed", {
        reason,
        error: serializeError(error)
      });
    });
  };
  if (delayMs > 0) {
    visibleUpdateCheckTimer = setTimeout(run, delayMs);
    visibleUpdateCheckTimer.unref();
  } else {
    run();
  }
}

function assertUpdateCanInstall(): Promise<void> {
  const busyStages = new Set([
    "preflight",
    "copying",
    "verifying",
    "switching",
    "rolling-back"
  ]);
  const busy = store.listMigrations().find((record) => busyStages.has(record.stage));
  if (busy || migrationService?.isBusy() || forceDeleteService.isBusy() || fileMutationCount > 0) {
    return Promise.reject(
      new Error("当前有迁移或恢复事务正在执行；完成后才能更新程序")
    );
  }
  return Promise.resolve();
}

function sendNavigation(
  window: BrowserWindow,
  event: { view: string; path?: string; focus?: "ai-settings" | "search-input" }
): void {
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send("app:navigate", event);
  };
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
  else send();
}

function showForceDeleteRequests(): void {
  if (!fileRequestWindowReady || !forceDeleteLaunches.pending || isQuitting) return;
  if (!forceDeleteWindow || forceDeleteWindow.isDestroyed()) {
    forceDeleteWindow = createForceDeleteWindow();
  } else {
    if (forceDeleteWindow.isMinimized()) forceDeleteWindow.restore();
    forceDeleteWindow.show();
    forceDeleteWindow.focus();
  }
  // React also drains after subscribing, avoiding a cold-start listener race.
  forceDeleteWindow.webContents.send("shell:force-delete-requests-available");
}

function forceDeleteWindowTitle(language: AppSettings["language"]): string {
  const resolved = resolveNativeLanguage(language);
  if (resolved === "zh-CN") return "强制永久删除";
  if (resolved === "zh-TW") return "強制永久刪除";
  return "Permanently delete";
}

function createForceDeleteWindow(): BrowserWindow {
  const settings = store.getSettings();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(760, display.workArea.width);
  const height = Math.min(700, display.workArea.height);
  const window = new BrowserWindow({
    width,
    height,
    x: display.workArea.x + Math.round((display.workArea.width - width) / 2),
    y: display.workArea.y + Math.round((display.workArea.height - height) / 2),
    minWidth: Math.min(600, width),
    minHeight: Math.min(520, height),
    show: false,
    frame: false,
    minimizable: true,
    maximizable: false,
    backgroundColor: effectColors[settings.effectMode].background,
    icon: applicationIconPath(),
    title: forceDeleteWindowTitle(settings.language),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: true,
      devTools: !app.isPackaged
    }
  });
  forceDeleteWindow = window;
  initializeUiScale(window, settings.uiScale);
  window.setMenuBarVisibility(false);
  trackWindowActivity(window, "force-delete");
  window.on("close", (event) => {
    // Keep the result surface alive through process release and UAC retries.
    // A normal application quit already waits for this service to finish.
    if (!isQuitting && forceDeleteService.isBusy()) event.preventDefault();
  });
  window.on("closed", () => {
    if (forceDeleteWindow === window) forceDeleteWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith("file:");
    if (!allowed) event.preventDefault();
  });
  showAsSoonAsRenderable(window);
  loadRenderer(window, settings.effectMode, { mode: "force-delete" });
  return window;
}

function acceptForceDeleteLaunch(argv: readonly string[], additionalData?: unknown): boolean {
  try {
    const target = parseForceDeleteLaunch(argv, additionalData);
    if (!target) return false;
    forceDeleteLaunches.enqueue(target);
    showForceDeleteRequests();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("force_delete.invalid_launch", { message });
    void app.whenReady().then(() => dialog.showErrorBox("无法打开强制删除", message));
  }
  return true;
}

function showMainView(
  view: "overview" | "search" | "ownership-map" | "analyze" | "migrate" | "history" | "settings",
  options: { path?: string; focus?: "ai-settings" | "search-input" } = {}
): void {
  const shouldCheckForUpdates =
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !mainWindow.isVisible() ||
    mainWindow.isMinimized();
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  sendNavigation(mainWindow, { view, ...options });
  if (shouldCheckForUpdates) triggerVisibleUpdateCheck("main-window-restored");
}

function createQuickSearchWindow(): BrowserWindow {
  if (quickSearchWindow && !quickSearchWindow.isDestroyed()) {
    quickSearchWindow.show();
    quickSearchWindow.focus();
    sendNavigation(quickSearchWindow, { view: "search", focus: "search-input" });
    return quickSearchWindow;
  }
  const settings = store.getSettings();
  const strings = nativeStrings(settings.language);
  const colors = effectColors[settings.effectMode];
  const restored = restoreWindowBounds(
    store.getUiLayout().quickSearchWindowBounds,
    1080,
    580
  );
  const window = new BrowserWindow({
    width: restored?.width ?? 1180,
    height: restored?.height ?? 780,
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: 1080,
    minHeight: 580,
    show: false,
    backgroundColor: colors.background,
    icon: applicationIconPath(),
    title: strings.quickWindow,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: colors.symbols,
      height: 42
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: true,
      devTools: !app.isPackaged
    }
  });
  quickSearchWindow = window;
  initializeUiScale(window, settings.uiScale);
  window.setMenuBarVisibility(false);
  trackWindowActivity(window, "quick");
  trackWindowBounds(window, "quickSearchWindowBounds");
  window.once("ready-to-show", () => {
    if (restored?.maximized) window.maximize();
    window.show();
  });
  window.on("closed", () => {
    quickSearchWindow = undefined;
  });
  loadRenderer(window, settings.effectMode, { mode: "quick-search" });
  return window;
}

function createUninstallRestoreWindow(): BrowserWindow {
  const settings = store.getSettings();
  const strings = nativeStrings(settings.language);
  const colors = effectColors[settings.effectMode];
  const window = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 760,
    minHeight: 560,
    show: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: colors.background,
    icon: applicationIconPath(),
    title: strings.uninstallWindow,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: colors.symbols,
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  uninstallRestoreWindow = window;
  initializeUiScale(window, settings.uiScale);
  window.setMenuBarVisibility(false);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    uninstallRestoreWindow = undefined;
    app.quit();
  });
  loadRenderer(window, settings.effectMode, { mode: "uninstall-restore" });
  return window;
}

const trayAiProviders: Array<{
  id: AiProviderId;
  label: string;
  protocol: AppSettings["ai"]["protocol"];
  baseUrl: string;
}> = [
  { id: "openai", label: "OpenAI", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic Claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { id: "gemini", label: "Google Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  { id: "deepseek", label: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1" },
  { id: "moonshot", label: "Moonshot / Kimi", protocol: "openai-compatible", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "ollama", label: "Ollama", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" }
];

async function chooseTrayAiProvider(providerId: AiProviderId): Promise<void> {
  return serializeSettingsUpdate(async () => {
  const preset = trayAiProviders.find((item) => item.id === providerId);
  if (!preset) return;
  const current = store.getSettings();
  const updated = await store.updateSettings({
    ai: {
      ...current.ai,
      enabled: false,
      provider: preset.id,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: "",
      hasApiKey: false,
      verifiedAt: undefined
    },
    apiKey: ""
  });
  emitSettingsChanged(updated);
  createTray();
  showMainView("settings", { focus: "ai-settings" });
  });
}

function createTray(): void {
  const settings = store.getSettings();
  const strings = nativeStrings(settings.language);
  if (!tray) {
    const image = nativeImage.createFromPath(applicationIconPath()).resize({
      width: 20,
      height: 20
    });
    tray = new Tray(image);
    tray.on("double-click", () => showMainView("overview"));
  }
  tray.setToolTip(`CDriveShiftAI · ${strings.tagline}`);

  const providerLabel =
    trayAiProviders.find((item) => item.id === settings.ai.provider)?.label ??
    settings.ai.provider;
  const viewItems: MenuItemConstructorOptions[] = [
    [strings.overview, "overview", "overview"],
    [strings.search, "search", "search"],
    [strings.ownership, "ownership-map", "map"],
    [strings.analyze, "analyze", "ai"],
    [strings.migrate, "migrate", "move"],
    [strings.history, "history", "history"]
  ].map(([label, view, icon]) => ({
    label,
    icon: createTrayMenuIcon(icon as TrayIconKind),
    click: () => showMainView(view as Parameters<typeof showMainView>[0])
  }));

  const template: MenuItemConstructorOptions[] = [
    {
      label: strings.open,
      icon: createTrayMenuIcon("app"),
      click: () => showMainView("overview")
    },
    {
      label: strings.quickSearch,
      icon: createTrayMenuIcon("search", "#45aaba"),
      click: () => createQuickSearchWindow()
    },
    { type: "separator" },
    {
      label: strings.quickFunctions,
      icon: createTrayMenuIcon("quick", "#d9a441"),
      submenu: viewItems
    },
    {
      label: `${strings.aiService} · ${providerLabel}`,
      icon: createTrayMenuIcon("ai", settings.ai.enabled ? "#32a879" : "#9a7b45"),
      submenu: [
        {
          label: settings.ai.verifiedAt
            ? `${settings.ai.enabled ? strings.enabled : strings.paused} · ${settings.ai.model || providerLabel}`
            : strings.notTested,
          icon: createTrayMenuIcon("ai-status"),
          enabled: false
        },
        { type: "separator" },
        ...trayAiProviders.map<MenuItemConstructorOptions>((provider) => ({
          label: provider.label,
          type: "radio",
          checked: settings.ai.provider === provider.id,
          icon: createTrayMenuIcon(
            provider.id as Extract<
              TrayIconKind,
              "openai" | "anthropic" | "gemini" | "deepseek" | "moonshot" | "ollama"
            >,
            settings.ai.provider === provider.id ? "#2d9a8d" : "#75848c"
          ),
          click: () => {
            void chooseTrayAiProvider(provider.id).catch((error) => {
              void dialog.showErrorBox(
                strings.unableAi,
                error instanceof Error ? error.message : String(error)
              );
            });
          }
        })),
        { type: "separator" },
        {
          label: strings.configureAi,
          icon: createTrayMenuIcon("ai-config"),
          click: () => showMainView("settings", { focus: "ai-settings" })
        }
      ]
    },
    {
      label: strings.theme,
      icon: createTrayMenuIcon("theme", "#a36fd1"),
      submenu: ([
        ["aurora", strings.aurora],
        ["matrix", strings.matrix],
        ["calm", strings.calm],
        ["ember", strings.ember],
        ["ivory", strings.ivory]
      ] as const).map(([effectMode, label]) => ({
        label,
        type: "radio" as const,
        checked: settings.effectMode === effectMode,
        icon: createTrayMenuIcon(
          `theme-${effectMode}` as
            | "theme-aurora"
            | "theme-matrix"
            | "theme-calm"
            | "theme-ember"
            | "theme-ivory"
        ),
        click: () => {
          void serializeSettingsUpdate(() => store.updateSettings({ effectMode })).then((updated) => {
            emitSettingsChanged(updated);
            createTray();
          }).catch((error) => logger.error("settings.tray_update_failed", { error: serializeError(error) }));
        }
      }))
    },
    {
      label: strings.settings,
      icon: createTrayMenuIcon("settings"),
      click: () => showMainView("settings")
    },
    { type: "separator" },
    {
      label: strings.exit,
      icon: createTrayMenuIcon("exit", "#bd5d5d"),
      click: () => app.quit()
    }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function applyGlobalShortcuts(settings: AppSettings): string[] {
  globalShortcut.unregisterAll();
  const failures: string[] = [];
  const registrations: Array<[string, string, () => void]> = [
    [settings.globalShortcut, "打开主界面", () => showMainView("overview")],
    [
      settings.quickSearchShortcut,
      "独立极速搜索",
      () => createQuickSearchWindow()
    ]
  ];
  for (const [accelerator, label, handler] of registrations) {
    const value = accelerator.trim();
    if (!value) continue;
    try {
      if (!globalShortcut.register(value, handler)) {
        failures.push(`${label}快捷键“${value}”已被其他程序占用`);
      }
    } catch {
      failures.push(`${label}快捷键“${value}”格式无效`);
    }
  }
  return failures;
}

function shortcutForTarget(
  settings: AppSettings,
  target: ShortcutTarget
): string {
  return target === "main"
    ? settings.globalShortcut.trim()
    : settings.quickSearchShortcut.trim();
}

function sameShortcut(first: string, second: string): boolean {
  return first.trim().toLocaleLowerCase() === second.trim().toLocaleLowerCase();
}

function assertShortcutTarget(value: unknown): ShortcutTarget {
  if (value === "main" || value === "quick-search") return value;
  throw new Error("快捷键目标无效");
}

function checkShortcutAvailability(
  shortcutInput: string,
  target: ShortcutTarget
): ShortcutCheckResult {
  const shortcut = shortcutInput.trim();
  if (!shortcut) {
    return {
      available: false,
      active: false,
      shortcut,
      message: "未设置快捷键"
    };
  }

  const settings = store.getSettings();
  const ownShortcut = shortcutForTarget(settings, target);
  const otherShortcut = shortcutForTarget(
    settings,
    target === "main" ? "quick-search" : "main"
  );
  if (otherShortcut && sameShortcut(shortcut, otherShortcut)) {
    return {
      available: false,
      active: false,
      shortcut,
      message: "与另一个 CDriveShiftAI 功能的快捷键冲突"
    };
  }
  if (sameShortcut(shortcut, ownShortcut) && globalShortcut.isRegistered(shortcut)) {
    return {
      available: true,
      active: true,
      shortcut,
      message: "已注册，当前可以全局唤起"
    };
  }
  if (globalShortcut.isRegistered(shortcut)) {
    return {
      available: false,
      active: false,
      shortcut,
      message: "该快捷键已被 CDriveShiftAI 的其他功能占用"
    };
  }

  try {
    const registered = globalShortcut.register(shortcut, () => undefined);
    if (!registered) {
      return {
        available: false,
        active: false,
        shortcut,
        message: "该快捷键已被其他程序或 Windows 占用"
      };
    }
    globalShortcut.unregister(shortcut);
    return {
      available: true,
      active: false,
      shortcut,
      message: "组合键可用，保存后即可全局唤起"
    };
  } catch {
    return {
      available: false,
      active: false,
      shortcut,
      message: "快捷键格式无效，请重新录入"
    };
  }
}

function showSearchContextMenu(
  window: BrowserWindow,
  targetPath: string,
  isDirectory: boolean
): Promise<SearchContextActionResult> {
  return new Promise((resolve) => {
    let completed = false;
    let chosen = false;
    const finish = (result: SearchContextActionResult) => {
      if (completed) return;
      completed = true;
      resolve(result);
    };
    const run = (operation: () => Promise<SearchContextActionResult>) => {
      chosen = true;
      void operation()
        .then(finish)
        .catch((error) =>
          finish({
            action: "error",
            message: error instanceof Error ? error.message : String(error)
          })
        );
    };

    const menu = Menu.buildFromTemplate([
      {
        label: isDirectory ? "打开文件夹" : "使用系统默认方式打开",
        click: () =>
          run(async () => {
            const error = await shell.openPath(targetPath);
            if (error) throw new Error(error);
            return { action: "opened" };
          })
      },
      {
        label: "在文件资源管理器中显示",
        click: () =>
          run(async () => {
            shell.showItemInFolder(targetPath);
            return { action: "revealed" };
          })
      },
      ...(!isDirectory
        ? [
            {
              label: "选择其他应用打开…",
              click: () =>
                run(async () => {
                  const selection = await dialog.showOpenDialog(window, {
                    title: "选择用于打开文件的应用程序",
                    properties: ["openFile", "dontAddToRecent"],
                    filters: [
                      { name: "应用程序", extensions: ["exe", "com", "bat", "cmd"] },
                      { name: "所有文件", extensions: ["*"] }
                    ]
                  });
                  const application = selection.filePaths[0];
                  if (selection.canceled || !application) return { action: "dismissed" };
                  const child = spawn(application, [targetPath], {
                    detached: true,
                    shell: false,
                    stdio: "ignore",
                    windowsHide: false
                  });
                  child.unref();
                  return { action: "opened-with" };
                })
            }
          ]
        : []),
      ...(isDirectory
        ? [
            { type: "separator" as const },
            {
              label: "分析目录归属",
              click: () => {
                chosen = true;
                finish({ action: "analyze" });
              }
            }
          ]
        : []),
      { type: "separator" },
      {
        label: "删除到回收站",
        click: () =>
          run(async () => {
            const protection = protectedReason(targetPath);
            if (protection) throw new Error(`受保护路径不能删除：${protection}`);
            const highRisk = isHighRiskApplicationPath(targetPath);
            const confirmation = await dialog.showMessageBox(window, {
              type: "warning",
              title: "确认删除到回收站",
              message: `确定删除“${path.basename(targetPath)}”吗？`,
              detail: highRisk
                ? `这是应用安装目录，删除可能导致程序无法运行。\n\n${targetPath}`
                : `项目将被移入 Windows 回收站，可以在回收站中恢复。\n\n${targetPath}`,
              buttons: ["取消", "删除到回收站"],
              defaultId: 0,
              cancelId: 0,
              noLink: true
            });
            if (confirmation.response !== 1) return { action: "dismissed" };
            await runFileMutation(targetPath, () => shell.trashItem(targetPath));
            return { action: "deleted", message: "已移入回收站" };
          })
      }
    ]);
    menu.popup({
      window,
      callback: () => {
        if (!chosen) finish({ action: "dismissed" });
      }
    });
  });
}

function registerIpc(): void {
  ipcMain.handle("system:overview", async () => {
    const roots = await getLocalDriveRoots();
    return {
      drives: await Promise.all(roots.map((root) => getDriveInfo(root))),
      protectedPaths: PROTECTED_PATHS,
      isElevated: await isElevated(),
      ...systemIdentity(),
      indexer: searchService?.getStatus() ?? {
        mode: "loading",
        state: "idle",
        entries: 0,
        progress: 0,
        root: "本机所有磁盘"
      }
    };
  });

  ipcMain.handle("settings:get", () => store.getSettings());
  ipcMain.handle("app:update-check", (_event, force?: unknown) =>
    updateService?.check(force === true)
  );
  ipcMain.handle("app:update-state", () => updateService?.getState());
  ipcMain.handle("app:update-start", () => updateService?.downloadAndInstall());
  ipcMain.handle("app:update-cancel", () => updateService?.cancel());
  ipcMain.handle("diagnostics:open-logs", async () => {
    const result = await shell.openPath(getLogDirectory());
    if (result) throw new Error(`无法打开日志目录：${result}`);
  });
  ipcMain.handle("diagnostics:export", async () => {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "-",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0")
    ].join("");
    const options = {
      title: "导出 CDriveShiftAI 诊断报告",
      defaultPath: path.join(
        path.dirname(process.execPath),
        `CDriveShiftAI-diagnostics-${stamp}.json`
      ),
      filters: [{ name: "JSON 诊断报告", extensions: ["json"] }]
    };
    const selected = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (selected.canceled || !selected.filePath) return { cancelled: true };
    const report = await createDiagnosticReport({
      applicationDataRoot,
      logDirectory: getLogDirectory(),
      settings: store.getSettings(),
      update: updateService?.getState(),
      indexer: searchService?.getStatus(),
      migrations: store.listMigrations()
    });
    await writeFile(selected.filePath, report, { encoding: "utf8", mode: 0o600 });
    logger.info("diagnostics.exported", { reportPath: selected.filePath });
    return { cancelled: false, path: selected.filePath };
  });
  ipcMain.handle("settings:update", (_event, patch: unknown) => serializeSettingsUpdate(async () => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("设置内容无效");
    const { ai: _ignoredAi, apiKey: _ignoredApiKey, ...safePatch } = patch as Record<
      string,
      unknown
    >;
    if ("forceDeleteContextMenu" in safePatch && typeof safePatch.forceDeleteContextMenu !== "boolean") {
      throw new Error("右键强制删除开关必须为布尔值");
    }
    const applySettings = async () => {
      const previous = store.getSettings();
      const candidate = {
        ...previous,
        ...(safePatch as Partial<Omit<AppSettings, "ai">>)
      };
      const changesKeyboardShortcuts =
        Object.prototype.hasOwnProperty.call(safePatch, "globalShortcut") ||
        Object.prototype.hasOwnProperty.call(safePatch, "quickSearchShortcut");
      for (const key of ["globalShortcut", "quickSearchShortcut"] as const) {
        if (key in safePatch && typeof safePatch[key] !== "string") throw new Error("快捷键格式无效");
      }
      if (changesKeyboardShortcuts) {
        const shortcutFailures = applyGlobalShortcuts(candidate);
        if (shortcutFailures.length > 0) {
          applyGlobalShortcuts(previous);
          throw new Error(shortcutFailures.join("；"));
        }
      }
      const changesLogin = "launchAtLogin" in safePatch || "launchMinimized" in safePatch;
      let persisted = false;
      try {
        if (changesLogin) {
          if (typeof candidate.launchAtLogin !== "boolean" || typeof candidate.launchMinimized !== "boolean") {
            throw new Error("开机启动设置无效");
          }
          applyLoginSettings(candidate);
        }
        const settings = await store.updateSettings(
          safePatch as Partial<Omit<AppSettings, "ai">>
        );
        persisted = true;
        if (
          previous.mouseQuickSearchButton !== settings.mouseQuickSearchButton ||
          previous.mouseQuickSearchHoldMs !== settings.mouseQuickSearchHoldMs
        ) {
          await searchService?.configureMouseShortcut(
            settings.mouseQuickSearchButton,
            settings.mouseQuickSearchHoldMs
          );
        }
        if (
          previous.magnifierEnabled !== settings.magnifierEnabled ||
          previous.magnifierModifiers !== settings.magnifierModifiers ||
          previous.magnifierWidth !== settings.magnifierWidth ||
          previous.magnifierHeight !== settings.magnifierHeight
        ) {
          await searchService?.configureMagnifier(
            settings.magnifierEnabled,
            settings.magnifierModifiers,
            settings.magnifierWidth,
            settings.magnifierHeight
          );
        }
        emitSettingsChanged(settings);
        createTray();
        return settings;
      } catch (error) {
        const recovery: Array<Promise<unknown>> = [];
        if (persisted) {
          recovery.push(store.updateSettings(previous).then(emitSettingsChanged));
          recovery.push(Promise.resolve().then(() => searchService?.configureMouseShortcut(previous.mouseQuickSearchButton, previous.mouseQuickSearchHoldMs)));
          recovery.push(Promise.resolve().then(() => searchService?.configureMagnifier(previous.magnifierEnabled, previous.magnifierModifiers, previous.magnifierWidth, previous.magnifierHeight)));
        }
        if (changesKeyboardShortcuts) recovery.push(Promise.resolve().then(() => applyGlobalShortcuts(previous)));
        if (changesLogin) recovery.push(Promise.resolve().then(() => applyLoginSettings(previous)));
        for (const outcome of await Promise.allSettled(recovery)) {
          if (outcome.status === "rejected") logger.error("settings.restore_failed", { error: serializeError(outcome.reason) });
        }
        throw error;
      }
    };
    return "forceDeleteContextMenu" in safePatch
      ? explorerContextMenu.withEnabled(safePatch.forceDeleteContextMenu as boolean, applySettings)
      : applySettings();
  }));
  ipcMain.handle(
    "shortcut:check",
    (_event, shortcut: unknown, target: unknown) =>
      checkShortcutAvailability(
        assertString(shortcut, "快捷键", 128),
        assertShortcutTarget(target)
      )
  );
  ipcMain.handle("shortcut:test", (_event, target: unknown) => {
    const safeTarget = assertShortcutTarget(target);
    const shortcut = shortcutForTarget(store.getSettings(), safeTarget);
    const availability = checkShortcutAvailability(shortcut, safeTarget);
    if (!availability.active) {
      throw new Error(
        availability.available
          ? "请先保存快捷键，再测试对应功能"
          : availability.message
      );
    }
    if (safeTarget === "main") {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createQuickSearchWindow();
    }
    return true;
  });
  ipcMain.handle("shortcut:mouse-status", () =>
    searchService?.getMouseShortcutStatus() ?? {
      available: false,
      button: store.getSettings().mouseQuickSearchButton,
      holdMs: store.getSettings().mouseQuickSearchHoldMs,
      message: "鼠标监听尚未启动"
    }
  );
  ipcMain.handle("shortcut:mouse-test", () => {
    const status = searchService?.getMouseShortcutStatus();
    if (!status || !status.available) {
      throw new Error(status?.message ?? "鼠标监听尚未启动");
    }
    if (status.button === "disabled") {
      throw new Error("请先选择一个鼠标按键");
    }
    createQuickSearchWindow();
    return true;
  });
  ipcMain.handle("shortcut:magnifier-status", () =>
    searchService?.getMagnifierStatus() ?? {
      available: false,
      enabled: store.getSettings().magnifierEnabled,
      modifiers: store.getSettings().magnifierModifiers,
      width: store.getSettings().magnifierWidth,
      height: store.getSettings().magnifierHeight,
      message: "Windows 局部放大镜尚未启动"
    }
  );
  ipcMain.handle("shortcut:magnifier-capture", async (_event, active: unknown) => {
    return (await searchService?.setMagnifierCapture(active === true)) ?? false;
  });

  ipcMain.handle("app:navigate", (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("导航请求无效");
    const input = raw as {
      view?: string;
      path?: string;
      focus?: "ai-settings" | "search-input";
    };
    const allowed = new Set([
      "overview",
      "search",
      "ownership-map",
      "analyze",
      "migrate",
      "history",
      "settings"
    ]);
    if (!input.view || !allowed.has(input.view)) throw new Error("目标页面无效");
    showMainView(input.view as Parameters<typeof showMainView>[0], {
      path:
        typeof input.path === "string" && input.path.length <= 32_768
          ? input.path
          : undefined,
      focus: input.focus
    });
  });
  ipcMain.handle("app:finish-utility", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === forceDeleteWindow && forceDeleteLaunches.pending) {
      showForceDeleteRequests();
      return;
    }
    const finishingUninstall = window === uninstallRestoreWindow;
    window?.close();
    if (finishingUninstall) app.quit();
  });

  ipcMain.handle("ai:list-models", async (_event, raw: unknown) => {
    const { connection } = resolveAiConnection(raw);
    return discoverAiModels(connection);
  });

  ipcMain.handle("ai:test", async (_event, raw: unknown) => {
    const { connection } = resolveAiConnection(raw);
    if (!connection.model) throw new Error("请先从远程模型列表中选择一个模型");
    const started = performance.now();
    const reply = await completeAiText(
      connection,
      {
        system: "你是 API 连通性测试助手。回答必须简短，不要使用 Markdown。",
        user: "请只回复：CDriveShiftAI AI 服务连接成功",
        maxTokens: 96
      },
      45_000
    );
    pruneAiVerifications();
    const verificationId = randomUUID();
    aiVerifications.set(verificationId, {
      fingerprint: aiFingerprint(connection),
      expiresAt: Date.now() + 10 * 60_000
    });
    return {
      ok: true as const,
      model: connection.model,
      reply: reply.slice(0, 500),
      latencyMs: Math.max(0, performance.now() - started),
      verificationId
    };
  });

  ipcMain.handle("ai:save-draft", (_event, raw: unknown) => serializeSettingsUpdate(async () => {
    if (!raw || typeof raw !== "object") throw new Error("AI 草稿配置无效");
    const input = raw as AiDraftSaveInput;
    const rawBaseUrl =
      typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
    const validated = validateAiConnection({
      ...input,
      // 自定义厂商刚选中时允许先保存空地址，离开 URL 输入框时再做完整校验。
      baseUrl: rawBaseUrl || "http://127.0.0.1",
      apiKey:
        typeof input.apiKey === "string" && input.apiKey.trim()
          ? input.apiKey.trim()
          : undefined
    });
    const current = store.getSettings().ai;
    const providerChanged = current.provider !== validated.provider;
    const replaceApiKey = input.replaceApiKey === true;
    const connectionChanged =
      providerChanged ||
      current.protocol !== validated.protocol ||
      current.baseUrl.replace(/\/+$/, "") !==
        (rawBaseUrl ? validated.baseUrl : "") ||
      current.model !== (validated.model ?? "") ||
      replaceApiKey;
    const hasApiKey = replaceApiKey
      ? Boolean(validated.apiKey)
      : providerChanged
        ? false
        : current.hasApiKey;
    const updated = await store.updateSettings({
      ai: {
        enabled: connectionChanged ? false : current.enabled,
        provider: validated.provider,
        protocol: validated.protocol,
        baseUrl: rawBaseUrl ? validated.baseUrl : "",
        model: validated.model ?? "",
        hasApiKey,
        privacyMode:
          input.privacyMode === "allow-samples" ? "allow-samples" : "metadata-only",
        verifiedAt: connectionChanged ? undefined : current.verifiedAt
      },
      ...(replaceApiKey
        ? { apiKey: validated.apiKey ?? "" }
        : providerChanged
          ? { apiKey: "" }
          : {})
    });
    emitSettingsChanged(updated);
    createTray();
    return updated;
  }));

  ipcMain.handle("ai:save", (_event, raw: unknown) => serializeSettingsUpdate(async () => {
    if (!raw || typeof raw !== "object") throw new Error("AI 保存配置无效");
    const input = raw as AiSaveInput;
    if (!input.enabled) {
      const current = store.getSettings().ai;
      const updated = await store.updateSettings({
        ai: {
          ...current,
          enabled: false,
          privacyMode:
            input.privacyMode === "allow-samples" ? "allow-samples" : "metadata-only"
        }
      });
      emitSettingsChanged(updated);
      createTray();
      return updated;
    }

    const { connection } = resolveAiConnection(input);
    if (!connection.model) throw new Error("请先选择模型");
    pruneAiVerifications();
    const current = store.getSettings().ai;
    const isSavedConnection =
      Boolean(current.verifiedAt) &&
      current.provider === connection.provider &&
      current.protocol === connection.protocol &&
      current.baseUrl.replace(/\/+$/, "") === connection.baseUrl &&
      current.model === connection.model &&
      (input.useSavedKey || (!current.hasApiKey && !connection.apiKey));
    const verification =
      typeof input.verificationId === "string"
        ? aiVerifications.get(input.verificationId)
        : undefined;
    if (
      !isSavedConnection &&
      (!verification || verification.fingerprint !== aiFingerprint(connection))
    ) {
      throw new Error("当前 URL、Key 或模型尚未通过测试对话，请重新测试");
    }
    if (input.verificationId) aiVerifications.delete(input.verificationId);
    const changingKey = !input.useSavedKey;
    const updated = await store.updateSettings({
      ai: {
        enabled: true,
        provider: connection.provider,
        protocol: connection.protocol,
        baseUrl: connection.baseUrl,
        model: connection.model,
        hasApiKey: changingKey ? Boolean(connection.apiKey) : store.getSettings().ai.hasApiKey,
        privacyMode:
          input.privacyMode === "allow-samples" ? "allow-samples" : "metadata-only",
        verifiedAt: new Date().toISOString()
      },
      ...(changingKey ? { apiKey: connection.apiKey ?? "" } : {})
    });
    emitSettingsChanged(updated);
    createTray();
    return updated;
  }));

  ipcMain.handle("dialog:directory", async (event, title?: unknown, purpose?: unknown) => {
    const safePurpose = normalizeDirectoryDialogPurpose(purpose);
    const rememberedPath = store.getDirectoryDialogPath(safePurpose);
    const defaultPath = rememberedPath
      ? await stat(rememberedPath).then(
          (details) => (details.isDirectory() ? rememberedPath : undefined),
          () => undefined
        )
      : undefined;
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: typeof title === "string" ? title.slice(0, 120) : "选择目录",
      ...(defaultPath ? { defaultPath } : {}),
      properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
    };
    const result = parentWindow && !parentWindow.isDestroyed()
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options);
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (!selectedPath) return null;
    await store.saveDirectoryDialogPath(safePurpose, selectedPath);
    return selectedPath;
  });
  ipcMain.handle("settings:preview-ui-scale", (event, rawScale: unknown) => {
    if (typeof rawScale !== "number" || !Number.isFinite(rawScale)) {
      throw new Error("界面缩放比例无效");
    }
    const scale = normalizeStoredUiScale(rawScale);
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    event.sender.send("settings:text-scale-preview", scale);
    if (quickSearchWindow && !quickSearchWindow.isDestroyed() && quickSearchWindow !== sourceWindow) {
      applyUiScale(quickSearchWindow, scale);
    }
    if (forceDeleteWindow && !forceDeleteWindow.isDestroyed() && forceDeleteWindow !== sourceWindow) {
      applyUiScale(forceDeleteWindow, scale);
    }
    if (
      uninstallRestoreWindow &&
      !uninstallRestoreWindow.isDestroyed() &&
      uninstallRestoreWindow !== sourceWindow
    ) {
      applyUiScale(uninstallRestoreWindow, scale);
    }
    return scale;
  });

  ipcMain.handle("shell:reveal", async (_event, targetPath: unknown) => {
    const value = assertString(targetPath, "路径");
    await lstat(value);
    shell.showItemInFolder(value);
  });

  ipcMain.handle("shell:open", async (_event, targetPath: unknown) => {
    const value = assertString(targetPath, "路径");
    await lstat(value);
    const error = await shell.openPath(value);
    if (error) throw new Error(error);
  });

  ipcMain.handle("shell:open-with", async (_event, targetPath: unknown) => {
    const value = assertString(targetPath, "路径");
    const stats = await lstat(value);
    if (!stats.isFile()) throw new Error("“选择其他应用打开”仅适用于文件");
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: "选择用于打开文件的应用程序",
      properties: ["openFile", "dontAddToRecent"],
      filters: [
        { name: "应用程序", extensions: ["exe", "com", "bat", "cmd"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    const application = selection.filePaths[0];
    if (selection.canceled || !application) return;
    const child = spawn(application, [value], {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  });

  ipcMain.handle("shell:copy-text", (_event, text: unknown) => {
    const value = typeof text === "string" ? text : "";
    if (!value || value.length > 1_000_000) throw new Error("复制内容无效");
    clipboard.writeText(value);
  });

  ipcMain.handle(
    "shell:copy-to-directory",
    async (_event, sourcePath: unknown, destinationPath: unknown) => {
      const source = assertString(sourcePath, "源路径");
      const destinationDirectory = assertString(destinationPath, "目标目录");
      const [sourceStats, destinationStats] = await Promise.all([
        lstat(source),
        lstat(destinationDirectory)
      ]);
      if (!destinationStats.isDirectory()) throw new Error("复制目标不是目录");
      const destination = path.join(destinationDirectory, path.basename(source));
      try {
        await lstat(destination);
        throw new Error(`目标已存在：${destination}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await runFileMutation(destination, () => cp(source, destination, {
        recursive: sourceStats.isDirectory(),
        errorOnExist: true,
        force: false,
        preserveTimestamps: true
      }));
      return destination;
    }
  );

  ipcMain.handle(
    "shell:rename",
    async (_event, targetPath: unknown, requestedName: unknown) => {
      const source = assertString(targetPath, "路径");
      await lstat(source);
      const protection = protectedReason(source);
      if (protection) throw new Error(`受保护路径不能重命名：${protection}`);
      await assertFileMutationAllowed(source);
      const newName = assertString(requestedName, "新名称", 255).trim();
      if (
        /[<>:"/\\|?*\u0000-\u001f]/.test(newName) ||
        /[. ]$/.test(newName) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(newName)
      ) {
        throw new Error("名称包含 Windows 不允许的字符或保留名称");
      }
      const destination = path.join(path.dirname(source), newName);
      await runFileMutation(source, async () => {
        await assertFileMutationAllowed(destination);
        await assertRenameDestinationAvailable(source, destination);
        await rename(source, destination);
      });
      return destination;
    }
  );

  ipcMain.handle("shell:path-properties", async (_event, targetPath: unknown) => {
    const value = assertString(targetPath, "路径");
    const linkStats = await lstat(value);
    const isSymbolicLink = linkStats.isSymbolicLink();
    const targetStats = isSymbolicLink
      ? await stat(value).catch(() => undefined)
      : linkStats;
    const isDirectory = Boolean(targetStats?.isDirectory());
    const sizeResult =
      isDirectory && !isSymbolicLink
        ? (await searchService!.directorySizes([value]))[0]
        : undefined;
    const [readable, writable, linkTarget] = await Promise.all([
      access(value, 4).then(() => true, () => false),
      access(value, 2).then(() => true, () => false),
      isSymbolicLink
        ? readlink(value).then((target) => target, () => undefined)
        : Promise.resolve(undefined)
    ]);
    const parsed = path.parse(value);
    const allocatedBytes =
      typeof linkStats.blocks === "number" && linkStats.blocks > 0
        ? linkStats.blocks * 512
        : linkStats.size;
    return {
      path: value,
      name: path.basename(value) || value,
      parentPath: parsed.dir || parsed.root,
      extension: isDirectory ? "" : parsed.ext.replace(/^\./, "").toLocaleLowerCase(),
      isDirectory,
      isSymbolicLink,
      linkTarget,
      size: sizeResult?.bytes ?? linkStats.size,
      allocatedBytes: isDirectory ? undefined : allocatedBytes,
      files: sizeResult?.files,
      directories: sizeResult ? Math.max(0, sizeResult.directories - 1) : undefined,
      scanComplete: sizeResult?.complete ?? true,
      createdAt: Number.isFinite(linkStats.birthtimeMs)
        ? linkStats.birthtime.toISOString()
        : undefined,
      modifiedAt: Number.isFinite(linkStats.mtimeMs)
        ? linkStats.mtime.toISOString()
        : undefined,
      accessedAt: Number.isFinite(linkStats.atimeMs)
        ? linkStats.atime.toISOString()
        : undefined,
      readable,
      writable
    };
  });

  ipcMain.handle("shell:trash", async (_event, targetPath: unknown) => {
    const value = assertString(targetPath, "路径");
    await lstat(value);
    const protection = protectedReason(value);
    if (protection) throw new Error(`受保护路径不能删除：${protection}`);
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: "warning",
      title: "确认删除到回收站",
      message: `确定删除“${path.basename(value)}”吗？`,
      detail: isHighRiskApplicationPath(value)
        ? `这是应用安装目录，删除可能导致程序无法运行。\n\n${value}`
        : `项目将被移入 Windows 回收站，可以恢复。\n\n${value}`,
      buttons: ["取消", "删除到回收站"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (confirmation.response !== 1) return false;
    await runFileMutation(value, () => shell.trashItem(value));
    return true;
  });

  ipcMain.handle("shell:force-delete-preview", (_event, targetPath: unknown) =>
    forceDeleteService.preview(assertString(targetPath, "路径"))
  );

  ipcMain.handle("shell:delete-helper", (_event, target: unknown) =>
    openDeleteHelper(target, shell)
  );

  ipcMain.handle("shell:force-delete-menu-status", async () => {
    const status = await explorerContextMenu.getStatus();
    return {
      enabled: status.registered,
      available: status.supported,
      reason: status.needsRepair
        ? "菜单指向旧版本或注册不完整，请关闭后重新开启 / Menu needs repair; switch it off and on again"
        : !status.supported ? "仅支持 Windows 桌面版 / Windows desktop only" : undefined
    };
  });
  ipcMain.handle("shell:force-delete-requests", (event) => {
    if (!forceDeleteWindow || forceDeleteWindow.isDestroyed() || event.sender.id !== forceDeleteWindow.webContents.id) return [];
    return forceDeleteLaunches.takeAll();
  });

  ipcMain.handle("shell:force-delete-execute", (_event, verificationId: unknown) => {
    if (isQuitting) throw new Error("程序正在退出，无法开始新的删除操作");
    if (fileMutationCount > 0 || forceDeleteService.isBusy()) throw new Error("其他文件操作正在执行，请完成后重试");
    return forceDeleteService.execute(assertString(verificationId, "强制删除确认 ID", 128));
  });

  ipcMain.handle(
    "shell:search-context-menu",
    async (event, targetPath: unknown, isDirectory: unknown) => {
      const value = assertString(targetPath, "路径");
      const stats = await lstat(value);
      const directory = typeof isDirectory === "boolean" ? isDirectory : stats.isDirectory();
      const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      if (!ownerWindow) throw new Error("窗口尚未就绪");
      return showSearchContextMenu(ownerWindow, value, directory);
    }
  );

  ipcMain.handle("shell:external", async (_event, url: unknown) => {
    const value = assertString(url, "网址", 2_048);
    const parsed = new URL(value);
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("只允许打开 HTTP(S) 链接");
    await shell.openExternal(parsed.toString());
  });

  ipcMain.handle(
    "search:query",
    async (_event, query: unknown, filters: unknown, pageOptions?: unknown) => {
      const value = assertString(query, "搜索词", 512);
      const raw = (filters ?? {}) as Partial<SearchFilters>;
      const allowedCategories = new Set<SearchCategory>([
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
      const allowedSortFields = new Set<SearchSortField>([
        "relevance",
        "name",
        "path",
        "size",
        "modified",
        "type"
      ]);
      const allowedSortDirections = new Set<SearchSortDirection>(["asc", "desc"]);
      const regex = raw.regex === true;
      const fuzzy = !regex && raw.fuzzy === true;
      const wholeWord = !regex && !fuzzy && raw.wholeWord === true;
      const safeFilters: SearchFilters = {
        kind: ["all", "folder", "file"].includes(raw.kind ?? "") ? raw.kind! : "all",
        scope: typeof raw.scope === "string" && raw.scope ? raw.scope : "*",
        scopes: Array.isArray(raw.scopes)
          ? raw.scopes
              .filter((item): item is string => typeof item === "string" && item.length <= 32_768)
              .slice(0, 32)
          : undefined,
        categories: Array.isArray(raw.categories)
          ? raw.categories
              .filter((item): item is SearchCategory => allowedCategories.has(item))
              .slice(0, allowedCategories.size)
          : undefined,
        extensions: Array.isArray(raw.extensions)
          ? raw.extensions
              .filter(
                (item): item is string =>
                  typeof item === "string" && /^[a-z0-9_+-]{1,24}$/i.test(item)
              )
              .slice(0, 64)
          : undefined,
        minSize: typeof raw.minSize === "number" ? Math.max(0, raw.minSize) : undefined,
        maxSize: typeof raw.maxSize === "number" ? Math.max(0, raw.maxSize) : undefined,
        modifiedAfter: typeof raw.modifiedAfter === "string" ? raw.modifiedAfter : undefined,
        modifiedBefore: typeof raw.modifiedBefore === "string" ? raw.modifiedBefore : undefined,
        caseSensitive: raw.caseSensitive === true,
        wholeWord,
        fuzzy,
        matchPath: raw.matchPath === true,
        regex,
        sortBy:
          raw.sortBy && allowedSortFields.has(raw.sortBy) ? raw.sortBy : "relevance",
        sortDirection:
          raw.sortDirection && allowedSortDirections.has(raw.sortDirection)
            ? raw.sortDirection
            : "desc"
      };
      if (pageOptions && typeof pageOptions === "object") {
        const rawPage = pageOptions as { cursor?: unknown; limit?: unknown };
        return searchService!.searchPage(value, safeFilters, {
          cursor:
            typeof rawPage.cursor === "string" && rawPage.cursor.length <= 256
              ? rawPage.cursor
              : undefined,
          limit:
            typeof rawPage.limit === "number"
              ? Math.min(10_000, Math.max(1, Math.trunc(rawPage.limit)))
              : undefined
        });
      }
      return searchService!.search(value, safeFilters);
    }
  );
  ipcMain.handle("search:status", () => searchService!.getStatus());
  ipcMain.handle("search:rebuild", () => searchService!.rebuild());
  ipcMain.handle("search:workspace-get", () => store.getSearchWorkspace());
  ipcMain.handle("search:workspace-save", (_event, value: unknown) =>
    store.saveSearchWorkspace(value)
  );
  ipcMain.handle("search:bookmarks-list", () => store.listSearchBookmarks());
  ipcMain.handle("search:bookmarks-save", (_event, value: unknown) =>
    store.saveSearchBookmark(value)
  );
  ipcMain.handle("search:bookmarks-delete", (_event, id: unknown) =>
    store.deleteSearchBookmark(assertString(id, "搜索书签 ID", 128))
  );
  ipcMain.handle("search:bookmark-folders-list", () =>
    store.listSearchBookmarkFolders()
  );
  ipcMain.handle("search:bookmark-folders-save", (_event, value: unknown) =>
    store.saveSearchBookmarkFolder(value)
  );
  ipcMain.handle("search:bookmark-folders-delete", (_event, id: unknown) =>
    store.deleteSearchBookmarkFolder(
      assertString(id, "搜索书签文件夹 ID", 128)
    )
  );
  ipcMain.handle("ui-layout:get", () => store.getUiLayout());
  ipcMain.handle("ui-layout:update", (_event, value: unknown) =>
    store.updateUiLayout(value)
  );
  ipcMain.handle("search:directory-sizes", (_event, paths: unknown) => {
    if (!Array.isArray(paths)) throw new Error("目录列表无效");
    const safePaths = paths
      .filter((item): item is string => typeof item === "string" && item.length <= 32_768)
      .slice(0, 180);
    return searchService!.directorySizes(safePaths);
  });
  ipcMain.handle(
    "search:content-index",
    (_event, scope: unknown) =>
      searchService!.indexContent(assertString(scope, "内容索引目录"))
  );
  ipcMain.handle(
    "search:content-status",
    (_event, scope: unknown) =>
      searchService!.contentIndexStatus(assertString(scope, "内容索引目录"))
  );
  ipcMain.handle(
    "search:content-query",
    (_event, query: unknown, scope: unknown, options: unknown) => {
      const raw =
        options && typeof options === "object"
          ? (options as { regex?: unknown; caseSensitive?: unknown })
          : {};
      return (
      searchService!.searchContent(
        assertString(query, "内容搜索词", 2_048),
        assertString(scope, "内容搜索目录"),
        {
          regex: raw.regex === true,
          caseSensitive: raw.caseSensitive === true
        }
      )
      );
    }
  );

  ipcMain.handle(
    "search:content-query-page",
    (_event, query: unknown, scope: unknown, options: unknown, pageOptions: unknown) => {
      const raw =
        options && typeof options === "object"
          ? (options as {
              regex?: unknown;
              caseSensitive?: unknown;
              sortBy?: unknown;
              sortDirection?: unknown;
              minSize?: unknown;
              maxSize?: unknown;
              modifiedAfter?: unknown;
              modifiedBefore?: unknown;
            })
          : {};
      const rawPage =
        pageOptions && typeof pageOptions === "object"
          ? (pageOptions as { cursor?: unknown; limit?: unknown })
          : {};
      return searchService!.searchContentPage(
        assertString(query, "内容搜索词", 2_048),
        assertString(scope, "内容搜索目录"),
        {
          regex: raw.regex === true,
          caseSensitive: raw.caseSensitive === true,
          sortBy: ["relevance", "name", "path", "size", "modified", "type"].includes(
            String(raw.sortBy)
          )
            ? (raw.sortBy as SearchSortField)
            : "relevance",
          sortDirection: ["asc", "desc"].includes(String(raw.sortDirection))
            ? (raw.sortDirection as SearchSortDirection)
            : "desc",
          minSize: typeof raw.minSize === "number" ? Math.max(0, raw.minSize) : undefined,
          maxSize: typeof raw.maxSize === "number" ? Math.max(0, raw.maxSize) : undefined,
          modifiedAfter:
            typeof raw.modifiedAfter === "string" ? raw.modifiedAfter : undefined,
          modifiedBefore:
            typeof raw.modifiedBefore === "string" ? raw.modifiedBefore : undefined,
          cursor:
            typeof rawPage.cursor === "string" && rawPage.cursor.length <= 256
              ? rawPage.cursor
              : undefined,
          limit:
            typeof rawPage.limit === "number"
              ? Math.min(2_000, Math.max(1, Math.trunc(rawPage.limit)))
              : undefined
        }
      );
    }
  );

  ipcMain.handle("analysis:summarize", (_event, targetPath: unknown) =>
    summarizeDirectory(assertString(targetPath, "目录"))
  );
  ipcMain.handle(
    "analysis:analyze-legacy",
    async (_event, targetPath: unknown, useAi?: unknown) => {
      const local = await analyzeLocally(assertString(targetPath, "目录"));
      if (!useAi) return local;
      return enhanceAnalysisWithAi(local, {
        settings: store.getSettings(),
        apiKey: store.getApiKey()
      });
    }
  );
  ipcMain.handle("analysis:ownership-map-legacy", (_event, drive: unknown) =>
    scanOwnershipMap(assertString(drive, "盘符", 16))
  );

  ipcMain.handle("analysis:get-saved", (_event, targetPath: unknown) =>
    store.getAnalysis(assertString(targetPath, "目录"))
  );
  ipcMain.handle("analysis:delete-saved", (_event, targetPath: unknown) =>
    store.deleteAnalysis(assertString(targetPath, "目录"))
  );
  ipcMain.handle("analysis:get-last", () => store.getLastAnalysis());
  ipcMain.handle(
    "analysis:analyze",
    async (_event, targetPath: unknown, useAi?: unknown) => {
      const safePath = assertString(targetPath, "目录");
      const executablePaths = await searchService?.listExecutablePaths().catch(() => []);
      const local = await analyzeLocally(safePath, undefined, executablePaths ?? []);
      let result = local;
      if (useAi) {
        try {
          result = await enhanceAnalysisWithAi(local, {
            settings: store.getSettings(),
            apiKey: store.getApiKey()
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result = {
            ...local,
            warnings: [...new Set([...local.warnings, `AI 二次分析未完成：${message}`])],
            aiError: message
          };
        }
      }
      await store.saveAnalysis(result);
      return result;
    }
  );
  ipcMain.handle("analysis:ownership-map", async (_event, drive: unknown) => {
    const safeDrive = assertString(drive, "盘符", 16);
    const executablePaths = await searchService?.listExecutablePaths().catch(() => []);
    const result = await scanOwnershipMap(safeDrive, executablePaths ?? []);
    await store.saveOwnershipMap(result);
    return result;
  });
  ipcMain.handle("analysis:ownership-map-saved", (_event, drive: unknown) =>
    store.getOwnershipMap(assertString(drive, "盘符", 16))
  );

  ipcMain.handle(
    "migration:preflight",
    (_event, source: unknown, destination: unknown) =>
      migrationService.preflight(
        assertString(source, "源目录"),
        assertString(destination, "目标目录")
      )
  );
  ipcMain.handle(
    "migration:execute",
    (_event, source: unknown, destination: unknown) => {
      assertMigrationCanStart();
      return migrationService.execute(
        assertString(source, "源目录"),
        assertString(destination, "目标目录")
      );
    }
  );
  ipcMain.handle("migration:list", () => store.listMigrations());
  ipcMain.handle("migration:rollback", (_event, id: unknown) => {
    assertMigrationCanStart();
    return migrationService.rollback(assertString(id, "迁移记录 ID", 128));
  });
  ipcMain.handle("migration:reapply", (_event, id: unknown) => {
    assertMigrationCanStart();
    return migrationService.reapply(assertString(id, "迁移记录 ID", 128));
  });
  ipcMain.handle("migration:delete", async (_event, rawIds: unknown) => {
    if (migrationService.isBusy()) throw new Error("迁移或恢复正在执行，不能删除记录");
    if (!Array.isArray(rawIds)) throw new Error("迁移记录 ID 列表无效");
    const ids = [
      ...new Set(
        rawIds
          .slice(0, 2_000)
          .map((id) => assertString(id, "迁移记录 ID", 128))
      )
    ];
    for (const id of ids) {
      const record = store.getMigration(id);
      const reason = record && migrationRecordDeletionReason(record);
      if (reason) throw new Error(reason);
    }
    return store.deleteMigrations(ids);
  });
}

const uninstallRestoreMode = process.argv.includes("--uninstall-restore");
const singleInstance = app.requestSingleInstanceLock(createForceDeleteLaunchData(process.argv));
if (!singleInstance) {
  if (uninstallRestoreMode) {
    dialog.showErrorBox("无法开始卸载恢复", "CDriveShiftAI 仍在运行。请先退出正在运行的程序，再重试卸载。");
    app.exit(1);
  } else app.quit();
} else if (uninstallRestoreMode) {
  app.whenReady().then(async () => {
    logger.info("application.ready", {
      version: app.getVersion(),
      packaged: app.isPackaged,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      dataRoot: applicationDataRoot,
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem()
    });
    await store.init();
    applyNativeEffect(store.getSettings().effectMode);
    migrationService = new MigrationService(store, () => undefined, {
      protectedPaths: [path.dirname(process.execPath), applicationDataRoot]
    });
    await migrationService.recoverIncomplete();
    registerIpc();
    createUninstallRestoreWindow();
  }).catch(handleStartupFailure);
} else {
  const forceDeleteStartup = acceptForceDeleteLaunch(process.argv);
  app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
    if (acceptForceDeleteLaunch(argv, additionalData)) return;
    // The renderer is intentionally destroyed while resident in the tray.
    // Launching the executable again must therefore recreate the main window,
    // not silently return just because no BrowserWindow currently exists.
    if (searchService) showMainView("overview");
  });

  app.whenReady().then(async () => {
    logger.info("application.ready", {
      version: app.getVersion(),
      packaged: app.isPackaged,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      dataRoot: applicationDataRoot,
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem()
    });
    await store.init();
    applyNativeEffect(store.getSettings().effectMode);
    await completePendingUpdate();
    const currentSettings = store.getSettings();
    searchService = new SearchService(
      (status) => {
        for (const window of [mainWindow, quickSearchWindow]) {
          if (window && !window.isDestroyed()) {
            window.webContents.send("indexer:status", status);
          }
        }
      },
      (status) => {
        for (const window of [mainWindow, quickSearchWindow]) {
          if (window && !window.isDestroyed()) {
            window.webContents.send("content-indexer:status", status);
          }
        }
      },
      (event) => {
        for (const window of [mainWindow, quickSearchWindow]) {
          if (
            window &&
            !window.isDestroyed() &&
            window.isVisible() &&
            !window.isMinimized()
          ) {
            window.webContents.send("search:index-changed", event);
          }
        }
      },
      () => createQuickSearchWindow(),
      {
        button: currentSettings.mouseQuickSearchButton,
        holdMs: currentSettings.mouseQuickSearchHoldMs
      },
      {
        enabled: currentSettings.magnifierEnabled,
        modifiers: currentSettings.magnifierModifiers,
        width: currentSettings.magnifierWidth,
        height: currentSettings.magnifierHeight
      }
    );
    migrationService = new MigrationService(store, (record, message) => {
      for (const window of [mainWindow, uninstallRestoreWindow]) {
        if (window && !window.isDestroyed()) window.webContents.send("migration:progress", { record, message });
      }
    }, { protectedPaths: [path.dirname(process.execPath), applicationDataRoot] });
    await migrationService.recoverIncomplete();
    updateService = new UpdateService(emitUpdateState, assertUpdateCanInstall);
    registerIpc();
    fileRequestWindowReady = true;
    const startupMinimized =
      process.argv.includes("--startup-minimized") &&
      currentSettings.launchAtLogin &&
      currentSettings.launchMinimized;
    if (!startupMinimized && !forceDeleteStartup && !forceDeleteLaunches.pending) mainWindow = createWindow();
    showForceDeleteRequests();
    createTray();
    syncSearchBackgroundMode();
    triggerVisibleUpdateCheck("application-startup", 2_500);
    const shortcutFailures = applyGlobalShortcuts(store.getSettings());
    if (shortcutFailures.length > 0) {
      logger.warn("shortcut.registration_incomplete", {
        startupMinimized,
        failures: shortcutFailures
      });
    }
    // Let Chromium finish the first interactive frame before parsing a
    // multi-million-entry persistent index. Search remains fully accurate once
    // the same cache is loaded; this only removes startup contention.
    setTimeout(() => {
      void searchService?.start().catch(() => {
        // SearchService publishes its own unavailable/restart status.
      });
    }, 850);
    const smokeQuitDelay = Number.parseInt(
      process.env.CDRIVESHIFTAI_SMOKE_QUIT_AFTER_READY_MS ?? "",
      10
    );
    if (app.isPackaged && Number.isFinite(smokeQuitDelay) && smokeQuitDelay >= 1_000) {
      const smokeQuitTimer = setTimeout(() => app.quit(), smokeQuitDelay);
      smokeQuitTimer.unref();
    }
    const smokeTrayDelay = Number.parseInt(
      process.env.CDRIVESHIFTAI_SMOKE_CLOSE_TO_TRAY_AFTER_READY_MS ?? "",
      10
    );
    if (app.isPackaged && Number.isFinite(smokeTrayDelay) && smokeTrayDelay >= 1_000) {
      const smokeTrayTimer = setTimeout(() => mainWindow?.close(), smokeTrayDelay);
      smokeTrayTimer.unref();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) showMainView("overview");
    });
  }).catch(handleStartupFailure);
}

function handleStartupFailure(error: unknown): void {
  logger.error("application.startup_failed", { error: serializeError(error) });
  dialog.showErrorBox("CDriveShiftAI 启动失败", error instanceof Error ? error.message : String(error));
  app.exit(1);
}

app.on("window-all-closed", () => {
  const keepInTray =
    !isQuitting &&
    store.getSettings().minimizeToTray &&
    tray != null &&
    !tray.isDestroyed();
  if (process.platform !== "darwin" && !keepInTray) app.quit();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (visibleUpdateCheckTimer) {
    clearTimeout(visibleUpdateCheckTimer);
    visibleUpdateCheckTimer = undefined;
  }
  if (shutdownComplete) return;
  event.preventDefault();
  logger.info("application.shutdown_started", {
    hasIndexer: searchService != null,
    pendingWindows: BrowserWindow.getAllWindows().length
  });
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = undefined;
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      try {
        await migrationService?.whenIdle();
        await forceDeleteService.whenIdle();
        await Promise.allSettled([...pendingFileMutations]);
        await settingsUpdateQueue;
        await store.whenIdle();
      } finally {
        try {
          await searchService?.stop();
        } finally {
          shutdownComplete = true;
          logger.info("application.shutdown_completed");
          app.quit();
        }
      }
    })();
  }
});

app.on("child-process-gone", (_event, details) => {
  logger.warn("application.child_process_gone", {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name,
    serviceName: details.serviceName
  });
});
