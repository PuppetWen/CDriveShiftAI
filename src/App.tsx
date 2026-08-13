import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { Bot, CloudOff, Database, Palette, ShieldCheck } from "lucide-react";
import { api } from "./lib/api";
import {
  effectBackgrounds,
  effectDefinitions,
  isEffectMode,
  isLightEffect
} from "./lib/effects";
import { setAppLanguage, useI18n, type TranslationKey } from "./lib/i18n";
import { applyTextScale } from "./lib/textScale";
import type {
  AppSettings,
  AppUpdateInfo,
  EffectMode,
  IndexerStatus,
  MigrationRecord,
  SettingsModuleId,
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
  root: "All local drives",
  message: "Connecting to the index service"
};

function initialEffectMode(): EffectMode {
  const value = document.documentElement.dataset.effect;
  return isEffectMode(value) ? value : "aurora";
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
  const { t, ui, runtimeText } = useI18n();
  const [view, setView] = useState<ViewId>(initialView);
  const [overview, setOverview] = useState<SystemOverview>();
  const [settings, setSettings] = useState<AppSettings>();
  const [indexer, setIndexer] = useState<IndexerStatus>(fallbackStatus);
  const [history, setHistory] = useState<MigrationRecord[]>([]);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(238);
  const [settingsModule, setSettingsModule] =
    useState<SettingsModuleId>("update");
  const [selectedPath, setSelectedPath] = useState("");
  const [analysisRequest, setAnalysisRequest] = useState({
    path: "",
    token: 0,
    pending: false
  });
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [startupEffect] = useState<EffectMode>(initialEffectMode);
  const effectRequest = useRef(0);
  const viewScrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      viewScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view]);

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
        failures.push(`${ui("系统信息", "System overview")}: ${String(overviewResult.reason)}`);
      }
      if (settingsResult.status === "fulfilled") {
        setSettings(settingsResult.value);
        setAppLanguage(settingsResult.value.language);
      } else {
        failures.push(`${ui("设置", "Settings")}: ${String(settingsResult.reason)}`);
      }
      if (migrationsResult.status === "fulfilled") {
        setHistory(migrationsResult.value);
      } else {
        failures.push(`${ui("迁移记录", "Migration history")}: ${String(migrationsResult.reason)}`);
      }
      if (analysisResult.status === "fulfilled") {
        if (analysisResult.value) setSelectedPath(analysisResult.value.summary.path);
      } else {
        failures.push(`${ui("分析记录", "Analysis history")}: ${String(analysisResult.reason)}`);
      }
      if (layoutResult.status === "fulfilled") {
        setSidebarCollapsed(Boolean(layoutResult.value.sidebarCollapsed));
        if (layoutResult.value.sidebarWidth) {
          setSidebarWidth(Math.max(190, Math.min(360, layoutResult.value.sidebarWidth)));
        }
      } else {
        failures.push(`${ui("界面布局", "UI layout")}: ${String(layoutResult.reason)}`);
      }
      if (failures.length > 0) {
        notify("error", `${ui("部分启动数据暂不可用", "Some startup data is temporarily unavailable")}: ${failures.join("; ")}`);
      }
    });

    const offIndexer = api.onIndexerStatus(setIndexer);
    const offMigration = api.onMigrationProgress(({ record, message }) => {
      setHistory((items) => {
        const next = items.filter((item) => item.id !== record.id);
        return [record, ...next];
      });
      if (record.stage === "linked") notify("success", runtimeText(message));
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
        setSettingsModule("ai");
        window.setTimeout(() => {
          document.querySelector(".ai-settings")?.scrollIntoView({
            block: "start",
            behavior: "smooth"
          });
        }, 180);
      }
    });
    const offSettings = api.onSettingsChanged((updated) => {
      setSettings(updated);
      setAppLanguage(updated.language);
    });
    const offUpdate = api.onUpdateStatus(setUpdateInfo);
    void api.getUpdateState().then(setUpdateInfo).catch(() => undefined);
    return () => {
      offIndexer();
      offMigration();
      offNavigation();
      offSettings();
      offUpdate();
    };
  }, [notify, runtimeText, ui]);

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
          notify("error", `${ui("无法保存侧边栏状态", "Unable to save the sidebar state")}: ${error instanceof Error ? error.message : String(error)}`)
        );
      return next;
    });
  }, [notify, ui]);

  const resizeSidebar = useCallback(
    (width: number, collapsed: boolean, commit: boolean) => {
      const normalizedWidth = Math.max(190, Math.min(360, Math.round(width)));
      setSidebarWidth(normalizedWidth);
      setSidebarCollapsed(collapsed);
      if (!commit) return;
      void api
        .updateUiLayout({ sidebarWidth: normalizedWidth, sidebarCollapsed: collapsed })
        .catch((error) =>
          notify(
            "error",
            `${ui("无法保存侧边栏宽度", "Unable to save the sidebar width")}: ${error instanceof Error ? error.message : String(error)}`
          )
        );
    },
    [notify, ui]
  );

  const effectMode = settings?.effectMode ?? startupEffect;
  useEffect(() => {
    applyTextScale(settings?.uiScale ?? 1);
  }, [settings?.uiScale]);

  useEffect(() => api.onTextScalePreview(applyTextScale), []);

  useEffect(() => {
    document.documentElement.dataset.effect = effectMode;
    document.documentElement.style.background = effectBackgrounds[effectMode];
    document.documentElement.style.colorScheme = isLightEffect(effectMode) ? "light" : "dark";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", effectBackgrounds[effectMode]);
    document.title = `CDriveShiftAI · ${t("app.tagline")}`;
  }, [effectMode, t]);

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
            activeModule={settingsModule}
            onCheckForUpdates={refreshUpdate}
            onModuleChange={setSettingsModule}
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
    settingsModule,
    updateInfo,
    view
  ]);

  return (
    <div
      className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <BackgroundFX mode={effectMode} />
      <Sidebar
        active={view}
        onChange={setView}
        indexer={indexer}
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        onToggle={toggleSidebar}
        onResize={resizeSidebar}
        updateInfo={updateInfo}
      />
      <main className="main-stage">
        <div className="topbar">
          <div className="top-status">
            <span className={indexer.state === "ready" ? "status-dot online" : "status-dot"} />
            <Database size={14} />
            <span>
              {indexer.state === "ready"
                ? t("top.indexReady", { mode: indexer.mode.toUpperCase() })
                : t("top.indexPreparing")}
            </span>
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className="privacy-pill"
              title={
                settings?.ai.enabled
                  ? t("top.aiEnabledTip")
                  : t("top.aiLocalTip")
              }
              onClick={() => setView("settings")}
            >
              {settings?.ai.enabled ? <Bot size={14} /> : <CloudOff size={14} />}
              {settings?.ai.enabled ? t("top.aiEnabled") : t("top.aiLocal")}
            </button>
            <div className="effect-switcher" title={t("top.switchTheme")}>
              <Palette size={14} />
              {effectDefinitions.map(({ id: mode }) => (
                <button
                  type="button"
                  className={effectMode === mode ? "active" : ""}
                  onClick={() => void switchEffect(mode)}
                  key={mode}
                >
                  {t(`effect.${mode}.label` as TranslationKey)}
                </button>
              ))}
            </div>
            <ShieldCheck className="shield-top" size={17} />
          </div>
        </div>
        <section className="view-scroll" ref={viewScrollRef} key={view}>
          <Suspense
            fallback={
              <div className="view-loading-shell" role="status" aria-live="polite">
                <span className="spinner" />
                <strong>{t("loading.page")}</strong>
                <small>{t("loading.detail")}</small>
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
