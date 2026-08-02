import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CloudOff, Database, Palette, ShieldCheck } from "lucide-react";
import { api } from "./lib/api";
import {
  effectBackgrounds,
  effectDefinitions,
  effectLabels
} from "./lib/effects";
import type {
  AppSettings,
  AppUpdateInfo,
  EffectMode,
  IndexerStatus,
  MigrationRecord,
  SystemOverview,
  ViewId
} from "./types";
import { BackgroundFX } from "./components/BackgroundFX";
import { Sidebar } from "./components/Sidebar";
import { Toasts, type ToastItem } from "./components/ui";
import { OverviewView } from "./views/OverviewView";

const SearchView = lazy(() =>
  import("./views/SearchView").then((module) => ({ default: module.SearchView }))
);
const OwnershipMapView = lazy(() =>
  import("./views/OwnershipMapView").then((module) => ({ default: module.OwnershipMapView }))
);
const AnalyzeView = lazy(() =>
  import("./views/AnalyzeView").then((module) => ({ default: module.AnalyzeView }))
);
const MigrateView = lazy(() =>
  import("./views/MigrateView").then((module) => ({ default: module.MigrateView }))
);
const HistoryView = lazy(() =>
  import("./views/HistoryView").then((module) => ({ default: module.HistoryView }))
);
const SettingsView = lazy(() =>
  import("./views/SettingsView").then((module) => ({ default: module.SettingsView }))
);

const fallbackStatus: IndexerStatus = {
  mode: "loading",
  state: "idle",
  entries: 0,
  progress: 0,
  root: "本机所有磁盘",
  message: "正在连接索引核心"
};

function initialEffectMode(): EffectMode {
  const value = document.documentElement.dataset.effect;
  return value === "matrix" || value === "calm" ? value : "aurora";
}

function initialView(): ViewId {
  const requested = new URLSearchParams(window.location.search).get("view") as ViewId | null;
  return requested &&
    ["overview", "search", "ownership-map", "analyze", "migrate", "history", "settings"].includes(
      requested
    )
    ? requested
    : "overview";
}

export default function App() {
  const [view, setView] = useState<ViewId>(initialView);
  const [overview, setOverview] = useState<SystemOverview>();
  const [settings, setSettings] = useState<AppSettings>();
  const [indexer, setIndexer] = useState<IndexerStatus>(fallbackStatus);
  const [history, setHistory] = useState<MigrationRecord[]>([]);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [analysisRequest, setAnalysisRequest] = useState({
    path: "",
    token: 0,
    pending: false
  });
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [startupEffect] = useState<EffectMode>(initialEffectMode);
  const effectRequest = useRef(0);

  const notify = useCallback((type: ToastItem["type"], message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1_000);
    setToasts((items) => [...items.slice(-3), { id, type, message }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 4_500);
  }, []);

  const refreshHistory = useCallback(async () => {
    const records = await api.listMigrations();
    setHistory(records);
  }, []);

  useEffect(() => {
    void Promise.allSettled([
      api.getOverview(),
      api.getSettings(),
      api.listMigrations(),
      api.getLastAnalysis(),
      api.getUiLayout()
    ]).then(([overviewResult, settingsResult, migrationsResult, analysisResult, layoutResult]) => {
      const failures: string[] = [];
      if (overviewResult.status === "fulfilled") {
        setOverview(overviewResult.value);
        setIndexer(overviewResult.value.indexer);
      } else {
        failures.push(`系统信息：${String(overviewResult.reason)}`);
      }
      if (settingsResult.status === "fulfilled") {
        setSettings(settingsResult.value);
      } else {
        failures.push(`设置：${String(settingsResult.reason)}`);
      }
      if (migrationsResult.status === "fulfilled") {
        setHistory(migrationsResult.value);
      } else {
        failures.push(`迁移记录：${String(migrationsResult.reason)}`);
      }
      if (analysisResult.status === "fulfilled") {
        if (analysisResult.value) setSelectedPath(analysisResult.value.summary.path);
      } else {
        failures.push(`分析记录：${String(analysisResult.reason)}`);
      }
      if (layoutResult.status === "fulfilled") {
        setSidebarCollapsed(Boolean(layoutResult.value.sidebarCollapsed));
      } else {
        failures.push(`界面布局：${String(layoutResult.reason)}`);
      }
      if (failures.length > 0) {
        notify("error", `部分启动数据暂不可用：${failures.join("；")}`);
      }
    });

    const offIndexer = api.onIndexerStatus(setIndexer);
    const offMigration = api.onMigrationProgress(({ record, message }) => {
      setHistory((items) => {
        const next = items.filter((item) => item.id !== record.id);
        return [record, ...next];
      });
      if (record.stage === "linked") notify("success", message);
    });
    const offNavigation = api.onAppNavigation((event) => {
      if (event.path) {
        setSelectedPath(event.path);
        if (event.view === "analyze") {
          setAnalysisRequest((current) => ({
            path: event.path!,
            token: current.token + 1,
            pending: true
          }));
        }
      }
      setView(event.view);
      if (event.focus === "ai-settings") {
        window.setTimeout(() => {
          document.querySelector(".ai-settings")?.scrollIntoView({
            block: "start",
            behavior: "smooth"
          });
        }, 180);
      }
    });
    const offSettings = api.onSettingsChanged(setSettings);
    const offUpdate = api.onUpdateStatus(setUpdateInfo);
    void api.getUpdateState().then(setUpdateInfo).catch(() => undefined);
    return () => {
      offIndexer();
      offMigration();
      offNavigation();
      offSettings();
      offUpdate();
    };
  }, [notify]);

  const refreshUpdate = useCallback(async () => {
    const result = await api.checkForUpdates(true);
    setUpdateInfo(result);
    return result;
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      void api
        .updateUiLayout({ sidebarCollapsed: next })
        .catch((error) =>
          notify("error", `无法保存侧边栏状态：${error instanceof Error ? error.message : String(error)}`)
        );
      return next;
    });
  }, [notify]);

  const effectMode = settings?.effectMode ?? startupEffect;
  useEffect(() => {
    document.documentElement.dataset.effect = effectMode;
    document.documentElement.style.background = effectBackgrounds[effectMode];
    document.documentElement.style.colorScheme = effectMode === "calm" ? "light" : "dark";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", effectBackgrounds[effectMode]);
  }, [effectMode]);

  const switchEffect = useCallback(
    async (mode: EffectMode) => {
      if (!settings) return;
      const request = ++effectRequest.current;
      const previous = settings;
      const optimistic = { ...settings, effectMode: mode };
      setSettings(optimistic);
      try {
        const updated = await api.updateSettings({ effectMode: mode });
        if (request === effectRequest.current) setSettings(updated);
      } catch (error) {
        if (request === effectRequest.current) {
          setSettings(previous);
          notify("error", error instanceof Error ? error.message : String(error));
        }
      }
    },
    [notify, settings]
  );

  const analyzePath = useCallback((path: string) => {
    setSelectedPath(path);
    setAnalysisRequest((current) => ({
      path,
      token: current.token + 1,
      pending: true
    }));
    setView("analyze");
  }, []);

  const handleAutoAnalysis = useCallback(() => {
    setAnalysisRequest((current) => ({ ...current, pending: false }));
  }, []);

  const migratePath = useCallback((path: string) => {
    setSelectedPath(path);
    setView("migrate");
  }, []);

  const viewContent = useMemo(() => {
    switch (view) {
      case "overview":
        return (
          <OverviewView
            overview={overview}
            history={history}
            settings={settings}
            onNavigate={setView}
            notify={notify}
          />
        );
      case "search":
        return (
          <SearchView
            indexer={indexer}
            drives={overview?.drives ?? []}
            onAnalyze={analyzePath}
            onMigrate={migratePath}
            notify={notify}
          />
        );
      case "ownership-map":
        return (
          <OwnershipMapView
            drives={overview?.drives ?? []}
            onAnalyze={analyzePath}
            onMigrate={migratePath}
            notify={notify}
          />
        );
      case "analyze":
        return (
          <AnalyzeView
            initialPath={selectedPath}
            aiEnabled={settings?.ai.enabled ?? false}
            autoAnalyzeToken={analysisRequest.token}
            autoAnalyzePending={
              analysisRequest.pending && analysisRequest.path === selectedPath
            }
            onAutoAnalyzeHandled={handleAutoAnalysis}
            onPathChange={setSelectedPath}
            onMigrate={migratePath}
            notify={notify}
          />
        );
      case "migrate":
        return (
          <MigrateView
            initialPath={selectedPath}
            notify={notify}
            onCompleted={refreshHistory}
            onAnalyze={analyzePath}
          />
        );
      case "history":
        return <HistoryView records={history} notify={notify} onRefresh={refreshHistory} />;
      case "settings":
        return settings ? (
          <SettingsView
            settings={settings}
            indexer={indexer}
            updateInfo={updateInfo}
            onCheckForUpdates={refreshUpdate}
            onSettings={setSettings}
            notify={notify}
          />
        ) : null;
    }
  }, [
    analyzePath,
    analysisRequest,
    handleAutoAnalysis,
    history,
    indexer,
    migratePath,
    notify,
    overview,
    refreshUpdate,
    refreshHistory,
    selectedPath,
    settings,
    updateInfo,
    view
  ]);

  return (
    <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <BackgroundFX mode={effectMode} />
      <Sidebar
        active={view}
        onChange={setView}
        indexer={indexer}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
        updateInfo={updateInfo}
      />
      <main className="main-stage">
        <div className="topbar">
          <div className="top-status">
            <span className={indexer.state === "ready" ? "status-dot online" : "status-dot"} />
            <Database size={14} />
            <span>
              {indexer.state === "ready"
                ? `自研索引 · ${indexer.mode.toUpperCase()}`
                : "正在准备索引"}
            </span>
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className="privacy-pill"
              title={
                settings?.ai.enabled
                  ? "AI 辅助已启用；发送范围由隐私设置控制。点击查看设置"
                  : "当前仅使用本地规则分析，不会向 AI 服务发送数据。点击配置 AI"
              }
              onClick={() => setView("settings")}
            >
              {settings?.ai.enabled ? <Bot size={14} /> : <CloudOff size={14} />}
              {settings?.ai.enabled ? "AI：辅助分析" : "AI：仅本地"}
            </button>
            <div className="effect-switcher" title="即时切换场景特效">
              <Palette size={14} />
              {effectDefinitions.map(({ id: mode }) => (
                <button
                  type="button"
                  className={effectMode === mode ? "active" : ""}
                  onClick={() => void switchEffect(mode)}
                  key={mode}
                >
                  {effectLabels[mode]}
                </button>
              ))}
            </div>
            <ShieldCheck className="shield-top" size={17} />
          </div>
        </div>
        <section className="view-scroll">
          <Suspense
            fallback={
              <div className="view-loading-shell" role="status" aria-live="polite">
                <span className="spinner" />
                <strong>正在打开功能页面</strong>
                <small>界面模块按需载入，索引和数据不会重新构建。</small>
              </div>
            }
          >
            {viewContent}
          </Suspense>
        </section>
      </main>
      <Toasts items={toasts} dismiss={(id) => setToasts((items) => items.filter((x) => x.id !== id))} />
    </div>
  );
}
