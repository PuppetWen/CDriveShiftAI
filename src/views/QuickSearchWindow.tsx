import { useCallback, useEffect, useState } from "react";
import { Database, Search, Sparkles } from "lucide-react";
import { BackgroundFX } from "../components/BackgroundFX";
import { Toasts, type ToastItem } from "../components/ui";
import { api } from "../lib/api";
import {
  effectBackgrounds
} from "../lib/effects";
import type {
  AppSettings,
  EffectMode,
  IndexerStatus,
  SystemOverview
} from "../types";
import { SearchView } from "./SearchView";

const initialIndexer: IndexerStatus = {
  mode: "loading",
  state: "idle",
  entries: 0,
  progress: 0,
  root: "本机所有磁盘",
  message: "正在连接全盘名称索引"
};

function initialEffectMode(): EffectMode {
  const value = document.documentElement.dataset.effect;
  return value === "matrix" || value === "calm" ? value : "aurora";
}

export function QuickSearchWindow() {
  const [overview, setOverview] = useState<SystemOverview>();
  const [indexer, setIndexer] = useState(initialIndexer);
  const [settings, setSettings] = useState<AppSettings>();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const effectMode = settings?.effectMode ?? initialEffectMode();

  const notify = useCallback((type: ToastItem["type"], message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1_000);
    setToasts((items) => [...items.slice(-3), { id, type, message }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 4_500);
  }, []);

  useEffect(() => {
    void Promise.allSettled([
      api.getOverview(),
      api.getSettings(),
      api.indexerStatus()
    ]).then(([overviewResult, settingsResult, indexerResult]) => {
      if (overviewResult.status === "fulfilled") {
        setOverview(overviewResult.value);
        setIndexer(overviewResult.value.indexer);
      }
      if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
      if (indexerResult.status === "fulfilled") setIndexer(indexerResult.value);
    });
    const offStatus = api.onIndexerStatus(setIndexer);
    const offSettings = api.onSettingsChanged(setSettings);
    return () => {
      offStatus();
      offSettings();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.effect = effectMode;
    document.documentElement.style.background = effectBackgrounds[effectMode];
    document.documentElement.style.colorScheme =
      effectMode === "calm" ? "light" : "dark";
  }, [effectMode]);

  const handoff = useCallback(
    async (view: "analyze" | "migrate", path: string) => {
      try {
        await api.navigateApp({ view, path });
        await api.finishUtilityWindow();
      } catch (error) {
        notify("error", error instanceof Error ? error.message : String(error));
      }
    },
    [notify]
  );

  return (
    <main className="quick-search-window quick-search-workspace">
      <BackgroundFX mode={effectMode} />
      <header className="quick-search-titlebar">
        <span className="quick-search-brand">
          <Sparkles size={16} />
          <strong>CDriveShiftAI · 独立极速搜索</strong>
        </span>
        <span className="quick-search-title-status">
          <Database size={12} />
          {indexer.state === "ready"
            ? `${indexer.entries.toLocaleString()} 条索引`
            : indexer.message ?? "正在准备索引"}
        </span>
      </header>

      <section className="quick-search-workspace-body">
        <SearchView
          standalone
          indexer={indexer}
          drives={overview?.drives ?? []}
          onAnalyze={(path) => void handoff("analyze", path)}
          onMigrate={(path) => void handoff("migrate", path)}
          notify={notify}
        />
      </section>

      <div className="quick-search-handoff-note">
        <Search size={12} />
        搜索、筛选、正则、书签、属性与右键功能和主程序共用；“分析”或“迁移”会接续到主窗口。
      </div>
      <Toasts
        items={toasts}
        dismiss={(id) =>
          setToasts((items) => items.filter((item) => item.id !== id))
        }
      />
    </main>
  );
}
