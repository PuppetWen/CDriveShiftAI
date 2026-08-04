import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Cloud,
  Database,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileJson,
  FolderOpen,
  KeyRound,
  Keyboard,
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
import { bundledReleaseNotes } from "../lib/releaseNotes";
import type {
  AiModelInfo,
  AiTestResult,
  AppSettings,
  AppUpdateInfo,
  EffectMode,
  IndexerStatus,
  MouseShortcutButton,
  MouseShortcutStatus,
  ShortcutCheckResult,
  ShortcutTarget
} from "../types";
import { AiProviderPicker } from "../components/AiProviderPicker";
import { AiModelPicker } from "../components/AiModelPicker";
import { Badge, PageTitle } from "../components/ui";

interface SettingsViewProps {
  settings: AppSettings;
  indexer: IndexerStatus;
  updateInfo?: AppUpdateInfo;
  onCheckForUpdates: () => Promise<AppUpdateInfo>;
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
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ShortcutCheckResult>({
    available: false,
    active: false,
    shortcut: value,
    message: "点击输入框并按下组合键"
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
        message: "未启用；录入组合键后会自动检查冲突"
      });
      return;
    }
    if (duplicate) {
      setChecking(false);
      setResult({
        available: false,
        active: false,
        shortcut: value,
        message: "与另一个 CDriveShiftAI 快捷键重复"
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
  }, [duplicate, otherValue, target, value]);

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
            ? "检查中"
            : result.active
              ? "已启用"
              : result.available
                ? "可使用"
                : value
                  ? "有冲突"
                  : "未设置"}
        </em>
      </header>
      <div className={recording ? "shortcut-capture recording" : "shortcut-capture"}>
        <input
          value={keys.join(" + ")}
          readOnly
          aria-label={`${label}快捷键`}
          placeholder={recording ? "请按下组合键…" : "点击这里录入快捷键"}
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
            title="清除并禁用此快捷键"
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
          {result.message}
        </span>
        <button
          type="button"
          className="secondary-button"
          disabled={!result.active || checking || testing}
          onClick={onTest}
        >
          {testing ? <span className="spinner" /> : <PlugZap size={13} />}
          测试唤起
        </button>
      </footer>
    </article>
  );
}

export function SettingsView({
  settings,
  indexer,
  updateInfo,
  onCheckForUpdates,
  onSettings,
  notify
}: SettingsViewProps) {
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
  const [activeReleaseModule, setActiveReleaseModule] = useState<string>();
  const [mouseShortcutStatus, setMouseShortcutStatus] =
    useState<MouseShortcutStatus>();
  const [showApiKey, setShowApiKey] = useState(false);
  const [aiTest, setAiTest] = useState<AiTestResult>();
  const effectRequest = useRef(0);
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
  const releaseSections = updateInfo?.releaseSections?.length
    ? updateInfo.releaseSections
    : bundledNotesMatch
      ? bundledReleaseNotes.sections
      : [];
  const releaseSummary =
    updateInfo?.releaseSummary ??
    (bundledNotesMatch ? bundledReleaseNotes.summary : updateInfo?.releaseName);
  const activeReleaseSection =
    releaseSections.find((section) => section.title === activeReleaseModule) ??
    releaseSections[0];

  useEffect(() => {
    const previous = persistedSettingsRef.current;
    setDraft((current) => {
      const next = { ...current, effectMode: settings.effectMode };
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
          ? "主界面快捷键已自动保存并注册"
          : "独立极速搜索快捷键已自动保存并注册"
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
          ? "主界面快捷键已成功调用"
          : "独立极速搜索测试窗口已打开"
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
    const request = ++mouseShortcutRequest.current;
    const previous = persistedSettingsRef.current;
    setDraft((current) => ({ ...current, ...patch }));
    try {
      const updated = await api.updateSettings(patch);
      if (request !== mouseShortcutRequest.current) return;
      onSettings(updated);
      setDraft((current) => ({
        ...current,
        mouseQuickSearchButton: updated.mouseQuickSearchButton,
        mouseQuickSearchHoldMs: updated.mouseQuickSearchHoldMs
      }));
      setMouseShortcutStatus(await api.getMouseShortcutStatus());
      notify("success", "鼠标快捷操作已自动保存并立即生效");
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

  const testMouseShortcut = async () => {
    setTestingMouseShortcut(true);
    try {
      await api.testMouseShortcut();
      notify("success", "鼠标快捷操作测试成功，独立极速搜索已打开");
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
        `已从 ${provider.name} 获取 ${result.models.length} 个对话模型（${Math.round(result.latencyMs)} ms）`
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
        `测试对话成功并已启用，耗时 ${Math.round(result.latencyMs)} ms`
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
        updated.ai.enabled ? "AI 远程分析已启用" : "AI 远程分析已立即关闭"
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
      notify("success", "全盘名称索引已开始刷新");
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
        title="按你的习惯设置 CDriveShiftAI。"
        description="选择类设置即时生效；输入类设置在焦点离开后自动校验并保存。"
      />

      <section className="settings-section glass-card update-settings">
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
            <h2>应用更新</h2>
            <p>自动续传、SHA-512 双重校验；失败时保留并恢复旧版本。</p>
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
            <small>当前版本</small>
            <strong>v{updateInfo?.currentVersion ?? "0.0.5"}</strong>
          </div>
          <div>
            <small>最新版本</small>
            <strong>
              {updateInfo?.latestVersion ? `v${updateInfo.latestVersion}` : "正在获取…"}
            </strong>
          </div>
          <div className="update-status-message">
            <small>状态</small>
            <strong>
              {updateInfo?.message ?? "打开界面后自动检查，不在后台循环请求"}
            </strong>
            {updateInfo?.publishedAt && (
              <span>
                {updateInfo.distribution === "portable"
                  ? "便携版原路径替换"
                  : updateInfo.distribution === "installed"
                    ? "安装版静默更新"
                    : "开发模式"}{" "}
                · 发布于 {new Date(updateInfo.publishedAt).toLocaleString()}
              </span>
            )}
            {updateInfo?.network && (
              <span className="update-network-route">
                <Wifi size={12} />
                {updateInfo.network.label}
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
              {checkingUpdate ? "检查中…" : "重新检查"}
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
                    ? "续传并重试"
                    : "下载并自动更新"}
                </button>
              )}
            {updateInfo?.phase === "downloading" && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void api.cancelUpdate()}
              >
                <X size={15} />
                暂停下载
              </button>
            )}
            {updateInfo?.releaseUrl && !updateInfo.canAutoUpdate && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void api.openExternal(updateInfo.releaseUrl!)}
              >
                <ExternalLink size={15} />
                {updateInfo.updateAvailable ? "手动下载" : "查看 Release"}
              </button>
            )}
          </div>
        </div>
        {activeReleaseSection && (
          <div className="update-release-notes" aria-label="版本更新内容">
            <div className="update-release-heading">
              <span className="update-release-title">
                <Sparkles size={15} />
                <span>
                  <strong>
                    {updateInfo?.updateAvailable ? "本次更新" : "当前版本说明"}
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
                  完整说明
                  <ExternalLink size={12} />
                </button>
              )}
            </div>
            <div className="update-release-body">
              <div className="update-release-tabs" role="tablist" aria-label="更新模块">
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
                {activeReleaseSection.items.slice(0, 4).map((item, index) => (
                  <span title={item} key={`${activeReleaseSection.title}-${index}`}>
                    <i />
                    {item}
                  </span>
                ))}
                {activeReleaseSection.items.length > 4 && (
                  <span className="update-release-more">
                    另有 {activeReleaseSection.items.length - 4} 项，完整内容见 Release
                  </span>
                )}
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
                    ? "下载更新包"
                    : updateInfo.phase === "verifying"
                      ? "验证更新包"
                      : updateInfo.phase === "ready"
                        ? "准备替换"
                        : updateInfo.phase === "installing"
                          ? "安全更新"
                          : updateInfo.phase === "cancelled"
                            ? "下载已暂停"
                            : "更新未完成"}
                </strong>
                <small>{updateInfo.selectedAsset?.name ?? "CDriveShiftAI 更新包"}</small>
              </span>
              <strong>
                {updateInfo.progress
                  ? `${updateInfo.progress.percent.toFixed(1)}%`
                  : updateInfo.phase === "installing"
                    ? "即将重启"
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
              {["下载", "校验", "备份", "替换", "清理"].map((stage, index) => {
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
                    尝试 {updateInfo.progress.retryAttempt}/
                    {updateInfo.progress.maxRetries}
                  </span>
                </>
              )}
              {updateInfo.phase === "verifying" && (
                <span className="update-verifying">
                  <ShieldCheck size={13} />
                  正在执行 SHA-512 校验
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
            <strong>运行诊断</strong>
            <small>
              {updateInfo?.phase === "error"
                ? "更新失败已写入日志；导出报告发给开发者即可定位环境与权限问题。"
                : "本地记录崩溃、更新和索引生命周期；不会写入 API Key、搜索词或文件正文。"}
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
            打开日志目录
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
                    notify("success", `诊断报告已导出：${result.path ?? "已保存"}`);
                  }
                })
                .catch((error) =>
                  notify("error", error instanceof Error ? error.message : String(error))
                )
                .finally(() => setExportingDiagnostics(false));
            }}
          >
            {exportingDiagnostics ? <span className="spinner" /> : <FileJson size={14} />}
            {exportingDiagnostics ? "正在整理…" : "导出诊断报告"}
          </button>
        </div>
      </section>

      <section className="settings-section glass-card">
        <div className="settings-section-head">
          <div className="settings-icon purple">
            <Palette size={20} />
          </div>
          <div>
            <h2>视觉特效</h2>
            <p>三套完整背景与材质效果，可即时切换。</p>
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
                <strong>{effect.title}</strong>
                <small>{effect.subtitle}</small>
              </div>
              <span className="radio-mark" />
            </button>
          ))}
        </div>
      </section>

      <section className="settings-two-column">
        <article className="settings-section glass-card">
          <div className="settings-section-head">
            <div className="settings-icon mint">
              <Database size={20} />
            </div>
            <div>
              <h2>全盘名称索引</h2>
              <p>自研 MFT 快速通道与并行扫描降级。</p>
            </div>
          </div>
          <div className="index-settings-status">
            <div>
              <span className={indexer.state === "ready" ? "status-dot online" : "status-dot"} />
              <div>
                <strong>{indexer.state === "ready" ? "索引可用" : "索引处理中"}</strong>
                <small>{indexer.message || `${indexer.entries.toLocaleString()} 个条目`}</small>
              </div>
            </div>
            <Badge tone={["mft", "cached"].includes(indexer.mode) ? "good" : "warn"}>
              {indexer.mode.toUpperCase()}
            </Badge>
          </div>
          <button className="secondary-button full" type="button" disabled={rebuilding} onClick={() => void rebuild()}>
            <RefreshCw size={15} className={rebuilding ? "spin" : ""} />
            {rebuilding ? "正在启动刷新…" : "重新扫描所有磁盘"}
          </button>
          <div className="setting-note">
            <ShieldCheck size={15} />
            <span>查询索引仅包含路径与基础元数据；指定目录全文索引与名称索引分开存储。</span>
          </div>
        </article>

        <article className="settings-section glass-card">
          <div className="settings-section-head">
            <div className="settings-icon blue">
              <Laptop size={20} />
            </div>
            <div>
              <h2>应用行为</h2>
              <p>控制登录启动与后台行为。</p>
            </div>
          </div>
          <label className="setting-row">
            <div>
              <strong>登录时启动</strong>
              <small>登录 Windows 后准备名称索引</small>
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
              <strong>开机启动后最小化</strong>
              <small>仅在 Windows 登录自动启动时直接进入托盘，不打开主窗口</small>
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
              <strong>关闭时最小化</strong>
              <small>保持索引服务在后台可用</small>
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
          <div className="shortcut-settings">
            <div className="shortcut-settings-head">
              <Keyboard size={15} />
              <span>
                <strong>全局快捷键</strong>
                <small>录入后自动检查 Windows 和其他程序是否已占用</small>
              </span>
            </div>
            <ShortcutRecorder
              label="打开主界面"
              description="从任意程序唤起 CDriveShiftAI"
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
              label="独立极速搜索"
              description="全局组合键唤起完整功能的独立搜索窗口"
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
            <article className="mouse-shortcut-card">
              <header>
                <span>
                  <MousePointer2 size={15} />
                  <span>
                    <strong>鼠标快捷操作</strong>
                    <small>选择鼠标按键和长按时长，达到阈值后唤起极速搜索</small>
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
                    ? "已关闭"
                    : mouseShortcutStatus?.available
                      ? "监听可用"
                      : "监听不可用"}
                </em>
              </header>
              <div className="mouse-shortcut-controls">
                <label>
                  <span>触发按键</span>
                  <select
                    value={draft.mouseQuickSearchButton}
                    onChange={(event) =>
                      void commitMouseShortcut({
                        mouseQuickSearchButton: event.target
                          .value as MouseShortcutButton
                      })
                    }
                  >
                    <option value="disabled">关闭鼠标触发</option>
                    <option value="back">后退侧键</option>
                    <option value="forward">前进侧键</option>
                    <option value="middle">中键</option>
                  </select>
                </label>
                <label>
                  <span>长按时长</span>
                  <div className="mouse-hold-input">
                    <input
                      type="number"
                      min="0.5"
                      max="10"
                      step="0.5"
                      value={(draft.mouseQuickSearchHoldMs / 1_000).toFixed(1)}
                      disabled={draft.mouseQuickSearchButton === "disabled"}
                      onChange={(event) => {
                        const seconds = event.target.valueAsNumber;
                        if (!Number.isFinite(seconds)) return;
                        setDraft((current) => ({
                          ...current,
                          mouseQuickSearchHoldMs: Math.round(
                            Math.min(10, Math.max(0.5, seconds)) * 1_000
                          )
                        }));
                      }}
                      onBlur={() =>
                        void commitMouseShortcut({
                          mouseQuickSearchHoldMs: draft.mouseQuickSearchHoldMs
                        })
                      }
                    />
                    <span>秒</span>
                  </div>
                </label>
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
                  测试唤起
                </button>
              </div>
              <footer>
                <span>
                  {mouseShortcutStatus?.available ? (
                    <CheckCircle2 size={12} />
                  ) : (
                    <AlertCircle size={12} />
                  )}
                  {mouseShortcutStatus?.message ??
                    "正在检查 Windows Raw Input 全局监听"}
                </span>
                <small>被动监听不会拦截短按，原有前进、后退或中键功能保持不变。</small>
              </footer>
            </article>
            <p>点击录入框后直接按下组合键；离开输入框时自动检查、保存并注册。Backspace 或右侧清除按钮可禁用。</p>
          </div>
        </article>
      </section>

      <section className="settings-section glass-card ai-settings">
        <div className="settings-section-head">
          <div className="settings-icon cyan">
            <Bot size={20} />
          </div>
          <div>
            <h2>AI 服务与模型</h2>
            <p>厂商和隐私选项即时保存，URL、Key 与模型在离开输入框后保存；测试成功后自动启用。</p>
          </div>
          <label className="ai-master">
            <input
              type="checkbox"
              checked={draft.ai.enabled}
              disabled={testingAi}
              onChange={(event) => void setAiEnabled(event.target.checked)}
            />
            <span className="toggle" />
            {draft.ai.enabled ? "已启用" : "未启用"}
          </label>
        </div>

        <div className="ai-setup-steps" aria-label="AI 配置流程">
          {[
            ["1", "选择厂商", Boolean(draft.ai.provider)],
            ["2", "获取模型", models.length > 0 || savedConnectionUnchanged],
            ["3", "测试对话", Boolean(aiTest) || savedConnectionUnchanged],
            ["4", "自动保存并启用", Boolean(settings.ai.enabled && settings.ai.verifiedAt)]
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
                <Server size={14} /> 大模型厂商
              </span>
              <AiProviderPicker
                value={draft.ai.provider}
                onChange={chooseProvider}
              />
              <small>{provider.description}</small>
            </label>
            <div className="protocol-badge">
              <Wifi size={13} />
              {draft.ai.protocol === "openai-compatible"
                ? "OpenAI 兼容"
                : draft.ai.protocol === "anthropic"
                  ? "Anthropic 原生"
                  : "Gemini 原生"}
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
              <small>预设地址可以修改，适用于专属域名、代理网关或局域网服务。</small>
            </label>

            <label className="ai-key-field">
              <span>
                <KeyRound size={14} /> API Key
                {useSavedKey && <em>正在复用已加密 Key</em>}
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
                      ? "已由 Windows 安全存储加密；留空继续使用"
                      : provider.requiresKey
                        ? "输入该厂商的 API Key"
                        : "本地服务通常可以留空"
                  }
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((value) => !value)}
                  aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                >
                  {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <small>Key 只在主进程请求时使用，保存后由 Windows 安全存储加密。</small>
            </label>
          </div>

          <div className="ai-model-discovery">
            <div>
              <span>
                <Sparkles size={14} /> 远程模型
              </span>
              <strong>
                {models.length > 0
                  ? `已获取 ${models.length} 个可用模型`
                  : "先连接厂商接口获取可用模型"}
              </strong>
            </div>
            <AiModelPicker
              models={models}
              value={draft.ai.model}
              placeholder={
                models.length > 0
                  ? "选择远程模型，或输入模型 ID"
                  : "获取列表失败时可手动输入模型 ID"
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
              {fetchingModels ? "正在获取…" : "获取/刷新模型"}
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
                    ? "测试对话成功"
                    : savedConnectionUnchanged
                      ? "当前连接此前已验证"
                      : "尚未进行测试对话"}
                </strong>
                <small>
                  {aiTest
                    ? `${aiTest.model} · ${Math.round(aiTest.latencyMs)} ms · ${aiTest.reply}`
                    : savedConnectionUnchanged
                      ? `${settings.ai.model} · ${settings.ai.verifiedAt ? new Date(settings.ai.verifiedAt).toLocaleString() : ""}`
                      : "测试会向所选模型发送一句最小文本，不包含任何磁盘信息。"}
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
              {testingAi ? "测试并保存中…" : "测试并启用"}
            </button>
          </div>

          {!draft.ai.enabled && (
            <div className="ai-disabled-note">
              <AlertCircle size={14} />
              远程 AI 当前关闭；本地归属规则仍然正常工作。
            </div>
          )}

          <div className="ai-settings-footer">
            <div className="privacy-choice">
            <span>
              <EyeOff size={14} /> 发送范围
            </span>
            <button
              type="button"
              className={draft.ai.privacyMode === "metadata-only" ? "active" : ""}
              onClick={() => choosePrivacyMode("metadata-only")}
            >
              <LockKeyhole size={14} />
              仅脱敏元数据
            </button>
            <button
              type="button"
              className={draft.ai.privacyMode === "allow-samples" ? "active" : ""}
              onClick={() => choosePrivacyMode("allow-samples")}
            >
              <Cloud size={14} />
              允许名称样本
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
                  ? "正在自动保存"
                  : aiSaveState === "error"
                    ? "自动保存失败"
                    : "配置自动保存"}
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
