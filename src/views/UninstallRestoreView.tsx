import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  DatabaseBackup,
  HardDrive,
  ShieldCheck
} from "lucide-react";
import { api } from "../lib/api";
import { effectBackgrounds, isLightEffect } from "../lib/effects";
import { formatBytes } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { applyTextScale } from "../lib/textScale";
import type { AppSettings, MigrationRecord } from "../types";

export function UninstallRestoreView() {
  const { ui, formatNumber } = useI18n();
  const [records, setRecords] = useState<MigrationRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [currentPath, setCurrentPath] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const items = await api.listMigrations();
      const restorable = items.filter((item) => item.stage === "linked");
      setRecords(restorable);
      setSelected(new Set(restorable.map((item) => item.id)));
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let changed = false;
    const applySettings = (settings: AppSettings) => {
      applyTextScale(settings.uiScale);
      document.documentElement.dataset.effect = settings.effectMode;
      document.documentElement.style.background = effectBackgrounds[settings.effectMode];
      document.documentElement.style.colorScheme = isLightEffect(settings.effectMode) ? "light" : "dark";
    };
    const offSettings = api.onSettingsChanged((settings) => {
      changed = true;
      applySettings(settings);
    });
    void api.getSettings().then((settings) => {
      if (active && !changed) applySettings(settings);
    }).catch(() => undefined);
    const offTextScale = api.onTextScalePreview(applyTextScale);
    void loadRecords();
    return () => {
      active = false;
      offSettings();
      offTextScale();
    };
  }, [loadRecords]);

  const selectedRecords = useMemo(
    () => records.filter((item) => selected.has(item.id)),
    [records, selected]
  );

  const continueUninstall = () => void api.finishUtilityWindow().catch((reason) =>
    setErrors([reason instanceof Error ? reason.message : String(reason)])
  );
  const restoreSelected = async () => {
    if (selectedRecords.length === 0 || restoring || loading) return;
    setRestoring(true);
    setErrors([]);
    const failed: string[] = [];
    for (const record of selectedRecords) {
      setCurrentPath(record.source);
      try {
        const restored = await api.rollbackMigration(record.id);
        setRecords((items) => items.filter((item) => item.id !== record.id));
        setSelected((items) => new Set([...items].filter((id) => id !== record.id)));
        if (restored.error) failed.push(`${record.source}：${restored.error}`);
      } catch (reason) {
        failed.push(
          `${record.source}：${reason instanceof Error ? reason.message : String(reason)}`
        );
      }
    }
    setCurrentPath("");
    setRestoring(false);
    setErrors(failed);
    if (failed.length === 0) continueUninstall();
  };

  return (
    <main className="uninstall-restore-window">
      <header>
        <div className="uninstall-logo">
          <DatabaseBackup size={25} />
        </div>
        <div>
          <span>UNINSTALL SAFETY</span>
          <h1>{ui("卸载前，是否恢复已迁移的数据？", "Restore migrated data before uninstalling?")}</h1>
          <p>
            {ui("勾选需要恢复的目录。CDriveShiftAI 会先把数据安全复制回原位置，再继续卸载。", "Select the directories to restore. CDriveShiftAI safely copies data back to its original location before continuing the uninstall.")}
          </p>
        </div>
      </header>

      <section className="uninstall-warning">
        <AlertTriangle size={18} />
        <div>
          <strong>{ui("恢复需要源盘有足够可用空间", "Restoring requires enough free space on the source drive")}</strong>
          <span>{ui("请先完全退出关联应用。数据复制回原盘并再次校验成功后，目标磁盘中的迁移副本会被删除。", "Close all related applications first. After the data is copied back and verified, the migrated copy on the destination drive is removed.")}</span>
        </div>
      </section>

      <section className="uninstall-selection">
        <div className="uninstall-selection-head">
          <span>
            <ShieldCheck size={15} />
            {ui("可恢复迁移记录", "Restorable migrations")}
            <small>{formatNumber(records.length)}</small>
          </span>
          {records.length > 0 && (
            <button
              type="button"
              disabled={restoring}
              onClick={() =>
                setSelected(
                  selected.size === records.length
                    ? new Set()
                    : new Set(records.map((item) => item.id))
                )
              }
            >
              {selected.size === records.length ? ui("取消全选", "Clear selection") : ui("全选", "Select all")}
            </button>
          )}
        </div>

        {loading ? (
          <div className="uninstall-empty">
            <span className="spinner" />
            {ui("正在读取项目目录中的迁移记录…", "Loading migration records from the application data directory…")}
          </div>
        ) : loadError ? (
          <div className="uninstall-errors" role="alert">
            <strong>{ui("无法读取迁移记录，尚不能确认是否有数据需要恢复", "Migration records could not be loaded; whether data needs restoring is unknown")}</strong>
            <span>{loadError}</span>
            <button type="button" onClick={() => void loadRecords()}>{ui("重试", "Retry")}</button>
          </div>
        ) : records.length === 0 ? (
          <div className="uninstall-empty">
            <CheckCircle2 size={30} />
            <strong>{ui("没有需要恢复的迁移", "No migrations need to be restored")}</strong>
            <span>{ui("可以直接继续卸载，历史记录不会在应用退出时被自动清空。", "You can continue uninstalling. History is not cleared automatically when the application exits.")}</span>
          </div>
        ) : (
          <div className="uninstall-record-list">
            {records.map((record) => (
              <label className={selected.has(record.id) ? "selected" : ""} key={record.id}>
                <input
                  type="checkbox"
                  checked={selected.has(record.id)}
                  disabled={restoring}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(record.id);
                    else next.delete(record.id);
                    setSelected(next);
                  }}
                />
                <span className="uninstall-check" />
                <HardDrive size={18} />
                <span>
                  <strong>{record.source}</strong>
                  <small>
                    <ArrowLeftRight size={11} />
                    {record.destination}
                  </small>
                </span>
                <b>{formatBytes(record.totalBytes)}</b>
              </label>
            ))}
          </div>
        )}
      </section>

      {restoring && (
        <div className="uninstall-progress">
          <span className="spinner" />
          <div>
            <strong>{ui("正在恢复所选目录", "Restoring selected directories")}</strong>
            <span>{currentPath}</span>
          </div>
        </div>
      )}
      {errors.length > 0 && (
        <div className="uninstall-errors">
          <strong>{ui("部分恢复或清理未完成，请检查后重试或选择保留现状：", "Some restoration or cleanup steps did not finish. Review the errors and retry, or keep the current state:")}</strong>
          {errors.map((error) => <span key={error}>{error}</span>)}
        </div>
      )}

      <footer>
        <button
          type="button"
          className="secondary-button"
          disabled={restoring || loading}
          onClick={continueUninstall}
        >
          {ui("保留现状并继续卸载", "Keep current state and continue uninstalling")}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={restoring || loading || Boolean(loadError) || selectedRecords.length === 0}
          onClick={() => void restoreSelected()}
        >
          <DatabaseBackup size={16} />
          {ui("恢复所选", "Restore selected")} {selectedRecords.length > 0 ? `(${formatNumber(selectedRecords.length)})` : ""} {ui("并继续卸载", "and continue uninstalling")}
        </button>
      </footer>
    </main>
  );
}
