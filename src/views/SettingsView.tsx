import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import {
  AlertCircle,
  Bot,
  ChevronDown,
  CheckCircle2,
  Cloud,
  Database,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileJson,
  FolderOpen,
  History,
  KeyRound,
  Keyboard,
  Languages,
  Laptop,
  LockKeyhole,
  MessageSquareText,
  MousePointer2,
  Palette,
  PlugZap,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Wifi,
  X
} from "lucide-react";
import { api } from "../lib/api";
import { effectDefinitions } from "../lib/effects";
import { getAiProvider } from "../lib/aiProviders";
import {
  MOUSE_HOLD_MAX_MS,
  MOUSE_HOLD_MIN_MS,
  MOUSE_HOLD_STEP_MS,
  mouseHoldProgress,
  mouseShortcutButtonFromEventCode,
  normalizeMouseHoldMs
} from "../lib/mouseShortcut";
import {
  bundledReleaseNotes,
  bundledReleaseNotesEnglish
} from "../lib/releaseNotes";
import {
  bundledReleaseHistory,
  bundledReleaseHistoryEnglish
} from "../lib/releaseHistory";
import {
  languageName,
  resolvedLanguage,
  setAppLanguage,
  translate,
  useI18n,
  type TranslationKey
} from "../lib/i18n";
import type {
  AiModelInfo,
  AiTestResult,
  AppLanguage,
  AppSettings,
  AppUpdateInfo,
  EffectMode,
  IndexerStatus,
  MouseShortcutButton,
  MouseShortcutStatus,
  SettingsModuleId,
  ShortcutCheckResult,
  ShortcutTarget,
  UiScale
} from "../types";
import { AiProviderPicker } from "../components/AiProviderPicker";
import { AiModelPicker } from "../components/AiModelPicker";
import { LanguagePicker } from "../components/LanguagePicker";
import { Badge, PageTitle } from "../components/ui";

interface SettingsViewProps {
  settings: AppSettings;
  indexer: IndexerStatus;
  updateInfo?: AppUpdateInfo;
  activeModule: SettingsModuleId;
  onCheckForUpdates: () => Promise<AppUpdateInfo>;
  onModuleChange: (module: SettingsModuleId) => void;
  onSettings: (settings: AppSettings) => void;
  notify: (type: "success" | "error", message: string) => void;
}

function captureShortcut(event: React.KeyboardEvent<HTMLInputElement>): string | undefined {
  if (event.key === "Backspace" || event.key === "Delete") return "";
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const key =
    event.key === " "
      ? "Space"
      : event.key.length === 1
        ? event.key.toUpperCase()
        : event.key;
  if (!parts.length || !key) return undefined;
  return [...parts, key].join("+");
}

function formatUpdateBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024))
  );
  return `${(value / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${
    units[exponent]
  }`;
}

function updateStageIndex(phase: AppUpdateInfo["phase"]): number {
  switch (phase) {
    case "downloading":
      return 0;
    case "verifying":
      return 1;
    case "ready":
      return 2;
    case "installing":
      return 3;
    default:
      return -1;
  }
}

const shortcutKeyLabels: Record<string, string> = {
  CommandOrControl: "Ctrl",
  Command: "Win",
  Control: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Space: "Space"
};

interface ShortcutRecorderProps {
  label: string;
  description: string;
  target: ShortcutTarget;
  value: string;
  otherValue: string;
  testing: boolean;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  onTest: () => void;
}

function ShortcutRecorder({
  label,
  description,
  target,
  value,
  otherValue,
  testing,
  onChange,
  onCommit,
  onTest
}: ShortcutRecorderProps) {
  const { ui, runtimeText } = useI18n();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ShortcutCheckResult>({
    available: false,
    active: false,
    shortcut: value,
    message: ui("点击输入框并按下组合键", "Click the field and press a key combination")
  });
  const [recording, setRecording] = useState(false);
  const duplicate =
    Boolean(value.trim()) &&
    value.trim().toLocaleLowerCase() === otherValue.trim().toLocaleLowerCase();

  useEffect(() => {
    if (!value.trim()) {
      setChecking(false);
      setResult({
        available: false,
        active: false,
        shortcut: "",
        message: ui("未启用；录入组合键后会自动检查冲突", "Disabled; conflicts are checked automatically after recording a shortcut")
      });
      return;
    }
    if (duplicate) {
      setChecking(false);
      setResult({
        available: false,
        active: false,
        shortcut: value,
        message: ui("与另一个 CDriveShiftAI 快捷键重复", "Duplicates another CDriveShiftAI shortcut")
      });
      return;
    }
    let cancelled = false;
    setChecking(true);
    const timer = window.setTimeout(() => {
      void api
        .checkGlobalShortcut(value, target)
        .then((status) => {
          if (!cancelled) setResult(status);
        })
        .catch((error) => {
          if (!cancelled) {
            setResult({
              available: false,
              active: false,
              shortcut: value,
              message: error instanceof Error ? error.message : String(error)
            });
          }
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [duplicate, otherValue, target, ui, value]);

  const keys = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => shortcutKeyLabels[part] ?? part);
  const tone = checking
    ? "checking"
    : result.available
      ? result.active
        ? "active"
        : "available"
      : "conflict";

  return (
    <article className={`shortcut-recorder ${tone}`}>
      <header>
        <span>
          {target === "main" ? <Keyboard size={15} /> : <Search size={15} />}
          <span>
            <strong>{label}</strong>
            <small>{description}</small>
          </span>
        </span>
        <em>
          {checking
            ? ui("检查中", "Checking")
            : result.active
              ? ui("已启用", "Enabled")
              : result.available
                ? ui("可使用", "Available")
                : value
                  ? ui("有冲突", "Conflict")
                  : ui("未设置", "Not set")}
        </em>
      </header>
      <div className={recording ? "shortcut-capture recording" : "shortcut-capture"}>
        <input
          value={keys.join(" + ")}
          readOnly
          aria-label={`${label} ${ui("快捷键", "shortcut")}`}
          placeholder={recording ? ui("请按下组合键…", "Press a key combination…") : ui("点击这里录入快捷键", "Click to record a shortcut")}
          onFocus={() => setRecording(true)}
          onBlur={() => {
            setRecording(false);
            onCommit(value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab" || event.key === "Escape") return;
            event.preventDefault();
            const shortcut = captureShortcut(event);
            if (shortcut !== undefined) onChange(shortcut);
          }}
        />
        {value && (
          <button
            type="button"
            title={ui("清除并禁用此快捷键", "Clear and disable this shortcut")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange("");
              onCommit("");
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
      <footer>
        <span>
          {checking ? <RefreshCw className="spin" size={12} /> : result.available ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
          {runtimeText(result.message)}
        </span>
        <button
          type="button"
          className="secondary-button"
          disabled={!result.active || checking || testing}
          onClick={onTest}
        >
          {testing ? <span className="spinner" /> : <PlugZap size={13} />}
          {ui("测试唤起", "Test shortcut")}
        </button>
      </footer>
    </article>
  );
}

export function SettingsView({
  settings,
  indexer,
  updateInfo,
  activeModule,
  onCheckForUpdates,
  onModuleChange,
  onSettings,
  notify
}: SettingsViewProps) {
  const { locale, t, ui, runtimeText, formatNumber, formatDate } = useI18n();
  const [draft, setDraft] = useState(settings);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [rebuilding, setRebuilding] = useState(false);
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [aiSaveState, setAiSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [testingShortcut, setTestingShortcut] = useState<ShortcutTarget>();
  const [testingMouseShortcut, setTestingMouseShortcut] = useState(false);
  const [mouseButtonRecording, setMouseButtonRecording] = useState(false);
  const [mouseRecorderHint, setMouseRecorderHint] = useState("");
  const [activeReleaseModule, setActiveReleaseModule] = useState<string>();
  const [mouseShortcutStatus, setMouseShortcutStatus] =
    useState<MouseShortcutStatus>();
  const [showApiKey, setShowApiKey] = useState(false);
  const [aiTest, setAiTest] = useState<AiTestResult>();
  const effectRequest = useRef(0);
  const uiScaleRequest = useRef(0);
  const behaviorRequests = useRef({
    launchAtLogin: 0,
    launchMinimized: 0,
    minimizeToTray: 0
  });
  const shortcutRequests = useRef({
    main: 0,
    "quick-search": 0
  });
  const mouseShortcutRequest = useRef(0);
  const mouseCaptureBlockUntil = useRef(0);
  const aiDraftRequest = useRef(0);
  const apiKeyDirty = useRef(false);
  const persistedSettingsRef = useRef(settings);
  const updateBusy = ["downloading", "verifying", "ready", "installing"].includes(
    updateInfo?.phase ?? ""
  );
  const bundledNotesMatch =
    !updateInfo ||
    updateInfo.latestVersion === bundledReleaseNotes.version ||
    (!updateInfo.updateAvailable &&
      updateInfo.currentVersion === bundledReleaseNotes.version);
  const localizedBundledReleaseNotes =
    locale === "zh-CN" ? bundledReleaseNotes : bundledReleaseNotesEnglish;
  const historicalReleases = (
    locale === "zh-CN" ? bundledReleaseHistory : bundledReleaseHistoryEnglish
  ).filter(
    (release) => release.version !== localizedBundledReleaseNotes.version
  );
  const releaseSections = bundledNotesMatch
    ? localizedBundledReleaseNotes.sections
    : updateInfo?.releaseSections?.length
      ? updateInfo.releaseSections.map((section) => ({
          title: runtimeText(section.title),
          items: section.items.map((item) => runtimeText(item))
        }))
      : [];
  const releaseSummary =
    bundledNotesMatch
      ? localizedBundledReleaseNotes.summary
      : runtimeText(updateInfo?.releaseSummary ?? updateInfo?.releaseName);
  const activeReleaseSection =
    releaseSections.find((section) => section.title === activeReleaseModule) ??
    releaseSections[0];

  useEffect(() => {
    document.querySelector(".view-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeModule]);

  useEffect(() => {
    const previous = persistedSettingsRef.current;
    setDraft((current) => {
      const next = {
        ...current,
        effectMode: settings.effectMode,
        language: settings.language,
        uiScale: settings.uiScale
      };
      if (previous.launchAtLogin !== settings.launchAtLogin) {
        next.launchAtLogin = settings.launchAtLogin;
      }
      if (previous.launchMinimized !== settings.launchMinimized) {
        next.launchMinimized = settings.launchMinimized;
      }
      if (previous.minimizeToTray !== settings.minimizeToTray) {
        next.minimizeToTray = settings.minimizeToTray;
      }
      if (previous.globalShortcut !== settings.globalShortcut) {
        next.globalShortcut = settings.globalShortcut;
      }
      if (previous.quickSearchShortcut !== settings.quickSearchShortcut) {
        next.quickSearchShortcut = settings.quickSearchShortcut;
      }
      if (
        previous.mouseQuickSearchButton !== settings.mouseQuickSearchButton
      ) {
        next.mouseQuickSearchButton = settings.mouseQuickSearchButton;
      }
      if (previous.mouseQuickSearchHoldMs !== settings.mouseQuickSearchHoldMs) {
        next.mouseQuickSearchHoldMs = settings.mouseQuickSearchHoldMs;
      }
      if (JSON.stringify(previous.indexRoots) !== JSON.stringify(settings.indexRoots)) {
        next.indexRoots = settings.indexRoots;
      }
      if (
        JSON.stringify(previous.excludedPaths) !==
        JSON.stringify(settings.excludedPaths)
      ) {
        next.excludedPaths = settings.excludedPaths;
      }
      if (JSON.stringify(previous.ai) !== JSON.stringify(settings.ai)) {
        next.ai = settings.ai;
      }
      return next;
    });
    persistedSettingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getMouseShortcutStatus()
      .then((status) => {
        if (!cancelled) setMouseShortcutStatus(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [settings.mouseQuickSearchButton, settings.mouseQuickSearchHoldMs]);

  const chooseEffect = async (effectMode: EffectMode) => {
    const request = ++effectRequest.current;
    const previous = draft;
    const next = { ...draft, effectMode };
    setDraft(next);
    try {
      const updated = await api.updateSettings({ effectMode });
      if (request === effectRequest.current) onSettings(updated);
    } catch (error) {
      if (request === effectRequest.current) {
        setDraft(previous);
        notify("error", error instanceof Error ? error.message : String(error));
      }
    }
  };

  const chooseLanguage = async (language: AppLanguage) => {
    if (language === draft.language) return;
    const previous = draft.language;
    setDraft((current) => ({ ...current, language }));
    setAppLanguage(language);
    try {
      const updated = await api.updateSettings({ language });
      onSettings(updated);
      setDraft((current) => ({ ...current, language: updated.language }));
      setAppLanguage(updated.language);
      notify(
        "success",
        translate(
          "settings.languageApplied",
          { language: languageName(updated.language, updated.language) },
          updated.language
        )
      );
    } catch (error) {
      setDraft((current) => ({ ...current, language: previous }));
      setAppLanguage(previous);
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const chooseUiScale = async (uiScale: UiScale) => {
    if (uiScale === draft.uiScale) return;
    const request = ++uiScaleRequest.current;
    const previous = draft.uiScale;
    setDraft((current) => ({ ...current, uiScale }));
    try {
      const updated = await api.updateSettings({ uiScale });
      if (request !== uiScaleRequest.current) return;
      onSettings(updated);
      setDraft((current) => ({ ...current, uiScale: updated.uiScale }));
      notify(
        "success",
        ui("字体与界面大小已应用", "Text and interface size applied")
      );
    } catch (error) {
      if (request !== uiScaleRequest.current) return;
      setDraft((current) => ({ ...current, uiScale: previous }));
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const updateBehaviorSetting = async (
    field: "launchAtLogin" | "launchMinimized" | "minimizeToTray",
    value: boolean
  ) => {
    const request = ++behaviorRequests.current[field];
    setDraft((current) => ({ ...current, [field]: value }));
    try {
      const updated = await api.updateSettings({ [field]: value });
      if (request !== behaviorRequests.current[field]) return;
      onSettings(updated);
      setDraft((current) => ({ ...current, [field]: updated[field] }));
    } catch (error) {
      if (request === behaviorRequests.current[field]) {
        setDraft((current) => ({ ...current, [field]: settings[field] }));
        notify("error", error instanceof Error ? error.message : String(error));
      }
    }
  };

  const commitShortcut = async (target: ShortcutTarget, value: string) => {
    const field =
      target === "main" ? "globalShortcut" : "quickSearchShortcut";
    if (value === persistedSettingsRef.current[field]) return;
    const request = ++shortcutRequests.current[target];
    try {
      if (value.trim()) {
        const availability = await api.checkGlobalShortcut(value, target);
        if (request !== shortcutRequests.current[target]) return;
        if (!availability.available) return;
      }
      const updated = await api.updateSettings({
        [field]: value
      });
      if (request !== shortcutRequests.current[target]) return;
      onSettings(updated);
      setDraft((current) => ({
        ...current,
        globalShortcut: updated.globalShortcut,
        quickSearchShortcut: updated.quickSearchShortcut
      }));
      notify(
        "success",
        target === "main"
          ? ui("主界面快捷键已自动保存并注册", "The main-window shortcut was saved and registered")
          : ui("独立极速搜索快捷键已自动保存并注册", "The standalone search shortcut was saved and registered")
      );
    } catch (error) {
      if (request !== shortcutRequests.current[target]) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/快捷键.*(?:占用|冲突|格式无效)/u.test(message)) {
        // Keep the attempted value visible. ShortcutRecorder continuously
        // checks it and renders the conflict as red inline guidance.
        return;
      }
      setDraft((current) => ({
        ...current,
        [field]: persistedSettingsRef.current[field]
      }));
      notify("error", message);
    }
  };

  const testShortcut = async (target: ShortcutTarget) => {
    setTestingShortcut(target);
    try {
      await api.testGlobalShortcut(target);
      notify(
        "success",
        target === "main"
          ? ui("主界面快捷键已成功调用", "The main-window shortcut opened successfully")
          : ui("独立极速搜索测试窗口已打开", "The standalone search test window opened")
      );
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setTestingShortcut(undefined);
    }
  };

  const commitMouseShortcut = async (
    patch: Partial<
      Pick<AppSettings, "mouseQuickSearchButton" | "mouseQuickSearchHoldMs">
    >
  ) => {
    const previous = persistedSettingsRef.current;
    const changed = Object.entries(patch).some(
      ([field, value]) => previous[field as keyof AppSettings] !== value
    );
    if (!changed) return;
    const request = ++mouseShortcutRequest.current;
    setDraft((current) => ({ ...current, ...patch }));
    try {
      const updated = await api.updateSettings(patch);
      if (request !== mouseShortcutRequest.current) return;
      persistedSettingsRef.current = updated;
      onSettings(updated);
      setDraft((current) => ({
        ...current,
        mouseQuickSearchButton: updated.mouseQuickSearchButton,
        mouseQuickSearchHoldMs: updated.mouseQuickSearchHoldMs
      }));
      setMouseShortcutStatus(await api.getMouseShortcutStatus());
      notify("success", ui("鼠标快捷操作已自动保存并立即生效", "The mouse shortcut was saved and applied immediately"));
    } catch (error) {
      if (request !== mouseShortcutRequest.current) return;
      setDraft((current) => ({
        ...current,
        mouseQuickSearchButton: previous.mouseQuickSearchButton,
        mouseQuickSearchHoldMs: previous.mouseQuickSearchHoldMs
      }));
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const mouseButtonLabel = (button: MouseShortcutButton) => {
    switch (button) {
      case "back":
        return ui("后退侧键", "Back side button");
      case "forward":
        return ui("前进侧键", "Forward side button");
      case "middle":
        return ui("中键", "Middle button");
      default:
        return ui("尚未启用", "Not enabled");
    }
  };

  const captureMouseButton = (
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    if (!mouseButtonRecording) return;
    event.preventDefault();
    event.stopPropagation();
    mouseCaptureBlockUntil.current = performance.now() + 600;
    const button = mouseShortcutButtonFromEventCode(event.button);
    if (!button) {
      setMouseRecorderHint(
        event.button === 2
          ? ui("右键会打开菜单，不能作为此快捷操作", "Right click opens menus and cannot be used here")
          : ui("请按鼠标后退侧键、前进侧键或中键", "Press the back, forward, or middle mouse button")
      );
      return;
    }
    setMouseButtonRecording(false);
    setMouseRecorderHint(
      ui(`已录入：${mouseButtonLabel(button)}`, `Captured: ${mouseButtonLabel(button)}`)
    );
    void commitMouseShortcut({ mouseQuickSearchButton: button });
  };

  const testMouseShortcut = async () => {
    setTestingMouseShortcut(true);
    try {
      await api.testMouseShortcut();
      notify("success", ui("鼠标快捷操作测试成功，独立极速搜索已打开", "The mouse shortcut test succeeded and standalone search opened"));
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setTestingMouseShortcut(false);
    }
  };

  const provider = getAiProvider(draft.ai.provider);
  const useSavedKey =
    !apiKey.trim() &&
    settings.ai.hasApiKey &&
    settings.ai.provider === draft.ai.provider;
  const savedConnectionUnchanged =
    Boolean(settings.ai.verifiedAt) &&
    settings.ai.provider === draft.ai.provider &&
    settings.ai.protocol === draft.ai.protocol &&
    settings.ai.baseUrl.replace(/\/+$/, "") === draft.ai.baseUrl.trim().replace(/\/+$/, "") &&
    settings.ai.model === draft.ai.model &&
    (useSavedKey || (!settings.ai.hasApiKey && !apiKey.trim()));
  const connectionInput = useMemo(
    () => ({
      provider: draft.ai.provider,
      protocol: draft.ai.protocol,
      baseUrl: draft.ai.baseUrl,
      model: draft.ai.model || undefined,
      apiKey: apiKey.trim() || undefined,
      useSavedKey
    }),
    [
      apiKey,
      draft.ai.baseUrl,
      draft.ai.model,
      draft.ai.protocol,
      draft.ai.provider,
      useSavedKey
    ]
  );

  const invalidateAiTest = () => setAiTest(undefined);

  const persistAiDraft = async (
    nextAi: AppSettings["ai"],
    options: { replaceApiKey?: boolean; apiKeyValue?: string } = {}
  ) => {
    const request = ++aiDraftRequest.current;
    const replaceApiKey = options.replaceApiKey === true;
    setAiSaveState("saving");
    try {
      const updated = await api.saveAiDraft({
        provider: nextAi.provider,
        protocol: nextAi.protocol,
        baseUrl: nextAi.baseUrl,
        model: nextAi.model || undefined,
        apiKey: replaceApiKey
          ? options.apiKeyValue?.trim() || undefined
          : undefined,
        useSavedKey:
          !replaceApiKey &&
          settings.ai.provider === nextAi.provider &&
          settings.ai.hasApiKey,
        privacyMode: nextAi.privacyMode,
        replaceApiKey
      });
      if (request !== aiDraftRequest.current) return updated;
      onSettings(updated);
      setDraft((current) => ({ ...current, ai: updated.ai }));
      if (replaceApiKey) {
        setApiKey("");
        apiKeyDirty.current = false;
      }
      setAiSaveState("saved");
      return updated;
    } catch (error) {
      if (request === aiDraftRequest.current) {
        setAiSaveState("error");
        notify("error", error instanceof Error ? error.message : String(error));
      }
      return undefined;
    }
  };

  const chooseProvider = (providerId: AppSettings["ai"]["provider"]) => {
    const preset = getAiProvider(providerId);
    const nextAi: AppSettings["ai"] = {
      ...draft.ai,
      enabled: false,
      provider: preset.id,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: "",
      hasApiKey:
        settings.ai.provider === preset.id ? settings.ai.hasApiKey : false,
      verifiedAt: undefined
    };
    setDraft((current) => ({ ...current, ai: nextAi }));
    setApiKey("");
    apiKeyDirty.current = false;
    setModels([]);
    invalidateAiTest();
    void persistAiDraft(nextAi);
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    invalidateAiTest();
    try {
      const result = await api.listAiModels(connectionInput);
      setModels(result.models);
      const model = result.models.some((item) => item.id === draft.ai.model)
        ? draft.ai.model
        : result.models[0]?.id ?? "";
      const nextAi = {
        ...draft.ai,
        enabled: false,
        model,
        verifiedAt: undefined
      };
      setDraft((current) => ({ ...current, ai: nextAi }));
      await persistAiDraft(nextAi);
      notify(
        "success",
        ui(
          `已从 ${provider.name} 获取 ${result.models.length} 个对话模型（${Math.round(result.latencyMs)} ms）`,
          `Fetched ${result.models.length} chat models from ${provider.name} (${Math.round(result.latencyMs)} ms)`
        )
      );
    } catch (error) {
      setModels([]);
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setFetchingModels(false);
    }
  };

  const testAi = async () => {
    setTestingAi(true);
    setAiTest(undefined);
    try {
      const result = await api.testAiConnection(connectionInput);
      setAiTest(result);
      const updated = await api.saveAiSettings({
        ...connectionInput,
        enabled: true,
        privacyMode: draft.ai.privacyMode,
        verificationId: result.verificationId
      });
      onSettings(updated);
      setDraft((current) => ({ ...current, ai: updated.ai }));
      setApiKey("");
      apiKeyDirty.current = false;
      setAiSaveState("saved");
      notify(
        "success",
        ui(
          `测试对话成功并已启用，耗时 ${Math.round(result.latencyMs)} ms`,
          `The test conversation succeeded and AI was enabled (${Math.round(result.latencyMs)} ms)`
        )
      );
    } catch (error) {
      setDraft((current) => ({
        ...current,
        ai: { ...current.ai, enabled: settings.ai.enabled }
      }));
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setTestingAi(false);
    }
  };

  const setAiEnabled = async (enabled: boolean) => {
    setDraft((current) => ({
      ...current,
      ai: { ...current.ai, enabled }
    }));
    if (enabled && !savedConnectionUnchanged) {
      await testAi();
      return;
    }
    setAiSaveState("saving");
    try {
      const updated = await api.saveAiSettings({
        ...connectionInput,
        enabled,
        privacyMode: draft.ai.privacyMode,
      });
      onSettings(updated);
      setDraft((current) => ({ ...current, ai: updated.ai }));
      setAiSaveState("saved");
      notify(
        "success",
        updated.ai.enabled
          ? ui("AI 远程分析已启用", "Remote AI analysis is enabled")
          : ui("AI 远程分析已立即关闭", "Remote AI analysis is disabled")
      );
    } catch (error) {
      setAiSaveState("error");
      setDraft((current) => ({
        ...current,
        ai: { ...current.ai, enabled: settings.ai.enabled }
      }));
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const choosePrivacyMode = (
    privacyMode: AppSettings["ai"]["privacyMode"]
  ) => {
    const nextAi = { ...draft.ai, privacyMode };
    setDraft((current) => ({ ...current, ai: nextAi }));
    void persistAiDraft(nextAi);
  };

  const rebuild = async () => {
    setRebuilding(true);
    try {
      await api.rebuildIndex();
      notify("success", ui("全盘名称索引已开始刷新", "The full-drive name index refresh has started"));
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="page settings-page">
      <PageTitle
        eyebrow="PREFERENCES"
        title={t("page.settingsTitle")}
        description={t("page.settingsDescription")}
      />

      <nav className="settings-module-nav" aria-label={t("settings.navigation")}>
        {[
          {
            id: "update" as const,
            label: t("settings.module.update"),
            description: updateInfo?.updateAvailable
              ? ui(`发现 v${updateInfo.latestVersion}`, `Version v${updateInfo.latestVersion} available`)
              : t("settings.module.updateDescription"),
            icon: Download,
            tone: updateInfo?.updateAvailable ? "alert" : "mint"
          },
          {
            id: "appearance" as const,
            label: t("settings.module.appearance"),
            description: t("settings.module.appearanceDescription"),
            icon: Palette,
            tone: "purple"
          },
          {
            id: "system" as const,
            label: t("settings.module.system"),
            description: t("settings.module.systemDescription"),
            icon: Database,
            tone: "blue"
          },
          {
            id: "ai" as const,
            label: t("settings.module.ai"),
            description: draft.ai.enabled
              ? `${provider.name} · ${draft.ai.model || ui("待选择模型", "Choose a model")}`
              : t("settings.module.aiDescription"),
            icon: Bot,
            tone: "cyan"
          }
        ].map(({ id, label, description, icon: Icon, tone }) => (
          <button
            type="button"
            className={activeModule === id ? "active" : ""}
            aria-current={activeModule === id ? "page" : undefined}
            onClick={() => onModuleChange(id)}
            key={id}
          >
            <span className={`settings-module-icon ${tone}`}>
              <Icon size={17} />
            </span>
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
            <i />
          </button>
        ))}
      </nav>

      {activeModule === "update" && (
      <section className="settings-section glass-card update-settings settings-module-panel">
        <div className="settings-section-head">
          <div
            className={
              updateInfo?.updateAvailable
                ? "settings-icon update-alert"
                : updateInfo?.status === "unavailable"
                  ? "settings-icon update-warning"
                : "settings-icon update-current"
            }
          >
            <Download size={20} />
          </div>
          <div>
            <h2>{t("settings.updateTitle")}</h2>
            <p>{t("settings.updateDescription")}</p>
          </div>
          <span
            className={
              updateInfo?.updateAvailable
                ? "update-status-dot update-available"
                : updateInfo?.status === "unavailable"
                  ? "update-status-dot update-warning"
                : "update-status-dot"
            }
          />
        </div>
        <div className="update-status-panel">
          <div>
            <small>{t("settings.currentVersion")}</small>
            <strong>v{updateInfo?.currentVersion ?? bundledReleaseNotes.version}</strong>
          </div>
          <div>
            <small>{t("settings.latestVersion")}</small>
            <strong>
              {updateInfo?.latestVersion ? `v${updateInfo.latestVersion}` : t("settings.fetching")}
            </strong>
          </div>
          <div className="update-status-message">
            <small>{t("settings.status")}</small>
            <strong>
              {runtimeText(updateInfo?.message) || t("settings.updateIdle")}
            </strong>
            {updateInfo?.publishedAt && (
              <span>
                {updateInfo.distribution === "portable"
                  ? t("settings.portableUpdate")
                  : updateInfo.distribution === "installed"
                    ? t("settings.installedUpdate")
                    : t("settings.developmentMode")}{" "}
                · {t("settings.publishedAt", {
                  date: formatDate(updateInfo.publishedAt, {
                    dateStyle: "medium",
                    timeStyle: "short"
                  })
                })}
              </span>
            )}
            {updateInfo?.network && (
              <span className="update-network-route">
                <Wifi size={12} />
                {runtimeText(updateInfo.network.label)}
              </span>
            )}
          </div>
          <div className="update-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={checkingUpdate || updateBusy}
              onClick={() => {
                setCheckingUpdate(true);
                void onCheckForUpdates()
                  .catch((error) =>
                    notify(
                      "error",
                      error instanceof Error ? error.message : String(error)
                    )
                  )
                  .finally(() => setCheckingUpdate(false));
              }}
            >
              <RefreshCw size={15} className={checkingUpdate ? "spin" : ""} />
              {checkingUpdate ? t("settings.checking") : t("settings.recheck")}
            </button>
            {updateInfo?.canAutoUpdate &&
              updateInfo.updateAvailable &&
              !["downloading", "verifying", "ready", "installing"].includes(
                updateInfo.phase
              ) && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    void api.startUpdate().catch((error) =>
                      notify(
                        "error",
                        error instanceof Error ? error.message : String(error)
                      )
                    );
                  }}
                >
                  <Download size={15} />
                  {updateInfo.phase === "error" ||
                  updateInfo.phase === "cancelled"
                    ? t("settings.retryUpdate")
                    : t("settings.autoUpdate")}
                </button>
              )}
            {updateInfo?.phase === "downloading" && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void api.cancelUpdate()}
              >
                <X size={15} />
                {t("settings.pauseDownload")}
              </button>
            )}
            {updateInfo?.releaseUrl && !updateInfo.canAutoUpdate && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void api.openExternal(updateInfo.releaseUrl!)}
              >
                <ExternalLink size={15} />
                {updateInfo.updateAvailable ? t("settings.manualDownload") : t("settings.viewRelease")}
              </button>
            )}
          </div>
        </div>
        {activeReleaseSection && (
          <div className="update-release-notes" aria-label={t("settings.releaseContent")}>
            <div className="update-release-heading">
              <span className="update-release-title">
                <Sparkles size={15} />
                <span>
                  <strong>
                    {updateInfo?.updateAvailable
                      ? t("settings.thisUpdate")
                      : t("settings.currentReleaseNotes")}
                  </strong>
                  <small title={releaseSummary}>
                    {releaseSummary}
                  </small>
                </span>
              </span>
              {updateInfo?.releaseUrl && (
                <button
                  type="button"
                  className="update-release-link"
                  onClick={() => void api.openExternal(updateInfo.releaseUrl!)}
                >
                  {t("settings.fullReleaseNotes")}
                  <ExternalLink size={12} />
                </button>
              )}
            </div>
            <div className="update-release-body">
              <div className="update-release-tabs" role="tablist" aria-label={t("settings.releaseModules")}>
                {releaseSections.map((section) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={section.title === activeReleaseSection.title}
                    className={
                      section.title === activeReleaseSection.title ? "active" : ""
                    }
                    onClick={() => setActiveReleaseModule(section.title)}
                    key={section.title}
                  >
                    {section.title}
                  </button>
                ))}
              </div>
              <div className="update-release-items" role="tabpanel">
                {activeReleaseSection.items.map((item, index) => (
                  <span title={item} key={`${activeReleaseSection.title}-${index}`}>
                    <i />
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
        {updateInfo &&
          ["downloading", "verifying", "ready", "installing", "error", "cancelled"].includes(
            updateInfo.phase
          ) && (
          <div
            className={`update-progress-card phase-${updateInfo.phase}`}
            aria-live="polite"
          >
            <div className="update-progress-head">
              <span>
                <strong>
                  {updateInfo.phase === "downloading"
                    ? t("settings.updatePhase.download")
                    : updateInfo.phase === "verifying"
                      ? t("settings.updatePhase.verify")
                      : updateInfo.phase === "ready"
                        ? t("settings.updatePhase.prepare")
                        : updateInfo.phase === "installing"
                          ? t("settings.updatePhase.install")
                          : updateInfo.phase === "cancelled"
                            ? t("settings.updatePhase.paused")
                            : t("settings.updatePhase.failed")}
                </strong>
                <small>{updateInfo.selectedAsset?.name ?? t("settings.updatePackage")}</small>
              </span>
              <strong>
                {updateInfo.progress
                  ? `${updateInfo.progress.percent.toFixed(1)}%`
                  : updateInfo.phase === "installing"
                    ? t("settings.updateRestart")
                    : "—"}
              </strong>
            </div>
            <div className="update-progress-track">
              <i
                style={{
                  width: `${
                    updateInfo.phase === "verifying"
                      ? 100
                      : updateInfo.phase === "ready" ||
                          updateInfo.phase === "installing"
                        ? 100
                        : updateInfo.progress?.percent ?? 0
                  }%`
                }}
              />
            </div>
            <div className="update-progress-stages">
              {[
                t("settings.updateStage.download"),
                t("settings.updateStage.verify"),
                t("settings.updateStage.backup"),
                t("settings.updateStage.replace"),
                t("settings.updateStage.cleanup")
              ].map((stage, index) => {
                const phaseIndex = updateStageIndex(updateInfo.phase);
                return (
                  <span className={index <= phaseIndex ? "active" : ""} key={stage}>
                    <i />
                    {stage}
                  </span>
                );
              })}
            </div>
            <div className="update-progress-meta">
              <span>
                {updateInfo.progress
                  ? `${formatUpdateBytes(
                      updateInfo.progress.transferred
                    )} / ${formatUpdateBytes(updateInfo.progress.total)}`
                  : updateInfo.message}
              </span>
              {updateInfo.progress && updateInfo.phase === "downloading" && (
                <>
                  <span>
                    {formatUpdateBytes(updateInfo.progress.bytesPerSecond)}/s
                  </span>
                  <span>
                    {t("settings.updateAttempt", {
                      current: updateInfo.progress.retryAttempt,
                      total: updateInfo.progress.maxRetries
                    })}
                  </span>
                </>
              )}
              {updateInfo.phase === "verifying" && (
                <span className="update-verifying">
                  <ShieldCheck size={13} />
                  {t("settings.shaVerifying")}
                </span>
              )}
            </div>
          </div>
        )}
        <div
          className={
            updateInfo?.phase === "error"
              ? "diagnostic-actions has-error"
              : "diagnostic-actions"
          }
        >
          <span>
            <strong>{t("settings.diagnosticsTitle")}</strong>
            <small>
              {updateInfo?.phase === "error"
                ? t("settings.diagnosticsError")
                : t("settings.diagnosticsDescription")}
            </small>
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void api.openLogDirectory().catch((error) =>
                notify("error", error instanceof Error ? error.message : String(error))
              );
            }}
          >
            <FolderOpen size={14} />
            {t("settings.openLogs")}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={exportingDiagnostics}
            onClick={() => {
              setExportingDiagnostics(true);
              void api
                .exportDiagnosticReport()
                .then((result) => {
                  if (!result.cancelled) {
                    notify("success", `${ui("诊断报告已导出", "Diagnostic report exported")}: ${result.path ?? ui("已保存", "Saved")}`);
                  }
                })
                .catch((error) =>
                  notify("error", error instanceof Error ? error.message : String(error))
                )
                .finally(() => setExportingDiagnostics(false));
            }}
          >
            {exportingDiagnostics ? <span className="spinner" /> : <FileJson size={14} />}
            {exportingDiagnostics
              ? t("settings.exportingDiagnostics")
              : t("settings.exportDiagnostics")}
          </button>
        </div>
        <section className="release-history-panel" aria-label={ui("历史版本更新", "Release history")}>
          <div className="release-history-head">
            <span>
              <History size={16} />
              <span>
                <strong>{ui("历史版本更新", "Release history")}</strong>
                <small>
                  {ui(
                    "每个版本可独立展开或收起，离线也能查看完整历史。",
                    "Expand or collapse each version independently; the history remains available offline."
                  )}
                </small>
              </span>
            </span>
            <em>
              {historicalReleases.length} {ui("个版本", "versions")}
            </em>
          </div>
          <div
            className="release-history-list"
            role="region"
            tabIndex={0}
            aria-label={ui("可滚动的历史版本列表", "Scrollable release history")}
          >
            {historicalReleases.map((release) => (
              <details className="release-history-item" key={release.version}>
                <summary>
                  <span className="release-history-version">v{release.version}</span>
                  <span>
                    <strong>{release.summary}</strong>
                    <small>
                      {release.sections.length} {ui("个更新模块", "update sections")}
                    </small>
                  </span>
                  <ChevronDown size={15} />
                </summary>
                <div className="release-history-content">
                  {release.sections.map((section) => (
                    <article key={`${release.version}-${section.title}`}>
                      <h3>{section.title}</h3>
                      <ul>
                        {section.items.map((item, index) => (
                          <li key={`${release.version}-${section.title}-${index}`}>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </article>
                  ))}
                  <button
                    type="button"
                    className="release-history-link"
                    onClick={() =>
                      void api.openExternal(
                        `https://github.com/PuppetWen/CDriveShiftAI/releases/tag/v${release.version}`
                      )
                    }
                  >
                    {ui("查看该版本的 GitHub Release", "View this GitHub release")}
                    <ExternalLink size={12} />
                  </button>
                </div>
              </details>
            ))}
          </div>
        </section>
      </section>
      )}

      {activeModule === "appearance" && (
      <div className="settings-appearance-stack settings-module-panel">
      <section className="settings-section glass-card language-settings-card">
        <div className="settings-section-head">
          <div className="settings-icon cyan">
            <Languages size={20} />
          </div>
          <div>
            <h2>{t("settings.languageTitle")}</h2>
            <p>{t("settings.languageDescription")}</p>
          </div>
          <span className="language-count-badge">{t("settings.languageCount")}</span>
        </div>
        <div className="language-settings-body">
          <LanguagePicker value={draft.language} onChange={(language) => void chooseLanguage(language)} />
          <div className="language-settings-notes">
            <span>
              {t("settings.languageSystem", {
                language: languageName(resolvedLanguage("system"), draft.language)
              })}
            </span>
            <span>{t("settings.languageFallback")}</span>
          </div>
        </div>
      </section>
      <section className="settings-section glass-card ui-scale-settings-card">
        <div className="settings-section-head">
          <div className="settings-icon cyan">
            <Eye size={20} />
          </div>
          <div>
            <h2>{ui("字体与界面大小", "Text and interface size")}</h2>
            <p>
              {ui(
                "同步调整文字、按钮、间距和图标；选择后立即生效并自动保存。",
                "Scale text, controls, spacing, and icons together. Changes apply and save immediately."
              )}
            </p>
          </div>
          <span className="ui-scale-value">{Math.round(draft.uiScale * 100)}%</span>
        </div>
        <div className="ui-scale-options">
          {([
            { value: 0.9, zh: "小", en: "Small", sample: "Aa" },
            { value: 1, zh: "标准", en: "Standard", sample: "Aa" },
            { value: 1.1, zh: "大", en: "Large", sample: "Aa" },
            { value: 1.2, zh: "特大", en: "Extra large", sample: "Aa" }
          ] as const).map((option) => (
            <button
              type="button"
              className={draft.uiScale === option.value ? "active" : ""}
              aria-pressed={draft.uiScale === option.value}
              onClick={() => void chooseUiScale(option.value)}
              key={option.value}
            >
              <span style={{ fontSize: `${option.value}em` }}>{option.sample}</span>
              <strong>{ui(option.zh, option.en)}</strong>
              <small>{Math.round(option.value * 100)}%</small>
              <i className="radio-mark" />
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section glass-card">
        <div className="settings-section-head">
          <div className="settings-icon purple">
            <Palette size={20} />
          </div>
          <div>
            <h2>{t("settings.appearanceTitle")}</h2>
            <p>{t("settings.appearanceDescription")}</p>
          </div>
        </div>
        <div className="effect-cards">
          {effectDefinitions.map((effect) => (
            <button
              type="button"
              className={draft.effectMode === effect.id ? "effect-card active" : "effect-card"}
              onClick={() => void chooseEffect(effect.id)}
              key={effect.id}
            >
              <div className={`effect-preview ${effect.id}`}>
                {effect.colors.map((color) => (
                  <i style={{ background: color }} key={color} />
                ))}
                <span />
              </div>
              <div>
                <strong>{t(`effect.${effect.id}.title` as TranslationKey)}</strong>
                <small>{t(`effect.${effect.id}.subtitle` as TranslationKey)}</small>
              </div>
              <span className="radio-mark" />
            </button>
          ))}
        </div>
      </section>
      </div>
      )}

      {activeModule === "system" && (
      <section className="settings-system-stack settings-module-panel">
        <article className="settings-section glass-card index-settings-card">
          <div className="settings-section-head">
            <div className="settings-icon mint">
              <Database size={20} />
            </div>
            <div>
              <h2>{ui("全盘名称索引", "Full-drive name index")}</h2>
              <p>{ui("自研 MFT 快速通道与并行扫描降级。", "First-party MFT fast path with parallel-scan fallback.")}</p>
            </div>
          </div>
          <div className="index-settings-controls">
            <div className="index-settings-status">
              <div>
                <span className={indexer.state === "ready" ? "status-dot online" : "status-dot"} />
                <div>
                  <strong>{indexer.state === "ready" ? ui("索引可用", "Index ready") : ui("索引处理中", "Indexing")}</strong>
                  <small>{runtimeText(indexer.message) || `${formatNumber(indexer.entries)} ${ui("个条目", "entries")}`}</small>
                </div>
              </div>
              <Badge tone={["mft", "cached"].includes(indexer.mode) ? "good" : "warn"}>
                {indexer.mode.toUpperCase()}
              </Badge>
            </div>
            <button className="secondary-button" type="button" disabled={rebuilding} onClick={() => void rebuild()}>
              <RefreshCw size={15} className={rebuilding ? "spin" : ""} />
              {rebuilding ? ui("正在启动刷新…", "Starting refresh…") : ui("重新扫描所有磁盘", "Rescan all drives")}
            </button>
            <div className="setting-note">
              <ShieldCheck size={15} />
              <span>{ui("名称索引仅保存路径与基础元数据；指定目录全文索引独立存储。", "The name index stores only paths and basic metadata; selected-directory content indexes are stored separately.")}</span>
            </div>
          </div>
        </article>

        <article className="settings-section glass-card behavior-settings-card">
          <div className="settings-section-head">
            <div className="settings-icon blue">
              <Laptop size={20} />
            </div>
            <div>
              <h2>{ui("应用行为", "Application behavior")}</h2>
              <p>{ui("控制登录启动与后台行为。", "Control login startup and background behavior.")}</p>
            </div>
          </div>
          <div className="behavior-setting-grid">
          <label className="setting-row">
            <div>
              <strong>{ui("登录时启动", "Launch at login")}</strong>
              <small>{ui("登录 Windows 后准备名称索引", "Prepare the name index after signing in to Windows")}</small>
            </div>
            <input
              type="checkbox"
              checked={draft.launchAtLogin}
              onChange={(event) =>
                void updateBehaviorSetting(
                  "launchAtLogin",
                  event.target.checked
                )
              }
            />
            <span className="toggle" />
          </label>
          <label className={`setting-row ${!draft.launchAtLogin ? "is-disabled" : ""}`}>
            <div>
              <strong>{ui("开机启动后最小化", "Start minimized at login")}</strong>
              <small>{ui("仅在 Windows 登录自动启动时直接进入托盘，不打开主窗口", "When launched automatically at login, go directly to the tray without opening the main window")}</small>
            </div>
            <input
              type="checkbox"
              checked={draft.launchMinimized}
              disabled={!draft.launchAtLogin}
              onChange={(event) =>
                void updateBehaviorSetting(
                  "launchMinimized",
                  event.target.checked
                )
              }
            />
            <span className="toggle" />
          </label>
          <label className="setting-row">
            <div>
              <strong>{ui("关闭时最小化", "Minimize on close")}</strong>
              <small>{ui("保持索引服务在后台可用", "Keep the index service available in the background")}</small>
            </div>
            <input
              type="checkbox"
              checked={draft.minimizeToTray}
              onChange={(event) =>
                void updateBehaviorSetting(
                  "minimizeToTray",
                  event.target.checked
                )
              }
            />
            <span className="toggle" />
          </label>
          </div>
          <div className="shortcut-settings">
            <div className="shortcut-settings-head">
              <Keyboard size={15} />
              <span>
                <strong>{ui("全局快捷键", "Global shortcuts")}</strong>
                <small>{ui("录入后自动检查 Windows 和其他程序是否已占用", "Automatically check whether Windows or another application already uses the shortcut")}</small>
              </span>
            </div>
            <div className="shortcut-recorder-grid">
            <ShortcutRecorder
              label={ui("打开主界面", "Open main window")}
              description={ui("从任意程序唤起 CDriveShiftAI", "Open CDriveShiftAI from any application")}
              target="main"
              value={draft.globalShortcut}
              otherValue={draft.quickSearchShortcut}
              testing={testingShortcut === "main"}
              onChange={(globalShortcut) =>
                setDraft((current) => ({ ...current, globalShortcut }))
              }
              onCommit={(value) => void commitShortcut("main", value)}
              onTest={() => void testShortcut("main")}
            />
            <ShortcutRecorder
              label={ui("独立极速搜索", "Standalone fast search")}
              description={ui("全局组合键唤起完整功能的独立搜索窗口", "Open the full standalone search window with a global shortcut")}
              target="quick-search"
              value={draft.quickSearchShortcut}
              otherValue={draft.globalShortcut}
              testing={testingShortcut === "quick-search"}
              onChange={(quickSearchShortcut) =>
                setDraft((current) => ({ ...current, quickSearchShortcut }))
              }
              onCommit={(value) => void commitShortcut("quick-search", value)}
              onTest={() => void testShortcut("quick-search")}
            />
            </div>
            <article className="mouse-shortcut-card">
              <header>
                <span>
                  <MousePointer2 size={15} />
                  <span>
                    <strong>{ui("鼠标快捷操作", "Mouse shortcut")}</strong>
                    <small>{ui("直接按下鼠标按键进行录入，再用滑块设置长按毫秒数", "Press a mouse button to record it, then use the slider to set the hold time")}</small>
                  </span>
                </span>
                <em
                  className={
                    draft.mouseQuickSearchButton === "disabled"
                      ? "disabled"
                      : mouseShortcutStatus?.available
                        ? "active"
                        : "conflict"
                  }
                >
                  {draft.mouseQuickSearchButton === "disabled"
                    ? ui("已关闭", "Disabled")
                    : mouseShortcutStatus?.available
                      ? ui("监听可用", "Listener available")
                      : ui("监听不可用", "Listener unavailable")}
                </em>
              </header>
              <div className="mouse-shortcut-controls">
                <div className="mouse-button-setting">
                  <span>{ui("触发按键", "Trigger button")}</span>
                  <div className="mouse-button-recorder-row">
                    <button
                      type="button"
                      className={
                        mouseButtonRecording
                          ? "mouse-button-recorder recording"
                          : "mouse-button-recorder"
                      }
                      aria-pressed={mouseButtonRecording}
                      onClick={() => {
                        if (mouseButtonRecording) return;
                        setMouseButtonRecording(true);
                        setMouseRecorderHint(
                          ui("请按下后退侧键、前进侧键或中键…", "Press the back, forward, or middle mouse button…")
                        );
                      }}
                      onMouseDown={captureMouseButton}
                      onMouseUp={(event) => {
                        if (performance.now() < mouseCaptureBlockUntil.current) {
                          event.preventDefault();
                          event.stopPropagation();
                        }
                      }}
                      onAuxClick={(event) => {
                        if (
                          mouseButtonRecording ||
                          performance.now() < mouseCaptureBlockUntil.current
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                        }
                      }}
                      onContextMenu={(event) => {
                        if (mouseButtonRecording) event.preventDefault();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setMouseButtonRecording(false);
                          setMouseRecorderHint(ui("已取消录入", "Recording cancelled"));
                        }
                      }}
                    >
                      <span className="mouse-button-recorder-icon">
                        <MousePointer2 size={16} />
                        <i />
                      </span>
                      <span>
                        <strong>
                          {mouseButtonRecording
                            ? ui("等待按下鼠标按键…", "Waiting for a mouse button…")
                            : mouseButtonLabel(draft.mouseQuickSearchButton)}
                        </strong>
                        <small>
                          {mouseRecorderHint ||
                            ui("点击此处开始录入", "Click here to start recording")}
                        </small>
                      </span>
                      <kbd>{mouseButtonRecording ? "REC" : ui("录入", "Record")}</kbd>
                    </button>
                    <button
                      type="button"
                      className={
                        draft.mouseQuickSearchButton === "disabled"
                          ? "mouse-shortcut-disable active"
                          : "mouse-shortcut-disable"
                      }
                      onClick={() => {
                        setMouseButtonRecording(false);
                        setMouseRecorderHint(ui("鼠标触发已关闭", "Mouse trigger disabled"));
                        void commitMouseShortcut({ mouseQuickSearchButton: "disabled" });
                      }}
                    >
                      {ui("关闭", "Disable")}
                    </button>
                  </div>
                </div>
                <div className="mouse-hold-setting">
                  <div className="mouse-hold-heading">
                    <span>{ui("长按时长", "Hold duration")}</span>
                    <output>
                      <strong>{draft.mouseQuickSearchHoldMs} ms</strong>
                      <small>{(draft.mouseQuickSearchHoldMs / 1_000).toFixed(1)} s</small>
                    </output>
                  </div>
                  <div
                    className="mouse-hold-slider"
                    style={
                      {
                        "--mouse-hold-progress": `${mouseHoldProgress(
                          draft.mouseQuickSearchHoldMs
                        )}%`
                      } as CSSProperties
                    }
                  >
                    <input
                      type="range"
                      min={MOUSE_HOLD_MIN_MS}
                      max={MOUSE_HOLD_MAX_MS}
                      step={MOUSE_HOLD_STEP_MS}
                      value={draft.mouseQuickSearchHoldMs}
                      disabled={draft.mouseQuickSearchButton === "disabled"}
                      aria-label={ui("鼠标长按毫秒数", "Mouse hold duration in milliseconds")}
                      aria-valuetext={`${draft.mouseQuickSearchHoldMs} ms`}
                      onChange={(event) => {
                        const milliseconds = normalizeMouseHoldMs(
                          event.currentTarget.valueAsNumber
                        );
                        setDraft((current) => ({
                          ...current,
                          mouseQuickSearchHoldMs: milliseconds
                        }));
                      }}
                      onPointerUp={(event) =>
                        void commitMouseShortcut({
                          mouseQuickSearchHoldMs: normalizeMouseHoldMs(
                            event.currentTarget.valueAsNumber
                          )
                        })
                      }
                      onKeyUp={(event) =>
                        void commitMouseShortcut({
                          mouseQuickSearchHoldMs: normalizeMouseHoldMs(
                            event.currentTarget.valueAsNumber
                          )
                        })
                      }
                      onBlur={() =>
                        void commitMouseShortcut({
                          mouseQuickSearchHoldMs: draft.mouseQuickSearchHoldMs
                        })
                      }
                    />
                    <div className="mouse-hold-scale" aria-hidden="true">
                      <span>500 ms</span>
                      <span>3 s</span>
                      <span>5 s</span>
                      <span>10 s</span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    testingMouseShortcut ||
                    draft.mouseQuickSearchButton === "disabled" ||
                    !mouseShortcutStatus?.available
                  }
                  onClick={() => void testMouseShortcut()}
                >
                  {testingMouseShortcut ? (
                    <span className="spinner" />
                  ) : (
                    <PlugZap size={13} />
                  )}
                  {ui("测试唤起", "Test trigger")}
                </button>
              </div>
              <footer>
                <span>
                  {mouseShortcutStatus?.available ? (
                    <CheckCircle2 size={12} />
                  ) : (
                    <AlertCircle size={12} />
                  )}
                  {runtimeText(mouseShortcutStatus?.message) ||
                    ui("正在检查 Windows Raw Input 全局监听", "Checking the Windows Raw Input global listener")}
                </span>
                <small>{ui("先点击录入框，再按后退侧键、前进侧键或中键；短按原功能保持不变。", "Click the recorder, then press back, forward, or middle; normal short-click behavior remains unchanged.")}</small>
              </footer>
            </article>
            <p>{ui("点击录入框后直接按下组合键；离开输入框时自动检查、保存并注册。Backspace 或右侧清除按钮可禁用。", "Click a recorder and press the key combination. Leaving the field checks, saves, and registers it automatically. Press Backspace or use the clear button to disable it.")}</p>
          </div>
        </article>
      </section>
      )}

      {activeModule === "ai" && (
      <section className="settings-section glass-card ai-settings settings-module-panel">
        <div className="settings-section-head">
          <div className="settings-icon cyan">
            <Bot size={20} />
          </div>
          <div>
            <h2>{ui("AI 服务与模型", "AI services and models")}</h2>
            <p>{ui("厂商和隐私选项即时保存，URL、Key 与模型在离开输入框后保存；测试成功后自动启用。", "Provider and privacy choices save immediately. URL, key, and model save when focus leaves the field; a successful test enables the service.")}</p>
          </div>
          <label className="ai-master">
            <input
              type="checkbox"
              checked={draft.ai.enabled}
              disabled={testingAi}
              onChange={(event) => void setAiEnabled(event.target.checked)}
            />
            <span className="toggle" />
            {draft.ai.enabled ? ui("已启用", "Enabled") : ui("未启用", "Disabled")}
          </label>
        </div>

        <div className="ai-setup-steps" aria-label={ui("AI 配置流程", "AI setup flow")}>
          {[
            ["1", ui("选择厂商", "Choose provider"), Boolean(draft.ai.provider)],
            ["2", ui("获取模型", "Fetch models"), models.length > 0 || savedConnectionUnchanged],
            ["3", ui("测试对话", "Test conversation"), Boolean(aiTest) || savedConnectionUnchanged],
            ["4", ui("自动保存并启用", "Save and enable"), Boolean(settings.ai.enabled && settings.ai.verifiedAt)]
          ].map(([number, label, complete]) => (
            <div className={complete ? "complete" : ""} key={String(number)}>
              <span>{complete ? <CheckCircle2 size={13} /> : number}</span>
              <strong>{label}</strong>
            </div>
          ))}
        </div>

        <div className="ai-provider-panel">
          <div className="ai-provider-row">
            <div
              className="provider-mark"
              style={{
                color: provider.color,
                borderColor: `color-mix(in srgb, ${provider.color} 38%, transparent)`,
                background: `color-mix(in srgb, ${provider.color} 10%, transparent)`
              }}
            >
              {provider.shortName}
            </div>
            <label className="provider-select">
              <span>
                <Server size={14} /> {ui("大模型厂商", "Model provider")}
              </span>
              <AiProviderPicker
                value={draft.ai.provider}
                onChange={chooseProvider}
              />
              <small>{ui(provider.description, `${provider.name} API service`)}</small>
            </label>
            <div className="protocol-badge">
              <Wifi size={13} />
              {draft.ai.protocol === "openai-compatible"
                ? ui("OpenAI 兼容", "OpenAI compatible")
                : draft.ai.protocol === "anthropic"
                  ? ui("Anthropic 原生", "Native Anthropic")
                  : ui("Gemini 原生", "Native Gemini")}
            </div>
          </div>

          <div className="ai-connection-grid">
            <label className="ai-url-field">
              <span>
                <Server size={14} /> API Base URL
              </span>
              <input
                value={draft.ai.baseUrl}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    ai: { ...current.ai, baseUrl: event.target.value, verifiedAt: undefined }
                  }));
                  setModels([]);
                  invalidateAiTest();
                }}
                onBlur={(event) => {
                  const nextAi = {
                    ...draft.ai,
                    enabled: false,
                    baseUrl: event.currentTarget.value,
                    verifiedAt: undefined
                  };
                  void persistAiDraft(nextAi);
                }}
                placeholder="https://provider.example/v1"
                spellCheck={false}
              />
              <small>{ui("预设地址可以修改，适用于专属域名、代理网关或局域网服务。", "You can change the preset URL for custom domains, proxy gateways, or LAN services.")}</small>
            </label>

            <label className="ai-key-field">
              <span>
                <KeyRound size={14} /> API Key
                {useSavedKey && <em>{ui("正在复用已加密 Key", "Using the encrypted saved key")}</em>}
              </span>
              <div className="secret-input">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    apiKeyDirty.current = true;
                    setModels([]);
                    invalidateAiTest();
                  }}
                  onBlur={() => {
                    if (!apiKeyDirty.current) return;
                    void persistAiDraft(
                      {
                        ...draft.ai,
                        enabled: false,
                        verifiedAt: undefined
                      },
                      { replaceApiKey: true, apiKeyValue: apiKey }
                    );
                  }}
                  placeholder={
                    useSavedKey
                      ? ui("已由 Windows 安全存储加密；留空继续使用", "Encrypted by Windows secure storage; leave blank to keep using it")
                      : provider.requiresKey
                        ? ui("输入该厂商的 API Key", "Enter this provider's API key")
                        : ui("本地服务通常可以留空", "Local services can usually leave this blank")
                  }
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((value) => !value)}
                  aria-label={showApiKey ? ui("隐藏 API Key", "Hide API key") : ui("显示 API Key", "Show API key")}
                >
                  {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <small>{ui("Key 只在主进程请求时使用，保存后由 Windows 安全存储加密。", "The key is used only for requests in the main process and is encrypted by Windows secure storage after saving.")}</small>
            </label>
          </div>

          <div className="ai-model-discovery">
            <div>
              <span>
                <Sparkles size={14} /> {ui("远程模型", "Remote model")}
              </span>
              <strong>
                {models.length > 0
                  ? ui(`已获取 ${models.length} 个可用模型`, `${models.length} models available`)
                  : ui("先连接厂商接口获取可用模型", "Connect to the provider to fetch available models")}
              </strong>
            </div>
            <AiModelPicker
              models={models}
              value={draft.ai.model}
              placeholder={
                models.length > 0
                  ? ui("选择远程模型，或输入模型 ID", "Choose a remote model or enter a model ID")
                  : ui("获取列表失败时可手动输入模型 ID", "Enter a model ID manually if fetching the list fails")
              }
              onChange={(model) => {
                setDraft((current) => ({
                  ...current,
                  ai: { ...current.ai, model, verifiedAt: undefined }
                }));
                invalidateAiTest();
              }}
              onCommit={(model) => {
                const nextAi = {
                  ...draft.ai,
                  enabled: false,
                  model,
                  verifiedAt: undefined
                };
                void persistAiDraft(nextAi);
              }}
            />
            <button
              type="button"
              className="secondary-button"
              disabled={
                fetchingModels ||
                !draft.ai.baseUrl.trim() ||
                (provider.requiresKey && !apiKey.trim() && !useSavedKey)
              }
              onClick={() => void fetchModels()}
            >
              {fetchingModels ? (
                <span className="spinner" />
              ) : (
                <RefreshCw size={14} />
              )}
              {fetchingModels ? ui("正在获取…", "Fetching…") : ui("获取/刷新模型", "Fetch / refresh models")}
            </button>
          </div>

          <div className={`ai-test-result ${aiTest ? "success" : savedConnectionUnchanged ? "saved" : ""}`}>
            <div>
              {aiTest || savedConnectionUnchanged ? (
                <CheckCircle2 size={18} />
              ) : (
                <MessageSquareText size={18} />
              )}
              <span>
                <strong>
                  {aiTest
                    ? ui("测试对话成功", "Test conversation succeeded")
                    : savedConnectionUnchanged
                      ? ui("当前连接此前已验证", "This connection was previously verified")
                      : ui("尚未进行测试对话", "No test conversation has been run")}
                </strong>
                <small>
                  {aiTest
                    ? `${aiTest.model} · ${Math.round(aiTest.latencyMs)} ms · ${aiTest.reply}`
                    : savedConnectionUnchanged
                      ? `${settings.ai.model} · ${settings.ai.verifiedAt ? new Date(settings.ai.verifiedAt).toLocaleString() : ""}`
                      : ui("测试会向所选模型发送一句最小文本，不包含任何磁盘信息。", "The test sends one minimal text prompt to the selected model and includes no disk information.")}
                </small>
              </span>
            </div>
            <button
              type="button"
              className="test-ai-button"
              disabled={
                testingAi ||
                !draft.ai.model ||
                (provider.requiresKey && !apiKey.trim() && !useSavedKey)
              }
              onClick={() => void testAi()}
            >
              {testingAi ? <span className="spinner light" /> : <PlugZap size={15} />}
              {testingAi ? ui("测试并保存中…", "Testing and saving…") : ui("测试并启用", "Test and enable")}
            </button>
          </div>

          {!draft.ai.enabled && (
            <div className="ai-disabled-note">
              <AlertCircle size={14} />
              {ui("远程 AI 当前关闭；本地归属规则仍然正常工作。", "Remote AI is currently disabled; local ownership rules continue to work.")}
            </div>
          )}

          <div className="ai-settings-footer">
            <div className="privacy-choice">
            <span>
              <EyeOff size={14} /> {ui("发送范围", "Data sent")}
            </span>
            <button
              type="button"
              className={draft.ai.privacyMode === "metadata-only" ? "active" : ""}
              onClick={() => choosePrivacyMode("metadata-only")}
            >
              <LockKeyhole size={14} />
              {ui("仅脱敏元数据", "Redacted metadata only")}
            </button>
            <button
              type="button"
              className={draft.ai.privacyMode === "allow-samples" ? "active" : ""}
              onClick={() => choosePrivacyMode("allow-samples")}
            >
              <Cloud size={14} />
              {ui("允许名称样本", "Allow name samples")}
            </button>
            </div>
            <div className={`ai-autosave-status ${aiSaveState}`}>
              {aiSaveState === "saving" ? (
                <RefreshCw className="spin" size={14} />
              ) : aiSaveState === "error" ? (
                <AlertCircle size={14} />
              ) : (
                <CheckCircle2 size={14} />
              )}
              <span>
                {aiSaveState === "saving"
                  ? ui("正在自动保存", "Saving automatically")
                  : aiSaveState === "error"
                    ? ui("自动保存失败", "Autosave failed")
                    : ui("配置自动保存", "Configuration autosaved")}
              </span>
            </div>
          </div>
        </div>
      </section>
      )}
    </div>
  );
}
