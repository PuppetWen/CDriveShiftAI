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
import { confidenceLabel, formatBytes } from "../lib/format";
import type { AnalysisResult, DirectoryInsight } from "../types";
import {
  PathOpenFeedback,
  usePathOpenFeedback
} from "../components/PathOpenFeedback";
import { Badge, EmptyState, PageTitle } from "../components/ui";

const categoryLabels: Record<AnalysisResult["category"], string> = {
  application: "应用程序",
  "application-data": "应用数据",
  cache: "缓存/临时数据",
  "user-data": "用户数据",
  development: "开发数据",
  system: "系统组件",
  unknown: "暂未识别"
};

const riskLabels: Record<AnalysisResult["risk"], string> = {
  low: "低风险",
  medium: "中等风险",
  high: "高风险",
  blocked: "禁止迁移"
};

const sourceLabels: Record<AnalysisResult["source"], string> = {
  local: "本机证据",
  "local+ai": "本机 + AI",
  "local+ai+web": "本机 + AI + 网络补证"
};

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

function dateText(value: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function RiskMark({ insight }: { insight: DirectoryInsight }) {
  return (
    <button
      type="button"
      className={`insight-risk-mark ${insight.risk}`}
      title={insight.riskReason}
      aria-label={`迁移风险：${insight.riskReason}`}
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
        notify("error", "请先选择一个目录");
        return;
      }
      setLoading(true);
      try {
        const analysis = await api.analyzeDirectory(pathValue, withAi);
        setResult(analysis);
        if (analysis.aiError) {
          notify("error", `本地分析已保存，但 AI 未完成：${analysis.aiError}`);
        } else {
          notify(
            "success",
            automatic
              ? `已直接完成${withAi ? " AI " : "本地"}详细归属分析并保存`
              : "目录归属分析已完成并保存"
          );
        }
      } catch (error) {
        notify("error", error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [notify]
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
    const selected = await api.chooseDirectory("选择需要识别归属的目录");
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
      notify("success", "当前分析结果和目录输入已清空");
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
        title="这个目录，属于谁？"
        description="先核对注册表、AppX、App Paths 与全盘便携版程序，再结合目录结构、文件特征和 AI；只有低可信结果才进行网络补证。"
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
            placeholder="任意盘符:\需要分析的目录"
            spellCheck={false}
          />
          <button type="button" onClick={() => void choose()}>
            浏览
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
            使用 AI 二次判断
            {!aiEnabled && <small>（未在设置中启用）</small>}
          </label>
          <button
            className="secondary-button clear-analysis-button"
            type="button"
            disabled={!result || loading || clearing}
            onClick={() => void clearCurrentAnalysis()}
          >
            {clearing ? <span className="spinner tiny" /> : <Trash2 size={15} />}
            {clearing ? "正在清空…" : "清空当前结果"}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={loading}
            onClick={() => void runAnalysis(targetPath, useAi && aiEnabled)}
          >
            {loading ? <span className="spinner light" /> : <Sparkles size={17} />}
            {loading ? "正在扫描并核对应用…" : result ? "重新分析并覆盖保存" : "开始分析"}
          </button>
        </div>
      </section>

      {loadingSaved && !result ? (
        <EmptyState icon={<Clock3 size={30} />} title="正在读取上次分析">
          已保存的分析不会因切换页面而消失。
        </EmptyState>
      ) : !result ? (
        <EmptyState icon={<ScanSearch size={31} />} title="选择一个目录开始">
          从磁盘归属地图或搜索结果点击“详细归属分析”会立即执行分析；直接回到本页则优先展示上次保存结果。
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
                <Badge tone="accent">{categoryLabels[result.category]}</Badge>
                <Badge
                  tone={
                    result.risk === "low"
                      ? "good"
                      : result.risk === "medium"
                        ? "warn"
                        : "danger"
                  }
                >
                  {riskLabels[result.risk]}
                </Badge>
                <Badge>可信度 {Math.round(result.confidence * 100)}%</Badge>
                <Badge>{sourceLabels[result.source]}</Badge>
              </div>
              <h2>
                {result.producedBy
                  ? `${result.producedBy} · ${result.purpose}`
                  : result.purpose}
              </h2>
              <p>{result.explanation}</p>
              <div className="analysis-saved-note">
                <Clock3 size={13} />
                已保存于 {dateText(result.snapshot.analyzedAt)}；只有再次点击分析才会覆盖
              </div>
            </div>
            <div className="analysis-size">
              <span>占用空间</span>
              <strong>{formatBytes(result.summary.totalBytes)}</strong>
              <small>{result.summary.fileCount.toLocaleString()} 个文件</small>
            </div>
          </section>

          <section className="analysis-grid">
            <article className="glass-card evidence-card purpose-card">
              <div className="card-heading">
                <div>
                  <span>PURPOSE & ORIGIN</span>
                  <h3>用途、来源与产生方式</h3>
                </div>
                <RiskMark insight={result.insights[0]} />
              </div>
              <dl className="purpose-details">
                <div>
                  <dt>归属应用 / 组件</dt>
                  <dd>{result.producedBy ?? "尚未确定"}</dd>
                </div>
                <div>
                  <dt>目录用途</dt>
                  <dd>{result.purpose}</dd>
                </div>
                <div>
                  <dt>如何产生</dt>
                  <dd>{result.howGenerated}</dd>
                </div>
                <div>
                  <dt>迁移风险</dt>
                  <dd>{result.riskReason}</dd>
                </div>
              </dl>
              {result.insights[0].webSources.length > 0 && (
                <div className="analysis-web-sources">
                  <span>网络补证</span>
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
                  <h3>目录画像</h3>
                </div>
                <HardDrive size={19} />
              </div>
              <div className="stat-pairs">
                <div>
                  <span>文件</span>
                  <strong>{result.summary.fileCount.toLocaleString()}</strong>
                </div>
                <div>
                  <span>子目录</span>
                  <strong>{result.summary.directoryCount.toLocaleString()}</strong>
                </div>
                <div>
                  <span>主要类型</span>
                  <strong>{result.summary.extensionBreakdown[0]?.extension ?? "—"}</strong>
                </div>
                <div>
                  <span>建议</span>
                  <strong>
                    {result.recommendation === "migrate"
                      ? "适合迁移"
                      : result.recommendation === "keep"
                        ? "保留原位"
                        : "人工复核"}
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
                <h3>一级目录用途与归属</h3>
              </div>
              <FileBox size={19} />
            </div>
            {childInsights.length > 0 ? (
              <div className="directory-insight-list">
                <div className="directory-insight-header" role="row">
                  <span>目录 / 归属</span>
                  <span>用途 / 产生方式</span>
                  <span>大小 / 可信度</span>
                  <span>风险</span>
                </div>
                {childInsights.map((insight) => {
                  const bytes = bytesByPath.get(insight.path.toLocaleLowerCase()) ?? 0;
                  return (
                    <div
                      className={`directory-insight-row path-openable ${classNameFor(insight.path)}`}
                      key={insight.path}
                      onDoubleClick={(event) => openFromDoubleClick(event, insight.path)}
                      title="双击使用 Windows 默认方式打开"
                    >
                      <div className="insight-name">
                        <FolderOpen size={17} />
                        <div>
                          <strong>{insight.name}</strong>
                          <span>{insight.producedBy ?? categoryLabels[insight.category]}</span>
                        </div>
                      </div>
                      <div className="insight-purpose">
                        <strong>{insight.purpose}</strong>
                        <span>{insight.howGenerated}</span>
                      </div>
                      <div className="insight-confidence">
                        <span>{formatBytes(bytes)}</span>
                        <strong>{Math.round(insight.confidence * 100)}%</strong>
                        <small>{confidenceLabel(insight.confidence)}</small>
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
                  <strong>没有可展示的一级子目录</strong>
                  <span>当前结果仅包含目标目录本身。</span>
                </div>
              </div>
            )}
          </section>

          <section className="analysis-grid lower">
            <article className="glass-card evidence-card">
              <div className="card-heading">
                <div>
                  <span>APPLICATION EVIDENCE</span>
                  <h3>本机应用归属候选</h3>
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
                        <span>{confidenceLabel(candidate.confidence)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="quiet-empty compact">
                  <Info size={19} />
                  <div>
                    <strong>本机应用资产未匹配</strong>
                    <span>AI 会在该情况下分析目录结构，并对低可信目录尝试网络补证。</span>
                  </div>
                </div>
              )}
            </article>

            <article className="glass-card warnings-card">
              <div className="card-heading">
                <div>
                  <span>BEFORE MOVING</span>
                  <h3>迁移前注意</h3>
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
                    title="双击使用 Windows 默认方式打开"
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
                前往安全迁移 <ArrowRight size={16} />
              </button>
            </article>
          </section>
        </>
      )}
    </div>
  );
}
