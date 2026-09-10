import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle, X } from "lucide-react";
import { ForceDeleteDialog } from "../components/ForceDeleteDialog";
import { Toasts, type ToastItem } from "../components/ui";
import { api } from "../lib/api";
import { effectBackgrounds, isLightEffect } from "../lib/effects";
import { setAppLanguage, useI18n } from "../lib/i18n";
import { applyTextScale } from "../lib/textScale";
import type { AppSettings } from "../types";

// Explorer requests have their own renderer: opening a confirmation never mounts
// the overview/search UI or asks it to load disk data in the background.
export function ForceDeleteWindow() {
  const { ui } = useI18n();
  const [paths, setPaths] = useState<string[]>([]);
  const [result, setResult] = useState<{ path: string; message: string }>();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const completedPath = useRef("");
  const pathsRef = useRef(paths);
  const receiving = useRef(new Set<Promise<void>>());

  const notify = useCallback((type: ToastItem["type"], message: string) => {
    if (type === "success" && completedPath.current) {
      setResult({ path: completedPath.current, message });
      return;
    }
    setToasts((items) => [...items.slice(-2), { id: Date.now(), type, message }]);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.utility = "force-delete";
    let active = true;
    let changed = false;
    const applySettings = (settings: AppSettings) => {
      setAppLanguage(settings.language);
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
    }).catch((reason) => { if (active) notify("error", String(reason)); });
    const offTextScale = api.onTextScalePreview(applyTextScale);
    return () => {
      active = false;
      offSettings();
      offTextScale();
      delete document.documentElement.dataset.utility;
    };
  }, [notify]);

  useEffect(() => {
    const receive = () => {
      const request = api.takeForceDeleteRequests().then((batch) => {
        if (!batch.length) return;
        const next = [...pathsRef.current];
        for (const path of batch) {
          if (!next.some((item) => item.toLowerCase() === path.toLowerCase())) next.push(path);
        }
        pathsRef.current = next;
        setPaths(next);
      }).catch((reason) => notify("error", String(reason)));
      receiving.current.add(request);
      void request.finally(() => receiving.current.delete(request));
    };
    // Subscribe first so cold-start and second-instance requests cannot fall
    // between mounting the renderer and draining the main-process queue.
    const unsubscribe = api.onForceDeleteRequests(receive);
    receive();
    return unsubscribe;
  }, [notify]);

  const finish = useCallback(() => {
    void (async () => {
      // A take request has already removed its batch from Electron's queue.
      // Wait for that batch before deciding this utility is finished.
      while (receiving.current.size > 0) await Promise.all([...receiving.current]);
      if (pathsRef.current.length === 0) await api.finishUtilityWindow();
    })().catch((reason) => notify("error", String(reason)));
  }, [notify]);

  const closeCurrent = useCallback(() => {
    const deleted = Boolean(completedPath.current);
    const next = pathsRef.current.slice(1);
    pathsRef.current = next;
    setPaths(next);
    completedPath.current = "";
    if (!deleted && next.length === 0) finish();
  }, [finish]);

  useEffect(() => {
    if (paths.length > 0) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") finish(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finish, paths.length]);

  return (
    <main className="force-delete-window">
      {paths[0] ? (
        <ForceDeleteDialog
          key={paths[0]}
          path={paths[0]}
          onClose={closeCurrent}
          onDeleted={(path) => { completedPath.current = path; }}
          notify={notify}
        />
      ) : (
        <section className="force-delete-completion" role="dialog" aria-modal="true" aria-labelledby="force-delete-completion-title">
          <header>
            <strong>{ui("强制永久删除", "Force permanent deletion")}</strong>
            <button type="button" onClick={finish} aria-label={ui("关闭", "Close")}><X size={18} /></button>
          </header>
          <div className="force-delete-completion-body" role="status">
            {result ? <CheckCircle2 size={42} /> : <LoaderCircle className="spin" size={32} />}
            <h1 id="force-delete-completion-title">{result ? ui("已永久删除", "Permanently deleted") : ui("正在读取所选项目…", "Loading the selected item…")}</h1>
            {result && <><p>{result.message}</p><code>{result.path}</code></>}
          </div>
          <footer><button type="button" onClick={finish}>{result ? ui("完成", "Done") : ui("取消", "Cancel")}</button></footer>
        </section>
      )}
      <Toasts items={toasts} dismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
    </main>
  );
}
