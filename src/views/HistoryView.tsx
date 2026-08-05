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
import { formatBytes } from "../lib/format";
import { useI18n } from "../lib/i18n";
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

function stageLabel(stage: MigrationRecord["stage"], ui: (zh: string, en: string) => string): string {
  const labels: Record<MigrationRecord["stage"], string> = {
    preflight: ui("预检", "Preflight"),
    copying: ui("复制中", "Copying"),
    verifying: ui("校验中", "Verifying"),
    switching: ui("切换中", "Switching"),
    linked: ui("运行中", "Active"),
    "rolling-back": ui("回滚中", "Restoring"),
    "rolled-back": ui("已回滚", "Restored"),
    failed: ui("失败", "Failed")
  };
  return labels[stage];
}

export function HistoryView({ records, notify, onRefresh }: HistoryViewProps) {
  const { t, ui, formatNumber, formatDate: formatLocaleDate } = useI18n();
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
      notify("success", ui(`已删除 ${deleted} 条迁移记录；磁盘中的文件和链接未被改动`, `Deleted ${deleted} migration records. Files and links on disk were not changed.`));
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
      notify("success", ui("数据已恢复到原始磁盘，目标磁盘迁移副本已删除", "Data was restored to the original drive and the migrated destination copy was removed"));
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
          ? ui(`再次迁移完成，当前已迁移 ${updated.migrationCount} 次`, `Migration completed again; migrated ${updated.migrationCount} times in total`)
          : ui("迁移完成", "Migration complete")
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
        title={t("page.historyTitle")}
        description={t("page.historyDescription")}
        action={
          <div className="history-toolbar">
            <Badge>{formatNumber(records.length)} {ui("条记录", "records")}</Badge>
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
                    ? ui("取消全选", "Clear selection")
                    : ui("多选记录", "Select records")}
                </button>
                <button
                  type="button"
                  className="secondary-button danger"
                  disabled={selected.size === 0 || deleting}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={14} />
                  {ui("删除所选", "Delete selected")} {selected.size > 0 ? formatNumber(selected.size) : ""}
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
            <strong>{ui(`确认删除 ${selected.size} 条迁移记录？`, `Delete ${selected.size} migration records?`)}</strong>
            <span>
              {ui("此操作只删除日志，不会删除、移动或恢复磁盘数据。", "This deletes only the log records; it does not delete, move, or restore disk data.")}
              {selectedLinkedCount > 0 &&
                ui(` 其中 ${selectedLinkedCount} 条仍在使用链接；删除后将无法再通过 CDriveShiftAI 自动恢复。`, ` ${selectedLinkedCount} selected records still use links; after deletion, CDriveShiftAI can no longer restore them automatically.`)}
            </span>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={deleting}
            onClick={() => setConfirmDelete(false)}
          >
            {ui("取消", "Cancel")}
          </button>
          <button
            type="button"
            className="primary-button danger"
            disabled={deleting}
            onClick={() => void deleteSelected()}
          >
            {deleting ? <span className="spinner light" /> : <Trash2 size={14} />}
            {ui("确认删除记录", "Delete records")}
          </button>
        </section>
      )}

      {records.length === 0 ? (
        <EmptyState icon={<History size={31} />} title={ui("暂无迁移记录", "No migration records yet")}>
          {ui("完成第一次安全迁移后，这里会出现完整的事务轨迹。", "The complete transaction trail appears here after your first safe migration.")}
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
                    ? ui("正在执行的迁移记录不能删除", "An active migration record cannot be deleted")
                    : ui("选择此迁移记录", "Select this migration record")
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
                    <span>{formatLocaleDate(record.startedAt)}</span>
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
                    {stageLabel(record.stage, ui)}
                  </Badge>
                </div>
                <div className="history-route">
                  <button
                    className={`path-openable ${classNameFor(record.source)}`}
                    type="button"
                    title={ui("单击在资源管理器中定位；双击直接打开", "Click to reveal in File Explorer; double-click to open")}
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
                    title={ui("单击在资源管理器中定位；双击直接打开", "Click to reveal in File Explorer; double-click to open")}
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
                    <span>{ui("迁移空间", "Migrated space")}</span>
                    <strong>{formatBytes(record.totalBytes)}</strong>
                  </div>
                  <div>
                    <span>{ui("链接方式", "Link type")}</span>
                    <strong>
                      {record.linkType === "junction"
                        ? ui("目录联接", "Directory junction")
                        : record.linkType === "symbolic-link"
                          ? ui("符号链接", "Symbolic link")
                          : "—"}
                    </strong>
                  </div>
                  {record.migrationCount > 1 && (
                    <div>
                      <span>{ui("迁移次数", "Migration count")}</span>
                      <strong>{ui(`已迁移 ${record.migrationCount} 次`, `Migrated ${record.migrationCount} times`)}</strong>
                    </div>
                  )}
                  {record.error && <p className="record-error">{record.error}</p>}
                  {record.stage === "linked" && rollbackId !== record.id && (
                    <button className="secondary-button" type="button" onClick={() => setRollbackId(record.id)}>
                      <RotateCcw size={14} /> {ui("恢复到原位置", "Restore to original location")}
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
                      {busyId === record.id ? ui("再次迁移中…", "Migrating again…") : ui("再次迁移", "Migrate again")}
                    </button>
                  )}
                </div>
                {rollbackId === record.id && (
                  <div className="rollback-confirm">
                    <AlertTriangle size={17} />
                    <span>{ui("恢复会先复制并校验源目录，确认恢复完整后删除目标磁盘迁移副本。", "Restore first copies and verifies the source directory, then removes the migrated destination copy after integrity is confirmed.")}</span>
                    <button type="button" onClick={() => setRollbackId("")}>
                      {ui("取消", "Cancel")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === record.id}
                      onClick={() => void rollback(record)}
                    >
                      {busyId === record.id ? ui("回滚中…", "Restoring…") : ui("确认回滚", "Confirm restore")}
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
