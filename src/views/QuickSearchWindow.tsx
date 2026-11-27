import { useCallback, useEffect, useRef, useState } from "react";
import { Database, Palette, Search, Sparkles } from "lucide-react";
import { BackgroundFX } from "../components/BackgroundFX";
import { Toasts, type ToastItem } from "../components/ui";
import { api } from "../lib/api";
import {
  effectBackgrounds,
  effectDefinitions,
  isEffectMode,
  isLightEffect
} from "../lib/effects";
import { setAppLanguage, useI18n, type TranslationKey } from "../lib/i18n";
import { applyTextScale } from "../lib/textScale";
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
  root: "All local drives",
  message: "Connecting to the full-disk name index"
};

function initialEffectMode(): EffectMode {
  const value = document.documentElement.dataset.effect;
  return isEffectMode(value) ? value : "aurora";
}

export function QuickSearchWindow() {
  const { t, formatNumber } = useI18n();
  const [overview, setOverview] = useState<SystemOverview>();
  const [indexer, setIndexer] = useState(initialIndexer);
  const [settings, setSettings] = useState<AppSettings>();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const searchWindowRef = useRef<HTMLElement>(null);
  const effectMode = settings?.effectMode ?? initialEffectMode();

  const notify = useCallback((type: ToastItem["type"], message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1_000);
    setToasts((items) => [...items.slice(-3), { id, type, message }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 4_500);
  }, []);

  useEffect(() => {
    let active = true;
    let indexerChanged = false;
    let settingsChanged = false;
    void Promise.allSettled([
      api.getOverview(),
      api.getSettings(),
      api.indexerStatus()
    ]).then(([overviewResult, settingsResult, indexerResult]) => {
      if (!active) return;
      if (overviewResult.status === "fulfilled") {
        setOverview((current) => current ?? overviewResult.value);
        if (!indexerChanged) setIndexer(overviewResult.value.indexer);
      }
      if (settingsResult.status === "fulfilled" && !settingsChanged) {
        setSettings(settingsResult.value);
        setAppLanguage(settingsResult.value.language);
        applyTextScale(settingsResult.value.uiScale);
      }
      if (indexerResult.status === "fulfilled" && !indexerChanged) setIndexer(indexerResult.value);
    });
    const offStatus = api.onIndexerStatus((status) => {
      indexerChanged = true;
      setIndexer(status);
    });
    const offSettings = api.onSettingsChanged((updated) => {
      settingsChanged = true;
      setSettings(updated);
      setAppLanguage(updated.language);
      applyTextScale(updated.uiScale);
    });
    const offTextScale = api.onTextScalePreview(applyTextScale);
    return () => {
      active = false;
      offStatus();
      offSettings();
      offTextScale();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let timer = 0;
    let revision = 0;
    const refreshDrives = () => {
      if (document.visibilityState === "hidden" || timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        if (document.visibilityState === "hidden") return;
        const requested = ++revision;
        void api.getOverview().then((updated) => {
          if (active && requested === revision) {
            setOverview((current) => current ? { ...current, drives: updated.drives } : updated);
          }
        }).catch(() => undefined);
      }, 120);
    };
    const offDrives = api.onDrivesChanged(refreshDrives);
    window.addEventListener("focus", refreshDrives);
    document.addEventListener("visibilitychange", refreshDrives);
    return () => {
      active = false;
      window.clearTimeout(timer);
      offDrives();
      window.removeEventListener("focus", refreshDrives);
      document.removeEventListener("visibilitychange", refreshDrives);
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const focusSearch = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        searchWindowRef.current?.querySelector<HTMLInputElement>(".search-keyword-editor > input")?.focus();
      });
    };
    focusSearch();
    const offNavigation = api.onAppNavigation((event) => {
      if (event.view === "search" && event.focus === "search-input") focusSearch();
    });
    window.addEventListener("focus", focusSearch);
    return () => {
      window.cancelAnimationFrame(frame);
      offNavigation();
      window.removeEventListener("focus", focusSearch);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.effect = effectMode;
    document.documentElement.style.background = effectBackgrounds[effectMode];
    document.documentElement.style.colorScheme = isLightEffect(effectMode) ? "light" : "dark";
    document.title = t("quick.title");
  }, [effectMode, t]);

  const switchEffect = useCallback(
    async (mode: EffectMode) => {
      if (!settings || mode === settings.effectMode) return;
      const previous = settings;
      setSettings({ ...settings, effectMode: mode });
      try {
        setSettings(await api.updateSettings({ effectMode: mode }));
      } catch (error) {
        setSettings(previous);
        notify("error", error instanceof Error ? error.message : String(error));
      }
    },
    [notify, settings]
  );

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
    <main className="quick-search-window quick-search-workspace" ref={searchWindowRef}>
      <BackgroundFX mode={effectMode} />
      <header className="quick-search-titlebar">
        <span className="quick-search-brand">
          <Sparkles size={16} />
          <strong>{t("quick.title")}</strong>
        </span>
        <div className="quick-search-title-actions">
          <span className="quick-search-title-status">
            <Database size={12} />
            {indexer.state === "ready"
              ? t("quick.indexEntries", { count: formatNumber(indexer.entries) })
              : t("quick.indexPreparing")}
          </span>
          <div className="quick-search-effect-switcher" aria-label={t("quick.switchTheme")}>
            <Palette size={12} aria-hidden="true" />
            {effectDefinitions.map((effect) => (
              <button
                className={effect.id === effectMode ? "active" : ""}
                key={effect.id}
                type="button"
                title={`${t(`effect.${effect.id}.title` as TranslationKey)} · ${t(`effect.${effect.id}.subtitle` as TranslationKey)}`}
                aria-label={t(`effect.${effect.id}.title` as TranslationKey)}
                aria-pressed={effect.id === effectMode}
                onClick={() => void switchEffect(effect.id)}
              >
                {t(`effect.${effect.id}.label` as TranslationKey)}
              </button>
            ))}
          </div>
        </div>
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
        {t("quick.handoff")}
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
