import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Boxes,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileBox,
  FolderOpen,
  HardDrive,
  Info,
  ScanSearch,
  ShieldAlert,
  Sparkles,
  Trash2
} from "lucide-react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { AnalysisResult, DirectoryInsight } from "../types";
import {
  PathOpenFeedback,
  usePathOpenFeedback
} from "../components/PathOpenFeedback";
import { Badge, EmptyState, PageTitle } from "../components/ui";

type UiText = (zh: string, en: string) => string;

function categoryLabel(category: AnalysisResult["category"], ui: UiText): string {
  return {
    application: ui("应用程序", "Application"),
    "application-data": ui("应用数据", "Application data"),
    cache: ui("缓存/临时数据", "Cache / temporary data"),
    "user-data": ui("用户数据", "User data"),
    development: ui("开发数据", "Development data"),
    system: ui("系统组件", "System component"),
    unknown: ui("暂未识别", "Unidentified")
  }[category];
}

function riskLabel(risk: AnalysisResult["risk"], ui: UiText): string {
  return {
    low: ui("低风险", "Low risk"),
    medium: ui("中等风险", "Medium risk"),
    high: ui("高风险", "High risk"),
    blocked: ui("禁止迁移", "Migration blocked")
  }[risk];
}

function sourceLabel(source: AnalysisResult["source"], ui: UiText): string {
  return {
    local: ui("本机证据", "Local evidence"),
    "local+ai": ui("本机 + AI", "Local + AI"),
    "local+ai+web": ui("本机 + AI + 网络补证", "Local + AI + web evidence")
  }[source];
}

function confidenceText(value: number, ui: UiText): string {
  if (value >= 0.82) return ui("高可信", "High confidence");
  if (value >= 0.58) return ui("较可信", "Moderate confidence");
  return ui("待确认", "Needs confirmation");
}

interface AnalyzeViewProps {
  initialPath: string;
  aiEnabled: boolean;
  autoAnalyzeToken: number;
  autoAnalyzePending: boolean;
  onAutoAnalyzeHandled: () => void;
  onPathChange: (path: string) => void;
  onMigrate: (path: string) => void;
  notify: (type: "success" | "error", message: string) => void;
}

function RiskMark({ insight }: { insight: DirectoryInsight }) {
  const { ui } = useI18n();
  return (
    <button
      type="button"
      className={`insight-risk-mark ${insight.risk}`}
      title={insight.riskReason}
      aria-label={`${ui("迁移风险", "Migration risk")}: ${insight.riskReason}`}
    >
      <AlertTriangle size={14} />
    </button>
  );
}

export function AnalyzeView({
  initialPath,
  aiEnabled,
  autoAnalyzeToken,
  autoAnalyzePending,
  onAutoAnalyzeHandled,
  onPathChange,
  onMigrate,
  notify
}: AnalyzeViewProps) {
  const { t, ui, formatNumber, formatDate } = useI18n();
  const [targetPath, setTargetPath] = useState(initialPath);
  const [useAi, setUseAi] = useState(aiEnabled);
  const [result, setResult] = useState<AnalysisResult>();
  const [loading, setLoading] = useState(false);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [clearing, setClearing] = useState(false);
  const autoRunningToken = useRef(-1);
  const { feedback, openFromDoubleClick, classNameFor } = usePathOpenFeedback(notify);

  const runAnalysis = useCallback(
    async (pathValue: string, withAi: boolean, automatic = false) => {
      if (!pathValue.trim()) {
        notify("error", ui("请先选择一个目录", "Choose a directory first"));
        return;
      }
      setLoading(true);
      try {
        const analysis = await api.analyzeDirectory(pathValue, withAi);
        setResult(analysis);
        if (analysis.aiError) {
          notify("error", `${ui("本地分析已保存，但 AI 未完成", "The local analysis was saved, but AI analysis did not finish")}: ${analysis.aiError}`);
        } else {
          notify(
            "success",
            automatic
              ? ui(
                  `已直接完成${withAi ? " AI " : "本地"}详细归属分析并保存`,
                  `The detailed ${withAi ? "AI-assisted" : "local"} ownership analysis was completed and saved`
                )
              : ui("目录归属分析已完成并保存", "Directory ownership analysis completed and saved")
          );
        }
      } catch (error) {
        notify("error", error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [notify, ui]
  );

  const loadSaved = useCallback(async (pathValue: string) => {
    if (!pathValue.trim()) {
      setResult(undefined);
      return;
    }
    setLoadingSaved(true);
    try {
      setResult(await api.getSavedAnalysis(pathValue));
    } catch {
      setResult(undefined);
    } finally {
      setLoadingSaved(false);
    }
  }, []);

  useEffect(() => {
    if (!initialPath) return;
    setTargetPath(initialPath);
    setUseAi(aiEnabled);
    if (autoAnalyzePending) {
      autoRunningToken.current = autoAnalyzeToken;
      onAutoAnalyzeHandled();
      void runAnalysis(initialPath, aiEnabled, true).finally(() => {
        if (autoRunningToken.current === autoAnalyzeToken) {
          autoRunningToken.current = -1;
        }
      });
    } else if (autoRunningToken.current === autoAnalyzeToken) {
      return;
    } else {
      void loadSaved(initialPath);
    }
  }, [
    aiEnabled,
    autoAnalyzePending,
    autoAnalyzeToken,
    initialPath,
    loadSaved,
    onAutoAnalyzeHandled,
    runAnalysis
  ]);

  const choose = async () => {
    const selected = await api.chooseDirectory(ui("选择需要识别归属的目录", "Choose a directory to analyze"));
    if (!selected) return;
    setTargetPath(selected);
    onPathChange(selected);
    await loadSaved(selected);
  };

  const clearCurrentAnalysis = async () => {
    if (!result) return;
    setClearing(true);
    try {
      await api.deleteSavedAnalysis(result.summary.path);
      setResult(undefined);
      setTargetPath("");
      onPathChange("");
      notify("success", ui("当前分析结果和目录输入已清空", "The current analysis and directory input were cleared"));
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setClearing(false);
    }
  };

  const childInsights = useMemo(
    () => result?.insights.slice(1) ?? [],
    [result]
  );
  const bytesByPath = useMemo(
    () =>
      new Map(
        result?.summary.largestChildren.map((item) => [
          item.path.toLocaleLowerCase(),
          item.bytes
        ]) ?? []
      ),
    [result]
  );
  const topBytes = result?.summary.largestChildren[0]?.bytes || 1;

  return (
    <div className="page analyze-page">
      <PageTitle
        eyebrow="OWNERSHIP ANALYSIS"
        title={t("page.analyzeTitle")}
        description={t("page.analyzeDescription")}
      />

      <section className="analyze-input-card glass-card">
        <div className="path-input large">
          <FolderOpen size={19} />
          <input
            value={targetPath}
            onChange={(event) => {
              setTargetPath(event.target.value);
              setResult(undefined);
            }}
            onBlur={() => {
              onPathChange(targetPath);
              void loadSaved(targetPath);
            }}
            placeholder={ui("任意盘符:\\需要分析的目录", "Any drive:\\directory to analyze")}
            spellCheck={false}
          />
          <button type="button" onClick={() => void choose()}>
            {ui("浏览", "Browse")}
          </button>
        </div>
        <div className="analyze-options">
          <label className={aiEnabled ? "" : "disabled-control"}>
            <input
              type="checkbox"
              checked={useAi && aiEnabled}
              disabled={!aiEnabled}
              onChange={(event) => setUseAi(event.target.checked)}
            />
            <span className="toggle" />
            <Bot size={15} />
            {ui("使用 AI 二次判断", "Use AI as a second opinion")}
            {!aiEnabled && <small>{ui("（未在设置中启用）", "(not enabled in Settings)")}</small>}
          </label>
          <button
            className="secondary-button clear-analysis-button"
            type="button"
            disabled={!result || loading || clearing}
            onClick={() => void clearCurrentAnalysis()}
          >
            {clearing ? <span className="spinner tiny" /> : <Trash2 size={15} />}
            {clearing ? ui("正在清空…", "Clearing…") : ui("清空当前结果", "Clear current result")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={loading}
            onClick={() => void runAnalysis(targetPath, useAi && aiEnabled)}
          >
            {loading ? <span className="spinner light" /> : <Sparkles size={17} />}
            {loading
              ? ui("正在扫描并核对应用…", "Scanning and matching applications…")
              : result
                ? ui("重新分析并覆盖保存", "Analyze again and replace saved result")
                : ui("开始分析", "Start analysis")}
          </button>
        </div>
      </section>

      {loadingSaved && !result ? (
        <EmptyState icon={<Clock3 size={30} />} title={ui("正在读取上次分析", "Loading the previous analysis")}>
          {ui("已保存的分析不会因切换页面而消失。", "Saved analyses remain available when you switch pages.")}
        </EmptyState>
      ) : !result ? (
        <EmptyState icon={<ScanSearch size={31} />} title={ui("选择一个目录开始", "Choose a directory to begin")}>
          {ui(
            "从磁盘归属地图或搜索结果点击“详细归属分析”会立即执行分析；直接回到本页则优先展示上次保存结果。",
            "Open detailed ownership analysis from the disk map or search results to analyze immediately. Returning here shows the most recently saved result first."
          )}
        </EmptyState>
      ) : (
        <>
          <section className="analysis-hero glass-card">
            <div className={`risk-beacon ${result.risk}`}>
              {result.risk === "blocked" || result.risk === "high" ? (
                <ShieldAlert size={30} />
              ) : (
                <CheckCircle2 size={30} />
              )}
              <span />
            </div>
            <div className="analysis-verdict">
              <div className="analysis-badges">
                <Badge tone="accent">{categoryLabel(result.category, ui)}</Badge>
                <Badge
                  tone={
                    result.risk === "low"
                      ? "good"
                      : result.risk === "medium"
                        ? "warn"
                        : "danger"
                  }
                >
                  {riskLabel(result.risk, ui)}
                </Badge>
                <Badge>{ui("可信度", "Confidence")} {Math.round(result.confidence * 100)}%</Badge>
                <Badge>{sourceLabel(result.source, ui)}</Badge>
              </div>
              <h2>
                {result.producedBy
                  ? `${result.producedBy} · ${result.purpose}`
                  : result.purpose}
              </h2>
              <p>{result.explanation}</p>
              <div className="analysis-saved-note">
                <Clock3 size={13} />
                {ui("已保存于", "Saved at")} {formatDate(result.snapshot.analyzedAt)}; {ui("只有再次点击分析才会覆盖", "it is replaced only when you run analysis again")}
              </div>
            </div>
            <div className="analysis-size">
              <span>{ui("占用空间", "Space used")}</span>
              <strong>{formatBytes(result.summary.totalBytes)}</strong>
              <small>{formatNumber(result.summary.fileCount)} {ui("个文件", "files")}</small>
            </div>
          </section>

          <section className="analysis-grid">
            <article className="glass-card evidence-card purpose-card">
              <div className="card-heading">
                <div>
                  <span>PURPOSE & ORIGIN</span>
                  <h3>{ui("用途、来源与产生方式", "Purpose, origin, and creation")}</h3>
                </div>
                <RiskMark insight={result.insights[0]} />
              </div>
              <dl className="purpose-details">
                <div>
                  <dt>{ui("归属应用 / 组件", "Owning application / component")}</dt>
                  <dd>{result.producedBy ?? ui("尚未确定", "Not determined")}</dd>
                </div>
                <div>
                  <dt>{ui("目录用途", "Directory purpose")}</dt>
                  <dd>{result.purpose}</dd>
                </div>
                <div>
                  <dt>{ui("如何产生", "How it was created")}</dt>
                  <dd>{result.howGenerated}</dd>
                </div>
                <div>
                  <dt>{ui("迁移风险", "Migration risk")}</dt>
                  <dd>{result.riskReason}</dd>
                </div>
              </dl>
              {result.insights[0].webSources.length > 0 && (
                <div className="analysis-web-sources">
                  <span>{ui("网络补证", "Web evidence")}</span>
                  {result.insights[0].webSources.map((source) => (
                    <button
                      type="button"
                      key={source.url}
                      onClick={() => void api.openExternal(source.url)}
                      title={source.url}
                    >
                      {source.title} <ExternalLink size={12} />
                    </button>
                  ))}
                </div>
              )}
            </article>

            <article className="glass-card stats-card">
              <div className="card-heading">
                <div>
                  <span>PROFILE</span>
                  <h3>{ui("目录画像", "Directory profile")}</h3>
                </div>
                <HardDrive size={19} />
              </div>
              <div className="stat-pairs">
                <div>
                  <span>{ui("文件", "Files")}</span>
                  <strong>{formatNumber(result.summary.fileCount)}</strong>
                </div>
                <div>
                  <span>{ui("子目录", "Subdirectories")}</span>
                  <strong>{formatNumber(result.summary.directoryCount)}</strong>
                </div>
                <div>
                  <span>{ui("主要类型", "Primary type")}</span>
                  <strong>{result.summary.extensionBreakdown[0]?.extension ?? "—"}</strong>
                </div>
                <div>
                  <span>{ui("建议", "Recommendation")}</span>
                  <strong>
                    {result.recommendation === "migrate"
                      ? ui("适合迁移", "Suitable for migration")
                      : result.recommendation === "keep"
                        ? ui("保留原位", "Keep in place")
                        : ui("人工复核", "Manual review")}
                  </strong>
                </div>
              </div>
              <div className="extension-chips">
                {result.summary.extensionBreakdown.slice(0, 8).map((item) => (
                  <span key={item.extension}>
                    {item.extension} <b>{formatBytes(item.bytes)}</b>
                  </span>
                ))}
              </div>
            </article>
          </section>

          <section className="glass-card directory-insights-card">
            <div className="card-heading">
              <div>
                <span>DIRECTORY BREAKDOWN</span>
                <h3>{ui("一级目录用途与归属", "Top-level directory purpose and ownership")}</h3>
              </div>
              <FileBox size={19} />
            </div>
            {childInsights.length > 0 ? (
              <div className="directory-insight-list">
                <div className="directory-insight-header" role="row">
                  <span>{ui("目录 / 归属", "Directory / owner")}</span>
                  <span>{ui("用途 / 产生方式", "Purpose / creation")}</span>
                  <span>{ui("大小 / 可信度", "Size / confidence")}</span>
                  <span>{ui("风险", "Risk")}</span>
                </div>
                {childInsights.map((insight) => {
                  const bytes = bytesByPath.get(insight.path.toLocaleLowerCase()) ?? 0;
                  return (
                    <div
                      className={`directory-insight-row path-openable ${classNameFor(insight.path)}`}
                      key={insight.path}
                      onDoubleClick={(event) => openFromDoubleClick(event, insight.path)}
                      title={ui("双击使用 Windows 默认方式打开", "Double-click to open with the Windows default app")}
                    >
                      <div className="insight-name">
                        <FolderOpen size={17} />
                        <div>
                          <strong>{insight.name}</strong>
                          <span>{insight.producedBy ?? categoryLabel(insight.category, ui)}</span>
                        </div>
                      </div>
                      <div className="insight-purpose">
                        <strong>{insight.purpose}</strong>
                        <span>{insight.howGenerated}</span>
                      </div>
                      <div className="insight-confidence">
                        <span>{formatBytes(bytes)}</span>
                        <strong>{Math.round(insight.confidence * 100)}%</strong>
                        <small>{confidenceText(insight.confidence, ui)}</small>
                      </div>
                      <RiskMark insight={insight} />
                      <PathOpenFeedback path={insight.path} feedback={feedback} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="quiet-empty compact">
                <Info size={19} />
                <div>
                  <strong>{ui("没有可展示的一级子目录", "No top-level subdirectories to show")}</strong>
                  <span>{ui("当前结果仅包含目标目录本身。", "This result contains only the target directory itself.")}</span>
                </div>
              </div>
            )}
          </section>

          <section className="analysis-grid lower">
            <article className="glass-card evidence-card">
              <div className="card-heading">
                <div>
                  <span>APPLICATION EVIDENCE</span>
                  <h3>{ui("本机应用归属候选", "Local application ownership candidates")}</h3>
                </div>
                <Boxes size={19} />
              </div>
              {result.candidates.length ? (
                <div className="candidate-list">
                  {result.candidates.map((candidate, index) => (
                    <div className="candidate" key={`${candidate.appName}-${index}`}>
                      <div className="candidate-rank">{index + 1}</div>
                      <div className="candidate-main">
                        <strong>{candidate.appName}</strong>
                        <span>{candidate.publisher ?? candidate.reason}</span>
                        <p>{candidate.evidence.join(" · ")}</p>
                      </div>
                      <div className="confidence">
                        <strong>{Math.round(candidate.confidence * 100)}%</strong>
                        <span>{confidenceText(candidate.confidence, ui)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="quiet-empty compact">
                  <Info size={19} />
                  <div>
                    <strong>{ui("本机应用资产未匹配", "No local application asset matched")}</strong>
                    <span>{ui("AI 会在该情况下分析目录结构，并对低可信目录尝试网络补证。", "AI analyzes the directory structure in this case and may use web evidence for low-confidence directories.")}</span>
                  </div>
                </div>
              )}
            </article>

            <article className="glass-card warnings-card">
              <div className="card-heading">
                <div>
                  <span>BEFORE MOVING</span>
                  <h3>{ui("迁移前注意", "Before migration")}</h3>
                </div>
                <AlertTriangle size={19} />
              </div>
              <ul>
                {result.warnings.map((warning) => (
                  <li key={warning}>
                    <AlertTriangle size={15} />
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
              <div className="mini-distribution">
                {result.summary.largestChildren.slice(0, 5).map((item) => (
                  <div
                    className={`path-openable mini-path-row ${classNameFor(item.path)}`}
                    key={item.path}
                    onDoubleClick={(event) => openFromDoubleClick(event, item.path)}
                    title={ui("双击使用 Windows 默认方式打开", "Double-click to open with the Windows default app")}
                  >
                    <span>{item.path.split(/[\\/]/).at(-1)}</span>
                    <i>
                      <b
                        style={{
                          width: `${Math.max(2, (item.bytes / topBytes) * 100)}%`
                        }}
                      />
                    </i>
                    <strong>{formatBytes(item.bytes)}</strong>
                    <PathOpenFeedback path={item.path} feedback={feedback} />
                  </div>
                ))}
              </div>
              <button
                className="primary-button full"
                type="button"
                disabled={result.risk === "blocked"}
                onClick={() => onMigrate(result.summary.path)}
              >
                {ui("前往安全迁移", "Continue to safe migration")} <ArrowRight size={16} />
              </button>
            </article>
          </section>
        </>
      )}
    </div>
  );
}
