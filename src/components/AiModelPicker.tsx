import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import type { AiModelInfo } from "../types";
import { useI18n } from "../lib/i18n";

interface AiModelPickerProps {
  models: AiModelInfo[];
  value: string;
  disabled?: boolean;
  placeholder: string;
  onChange: (model: string) => void;
  onCommit: (model: string) => void;
}

export function AiModelPicker({
  models,
  value,
  disabled = false,
  placeholder,
  onChange,
  onCommit
}: AiModelPickerProps) {
  const { ui } = useI18n();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const needle = filter.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      models.filter((model) =>
        !needle
          ? true
          : `${model.id} ${model.name} ${model.provider ?? ""}`
              .toLocaleLowerCase()
              .includes(needle)
      ),
    [models, needle]
  );

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", keyboard);
    };
  }, [open]);

  return (
    <div className={open ? "model-picker open" : "model-picker"} ref={rootRef}>
      <input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => {
          setFilter("");
          if (models.length > 0) setOpen(true);
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setFilter(event.target.value);
          if (models.length > 0) setOpen(true);
        }}
        onBlur={(event) => onCommit(event.currentTarget.value)}
      />
      <button
        type="button"
        disabled={disabled || models.length === 0}
        aria-label={ui("展开远程模型列表", "Expand the remote model list")}
        aria-expanded={open}
        onClick={() => {
          setFilter("");
          setOpen((current) => !current);
        }}
      >
        <ChevronDown size={14} />
      </button>

      {open && models.length > 0 && (
        <div className="model-picker-popover" role="listbox" aria-label={ui("远程模型列表", "Remote model list")}>
          <header>
            <span>
              <Cpu size={13} /> {ui("服务端返回的对话模型", "Chat models returned by the provider")}
            </span>
            <small>{filtered.length} / {models.length}</small>
          </header>
          <div>
            {filtered.map((model) => (
              <button
                type="button"
                className={model.id === value ? "model-picker-option active" : "model-picker-option"}
                role="option"
                aria-selected={model.id === value}
                onClick={() => {
                  onChange(model.id);
                  onCommit(model.id);
                  setOpen(false);
                }}
                key={model.id}
              >
                <span>
                  <strong>{model.name}</strong>
                  <small>{model.id}</small>
                </span>
                {model.id === value && <Check size={14} />}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="model-picker-empty">
                {ui("列表中没有匹配项；保留当前文本即可把它作为手动模型 ID 测试。", "No matching item. Keep the current text to test it as a manual model ID.")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
