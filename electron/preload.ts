import { contextBridge, ipcRenderer } from "electron";
import type {
  ContentIndexerStatus,
  IndexerStatus,
  MigrationRecord,
  SearchIndexChangedEvent
} from "./types";
import type { AppUpdateInfo } from "./update";

contextBridge.exposeInMainWorld("cDriveShiftAI", {
  getOverview: () => ipcRenderer.invoke("system:overview"),
  checkForUpdates: (force?: boolean) =>
    ipcRenderer.invoke("app:update-check", force === true),
  getUpdateState: () => ipcRenderer.invoke("app:update-state"),
  startUpdate: () => ipcRenderer.invoke("app:update-start"),
  cancelUpdate: () => ipcRenderer.invoke("app:update-cancel"),
  openLogDirectory: () => ipcRenderer.invoke("diagnostics:open-logs"),
  exportDiagnosticReport: () => ipcRenderer.invoke("diagnostics:export"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("settings:update", patch),
  checkGlobalShortcut: (shortcut: string, target: string) =>
    ipcRenderer.invoke("shortcut:check", shortcut, target),
  testGlobalShortcut: (target: string) =>
    ipcRenderer.invoke("shortcut:test", target),
  getMouseShortcutStatus: () => ipcRenderer.invoke("shortcut:mouse-status"),
  testMouseShortcut: () => ipcRenderer.invoke("shortcut:mouse-test"),
  listAiModels: (input: unknown) => ipcRenderer.invoke("ai:list-models", input),
  testAiConnection: (input: unknown) => ipcRenderer.invoke("ai:test", input),
  saveAiDraft: (input: unknown) => ipcRenderer.invoke("ai:save-draft", input),
  saveAiSettings: (input: unknown) => ipcRenderer.invoke("ai:save", input),
  chooseDirectory: (title?: string) => ipcRenderer.invoke("dialog:directory", title),
  revealPath: (targetPath: string) => ipcRenderer.invoke("shell:reveal", targetPath),
  openPath: (targetPath: string) => ipcRenderer.invoke("shell:open", targetPath),
  openWith: (targetPath: string) => ipcRenderer.invoke("shell:open-with", targetPath),
  copyText: (text: string) => ipcRenderer.invoke("shell:copy-text", text),
  copyPathToDirectory: (targetPath: string, destination: string) =>
    ipcRenderer.invoke("shell:copy-to-directory", targetPath, destination),
  renamePath: (targetPath: string, newName: string) =>
    ipcRenderer.invoke("shell:rename", targetPath, newName),
  getPathProperties: (targetPath: string) =>
    ipcRenderer.invoke("shell:path-properties", targetPath),
  trashPath: (targetPath: string) => ipcRenderer.invoke("shell:trash", targetPath),
  previewForceDelete: (targetPath: string) =>
    ipcRenderer.invoke("shell:force-delete-preview", targetPath),
  executeForceDelete: (verificationId: string) =>
    ipcRenderer.invoke("shell:force-delete-execute", verificationId),
  directorySizes: (paths: string[]) => ipcRenderer.invoke("search:directory-sizes", paths),
  getSearchWorkspace: () => ipcRenderer.invoke("search:workspace-get"),
  saveSearchWorkspace: (state: unknown) => ipcRenderer.invoke("search:workspace-save", state),
  listSearchBookmarks: () => ipcRenderer.invoke("search:bookmarks-list"),
  saveSearchBookmark: (bookmark: unknown) =>
    ipcRenderer.invoke("search:bookmarks-save", bookmark),
  deleteSearchBookmark: (id: string) =>
    ipcRenderer.invoke("search:bookmarks-delete", id),
  listSearchBookmarkFolders: () =>
    ipcRenderer.invoke("search:bookmark-folders-list"),
  saveSearchBookmarkFolder: (folder: unknown) =>
    ipcRenderer.invoke("search:bookmark-folders-save", folder),
  deleteSearchBookmarkFolder: (id: string) =>
    ipcRenderer.invoke("search:bookmark-folders-delete", id),
  getUiLayout: () => ipcRenderer.invoke("ui-layout:get"),
  updateUiLayout: (patch: unknown) => ipcRenderer.invoke("ui-layout:update", patch),
  navigateApp: (event: unknown) => ipcRenderer.invoke("app:navigate", event),
  finishUtilityWindow: () => ipcRenderer.invoke("app:finish-utility"),
  showSearchContextMenu: (targetPath: string, isDirectory: boolean) =>
    ipcRenderer.invoke("shell:search-context-menu", targetPath, isDirectory),
  openExternal: (url: string) => ipcRenderer.invoke("shell:external", url),
  search: (query: string, filters: unknown) => ipcRenderer.invoke("search:query", query, filters),
  searchPage: (query: string, filters: unknown, pageOptions?: unknown) =>
    ipcRenderer.invoke("search:query", query, filters, pageOptions ?? {}),
  searchContent: (query: string, scope: string, options?: unknown) =>
    ipcRenderer.invoke("search:content-query", query, scope, options),
  searchContentPage: (
    query: string,
    scope: string,
    options?: {
      regex?: boolean;
      caseSensitive?: boolean;
      sortBy?: string;
      sortDirection?: string;
      minSize?: number;
      maxSize?: number;
      modifiedAfter?: string;
      modifiedBefore?: string;
      cursor?: string;
      limit?: number;
    }
  ) =>
    ipcRenderer.invoke(
      "search:content-query-page",
      query,
      scope,
      {
        regex: options?.regex,
        caseSensitive: options?.caseSensitive,
        sortBy: options?.sortBy,
        sortDirection: options?.sortDirection,
        minSize: options?.minSize,
        maxSize: options?.maxSize,
        modifiedAfter: options?.modifiedAfter,
        modifiedBefore: options?.modifiedBefore
      },
      { cursor: options?.cursor, limit: options?.limit }
    ),
  indexContent: (scope: string) => ipcRenderer.invoke("search:content-index", scope),
  contentIndexStatus: (scope: string) => ipcRenderer.invoke("search:content-status", scope),
  indexerStatus: () => ipcRenderer.invoke("search:status"),
  rebuildIndex: () => ipcRenderer.invoke("search:rebuild"),
  summarizeDirectory: (targetPath: string) =>
    ipcRenderer.invoke("analysis:summarize", targetPath),
  getLastAnalysis: () => ipcRenderer.invoke("analysis:get-last"),
  getSavedAnalysis: (targetPath: string) =>
    ipcRenderer.invoke("analysis:get-saved", targetPath),
  deleteSavedAnalysis: (targetPath: string) =>
    ipcRenderer.invoke("analysis:delete-saved", targetPath),
  analyzeDirectory: (targetPath: string, useAi?: boolean) =>
    ipcRenderer.invoke("analysis:analyze", targetPath, useAi),
  getSavedOwnershipMap: (drive: string) =>
    ipcRenderer.invoke("analysis:ownership-map-saved", drive),
  scanOwnershipMap: (drive: string) => ipcRenderer.invoke("analysis:ownership-map", drive),
  preflightMigration: (source: string, destinationBase: string) =>
    ipcRenderer.invoke("migration:preflight", source, destinationBase),
  executeMigration: (source: string, destinationBase: string) =>
    ipcRenderer.invoke("migration:execute", source, destinationBase),
  listMigrations: () => ipcRenderer.invoke("migration:list"),
  rollbackMigration: (id: string) => ipcRenderer.invoke("migration:rollback", id),
  reapplyMigration: (id: string) => ipcRenderer.invoke("migration:reapply", id),
  deleteMigrations: (ids: string[]) => ipcRenderer.invoke("migration:delete", ids),
  onIndexerStatus: (listener: (status: IndexerStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: IndexerStatus) => listener(status);
    ipcRenderer.on("indexer:status", handler);
    return () => ipcRenderer.removeListener("indexer:status", handler);
  },
  onSearchIndexChanged: (listener: (event: SearchIndexChangedEvent) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: SearchIndexChangedEvent
    ) => listener(payload);
    ipcRenderer.on("search:index-changed", handler);
    return () => ipcRenderer.removeListener("search:index-changed", handler);
  },
  onContentIndexerStatus: (listener: (status: ContentIndexerStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: ContentIndexerStatus) =>
      listener(status);
    ipcRenderer.on("content-indexer:status", handler);
    return () => ipcRenderer.removeListener("content-indexer:status", handler);
  },
  onMigrationProgress: (
    listener: (event: { record: MigrationRecord; message: string }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { record: MigrationRecord; message: string }
    ) => listener(payload);
    ipcRenderer.on("migration:progress", handler);
    return () => ipcRenderer.removeListener("migration:progress", handler);
  },
  onAppNavigation: (
    listener: (event: {
      view: string;
      path?: string;
      focus?: "ai-settings" | "search-input";
    }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: {
        view: string;
        path?: string;
        focus?: "ai-settings" | "search-input";
      }
    ) => listener(payload);
    ipcRenderer.on("app:navigate", handler);
    return () => ipcRenderer.removeListener("app:navigate", handler);
  },
  onSettingsChanged: (listener: (settings: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: unknown) =>
      listener(settings);
    ipcRenderer.on("settings:changed", handler);
    return () => ipcRenderer.removeListener("settings:changed", handler);
  },
  onUpdateStatus: (listener: (status: AppUpdateInfo) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: AppUpdateInfo) =>
      listener(status);
    ipcRenderer.on("app:update-status", handler);
    return () => ipcRenderer.removeListener("app:update-status", handler);
  }
});
