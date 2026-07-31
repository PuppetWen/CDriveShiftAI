import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckSquare2,
  CheckCircle2,
  FolderOpen,
  History,
  Link2,
  Redo2,
  RotateCcw,
  Square,
  Trash2
} from "lucide-react";
import { api } from "../lib/api";
import { formatBytes, formatDate } from "../lib/format";
import type { MigrationRecord } from "../types";
import {
  PathOpenFeedback,
  usePathOpenFeedback
} from "../components/PathOpenFeedback";
import { Badge, EmptyState, PageTitle } from "../components/ui";

interface HistoryViewProps {
  records: MigrationRecord[];
  notify: (type: "success" | "error", message: string) => void;
  onRefresh: () => Promise<void>;
}

function stageLabel(stage: MigrationRecord["stage"]): string {
  const labels: Record<MigrationRecord["stage"], string> = {
    preflight: "预检",
    copying: "复制中",
    verifying: "校验中",
    switching: "切换中",
    linked: "运行中",
    "rolling-back": "回滚中",
    "rolled-back": "已回滚",
    failed: "失败"
  };
  return labels[stage];
}

export function HistoryView({ records, notify, onRefresh }: HistoryViewProps) {
  const [rollbackId, setRollbackId] = useState("");
  const [busyId, setBusyId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { feedback, openPath, classNameFor } = usePathOpenFeedback(notify);
  const revealTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (revealTimer.current) window.clearTimeout(revealTimer.current);
    },
    []
  );

  useEffect(() => {
    const currentIds = new Set(
      records
        .filter(
          (record) =>
            ![
              "preflight",
              "copying",
              "verifying",
              "switching",
              "rolling-back"
            ].includes(record.stage)
        )
        .map((record) => record.id)
    );
    setSelected((items) => {
      const next = new Set([...items].filter((id) => currentIds.has(id)));
      return next.size === items.size ? items : next;
    });
  }, [records]);

  const busyStages = new Set<MigrationRecord["stage"]>([
    "preflight",
    "copying",
    "verifying",
    "switching",
    "rolling-back"
  ]);
  const selectableRecords = records.filter(
    (record) => !busyStages.has(record.stage)
  );
  const selectedRecords = records.filter((record) => selected.has(record.id));
  const selectedLinkedCount = selectedRecords.filter(
    (record) => record.stage === "linked"
  ).length;

  const toggleSelected = (id: string) => {
    setConfirmDelete(false);
    setSelected((items) => {
      const next = new Set(items);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      const deleted = await api.deleteMigrations([...selected]);
      setSelected(new Set());
      setConfirmDelete(false);
      await onRefresh();
      notify("success", `已删除 ${deleted} 条迁移记录；磁盘中的文件和链接未被改动`);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  const queueReveal = (targetPath: string) => {
    if (revealTimer.current) window.clearTimeout(revealTimer.current);
    revealTimer.current = window.setTimeout(() => {
      void api.revealPath(targetPath);
      revealTimer.current = undefined;
    }, 230);
  };

  const openInsteadOfReveal = (targetPath: string) => {
    if (revealTimer.current) {
      window.clearTimeout(revealTimer.current);
      revealTimer.current = undefined;
    }
    void openPath(targetPath);
  };

  const rollback = async (record: MigrationRecord) => {
    setBusyId(record.id);
    try {
      await api.rollbackMigration(record.id);
      notify("success", "数据已恢复到原始磁盘，目标磁盘迁移副本已删除");
      setRollbackId("");
      await onRefresh();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId("");
    }
  };

  const reapply = async (record: MigrationRecord) => {
    setBusyId(record.id);
    try {
      const updated = await api.reapplyMigration(record.id);
      notify(
        "success",
        updated.migrationCount > 1
          ? `再次迁移完成，当前已迁移 ${updated.migrationCount} 次`
          : "迁移完成"
      );
      await onRefresh();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="page history-page">
      <PageTitle
        eyebrow="AUDIT TRAIL"
        title="每一次移动，都有迹可循。"
        description="事务记录保留源盘、目标盘、链接类型、空间和状态；数据持久保存在程序旁的 .cdriveshiftai-data/cdriveshiftai-state.json，退出应用不会清空。"
        action={
          <div className="history-toolbar">
            <Badge>{records.length} 条记录</Badge>
            {records.length > 0 && (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={selectableRecords.length === 0 || deleting}
                  onClick={() => {
                    setConfirmDelete(false);
                    setSelected(
                      selected.size === selectableRecords.length
                        ? new Set()
                        : new Set(selectableRecords.map((record) => record.id))
                    );
                  }}
                >
                  {selected.size === selectableRecords.length &&
                  selectableRecords.length > 0 ? (
                    <CheckSquare2 size={14} />
                  ) : (
                    <Square size={14} />
                  )}
                  {selected.size === selectableRecords.length &&
                  selectableRecords.length > 0
                    ? "取消全选"
                    : "多选记录"}
                </button>
                <button
                  type="button"
                  className="secondary-button danger"
                  disabled={selected.size === 0 || deleting}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={14} />
                  删除所选 {selected.size > 0 ? selected.size : ""}
                </button>
              </>
            )}
          </div>
        }
      />

      {confirmDelete && selected.size > 0 && (
        <section className="history-delete-confirm glass-card">
          <AlertTriangle size={19} />
          <div>
            <strong>确认删除 {selected.size} 条迁移记录？</strong>
            <span>
              此操作只删除日志，不会删除、移动或恢复磁盘数据。
              {selectedLinkedCount > 0 &&
                ` 其中 ${selectedLinkedCount} 条仍在使用链接；删除后将无法再通过 CDriveShiftAI 自动恢复。`}
            </span>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={deleting}
            onClick={() => setConfirmDelete(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="primary-button danger"
            disabled={deleting}
            onClick={() => void deleteSelected()}
          >
            {deleting ? <span className="spinner light" /> : <Trash2 size={14} />}
            确认删除记录
          </button>
        </section>
      )}

      {records.length === 0 ? (
        <EmptyState icon={<History size={31} />} title="暂无迁移记录">
          完成第一次安全迁移后，这里会出现完整的事务轨迹。
        </EmptyState>
      ) : (
        <section className="history-list">
          {records.map((record) => (
            <article
              className={`history-card glass-card ${record.stage} ${
                selected.has(record.id) ? "selected" : ""
              }`}
              key={record.id}
            >
              <label
                className="history-select"
                title={
                  busyStages.has(record.stage)
                    ? "正在执行的迁移记录不能删除"
                    : "选择此迁移记录"
                }
              >
                <input
                  type="checkbox"
                  checked={selected.has(record.id)}
                  disabled={busyStages.has(record.stage) || deleting}
                  onChange={() => toggleSelected(record.id)}
                />
                <span>
                  {selected.has(record.id) ? (
                    <CheckSquare2 size={15} />
                  ) : (
                    <Square size={15} />
                  )}
                </span>
              </label>
              <div className="history-status">
                <span>
                  {record.stage === "linked" ? (
                    <Link2 size={18} />
                  ) : record.stage === "failed" ? (
                    <AlertTriangle size={18} />
                  ) : (
                    <CheckCircle2 size={18} />
                  )}
                </span>
                <i />
              </div>
              <div className="history-body">
                <div className="history-head">
                  <div>
                    <strong>{record.source.split(/[\\/]/).at(-1)}</strong>
                    <span>{formatDate(record.startedAt)}</span>
                  </div>
                  <Badge
                    tone={
                      record.stage === "linked"
                        ? "good"
                        : record.stage === "failed"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {stageLabel(record.stage)}
                  </Badge>
                </div>
                <div className="history-route">
                  <button
                    className={`path-openable ${classNameFor(record.source)}`}
                    type="button"
                    title="单击在资源管理器中定位；双击直接打开"
                    onClick={() => queueReveal(record.source)}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openInsteadOfReveal(record.source);
                    }}
                  >
                    <FolderOpen size={14} />
                    <span>{record.source}</span>
                    <PathOpenFeedback path={record.source} feedback={feedback} />
                  </button>
                  <ArrowRight size={15} />
                  <button
                    className={`path-openable ${classNameFor(record.destination)}`}
                    type="button"
                    title="单击在资源管理器中定位；双击直接打开"
                    onClick={() => queueReveal(record.destination)}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openInsteadOfReveal(record.destination);
                    }}
                  >
                    <FolderOpen size={14} />
                    <span>{record.destination}</span>
                    <PathOpenFeedback path={record.destination} feedback={feedback} />
                  </button>
                </div>
                <div className="history-foot">
                  <div>
                    <span>迁移空间</span>
                    <strong>{formatBytes(record.totalBytes)}</strong>
                  </div>
                  <div>
                    <span>链接方式</span>
                    <strong>
                      {record.linkType === "junction"
                        ? "目录联接"
                        : record.linkType === "symbolic-link"
                          ? "符号链接"
                          : "—"}
                    </strong>
                  </div>
                  {record.migrationCount > 1 && (
                    <div>
                      <span>迁移次数</span>
                      <strong>已迁移 {record.migrationCount} 次</strong>
                    </div>
                  )}
                  {record.error && <p className="record-error">{record.error}</p>}
                  {record.stage === "linked" && rollbackId !== record.id && (
                    <button className="secondary-button" type="button" onClick={() => setRollbackId(record.id)}>
                      <RotateCcw size={14} /> 恢复到原位置
                    </button>
                  )}
                  {record.stage === "rolled-back" && (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busyId === record.id}
                      onClick={() => void reapply(record)}
                    >
                      {busyId === record.id ? (
                        <span className="spinner" />
                      ) : (
                        <Redo2 size={14} />
                      )}
                      {busyId === record.id ? "再次迁移中…" : "再次迁移"}
                    </button>
                  )}
                </div>
                {rollbackId === record.id && (
                  <div className="rollback-confirm">
                    <AlertTriangle size={17} />
                    <span>恢复会先复制并校验源目录，确认恢复完整后删除目标磁盘迁移副本。</span>
                    <button type="button" onClick={() => setRollbackId("")}>
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={busyId === record.id}
                      onClick={() => void rollback(record)}
                    >
                      {busyId === record.id ? "回滚中…" : "确认回滚"}
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
