import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from "react";
import { Check, ExternalLink, X } from "lucide-react";
import { api } from "../lib/api";

type OpenPhase = "opening" | "opened" | "error";

interface OpenFeedback {
  path: string;
  phase: OpenPhase;
}

type Notify = (type: "success" | "error", message: string) => void;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("button, a, input, textarea, select, label, [role='button']"))
  );
}

export function usePathOpenFeedback(notify: Notify) {
  const [feedback, setFeedback] = useState<OpenFeedback>();
  const clearTimer = useRef<number | undefined>(undefined);
  const operation = useRef(0);

  useEffect(
    () => () => {
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
    },
    []
  );

  const openPath = useCallback(
    async (targetPath: string) => {
      if (!targetPath.trim()) return;
      const currentOperation = ++operation.current;
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
      setFeedback({ path: targetPath, phase: "opening" });
      try {
        await Promise.all([api.openPath(targetPath), delay(220)]);
        if (operation.current !== currentOperation) return;
        setFeedback({ path: targetPath, phase: "opened" });
      } catch (error) {
        if (operation.current !== currentOperation) return;
        setFeedback({ path: targetPath, phase: "error" });
        notify("error", error instanceof Error ? error.message : String(error));
      }
      clearTimer.current = window.setTimeout(() => {
        if (operation.current === currentOperation) setFeedback(undefined);
      }, 1_050);
    },
    [notify]
  );

  const openFromDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>, targetPath: string) => {
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      void openPath(targetPath);
    },
    [openPath]
  );

  const classNameFor = useCallback(
    (targetPath: string) =>
      feedback?.path === targetPath ? `path-open-${feedback.phase}` : "",
    [feedback]
  );

  return { feedback, openPath, openFromDoubleClick, classNameFor };
}

export function PathOpenFeedback({
  path,
  feedback
}: {
  path: string;
  feedback?: OpenFeedback;
}) {
  if (!feedback || feedback.path !== path) return null;
  const label =
    feedback.phase === "opening"
      ? "正在交给 Windows 打开"
      : feedback.phase === "opened"
        ? "已打开"
        : "打开失败";
  return (
    <span className={`path-open-feedback ${feedback.phase}`} aria-live="polite">
      <i>
        {feedback.phase === "opening" ? (
          <ExternalLink size={13} />
        ) : feedback.phase === "opened" ? (
          <Check size={14} />
        ) : (
          <X size={14} />
        )}
      </i>
      <b>{label}</b>
    </span>
  );
}
