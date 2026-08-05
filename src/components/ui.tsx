import { AlertCircle, CheckCircle2, X } from "lucide-react";
import type { PropsWithChildren, ReactNode } from "react";
import { useI18n } from "../lib/i18n";

export function PageTitle({
  eyebrow,
  title,
  description,
  action
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="heading-action">{action}</div>}
    </header>
  );
}

export function Badge({
  tone = "neutral",
  children
}: PropsWithChildren<{ tone?: "neutral" | "good" | "warn" | "danger" | "accent" }>) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function EmptyState({
  icon,
  title,
  children,
  action
}: PropsWithChildren<{ icon: ReactNode; title: string; action?: ReactNode }>) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export type ToastItem = {
  id: number;
  type: "success" | "error";
  message: string;
};

export function Toasts({
  items,
  dismiss
}: {
  items: ToastItem[];
  dismiss: (id: number) => void;
}) {
  const { ui } = useI18n();
  return (
    <div className="toast-region" aria-live="polite">
      {items.map((item) => (
        <div className={`toast ${item.type}`} key={item.id}>
          {item.type === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{item.message}</span>
          <button type="button" onClick={() => dismiss(item.id)} aria-label={ui("关闭提示", "Dismiss notification")}>
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton ${className}`} aria-hidden="true" />;
}
