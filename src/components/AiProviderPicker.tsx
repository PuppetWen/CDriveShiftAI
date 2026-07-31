import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import {
  aiProviderGroups,
  aiProviderPresets,
  getAiProvider
} from "../lib/aiProviders";
import type { AiProviderId } from "../types";

interface AiProviderPickerProps {
  value: AiProviderId;
  disabled?: boolean;
  onChange: (provider: AiProviderId) => void;
}

export function AiProviderPicker({
  value,
  disabled = false,
  onChange
}: AiProviderPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = getAiProvider(value);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      aiProviderPresets.filter((provider) =>
        !needle
          ? true
          : `${provider.name} ${provider.shortName} ${provider.description} ${provider.group}`
              .toLocaleLowerCase()
              .includes(needle)
      ),
    [needle]
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
    window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", keyboard);
    };
  }, [open]);

  return (
    <div className={open ? "provider-picker open" : "provider-picker"} ref={rootRef}>
      <button
        type="button"
        className="provider-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
      >
        <span>
          <strong>{selected.name}</strong>
          <small>{selected.group}</small>
        </span>
        <ChevronDown size={15} />
      </button>

      {open && (
        <div className="provider-picker-popover" role="listbox" aria-label="选择大模型厂商">
          <label className="provider-picker-search">
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索厂商、平台或本地服务"
              spellCheck={false}
            />
            <kbd>{filtered.length}</kbd>
          </label>
          <div className="provider-picker-list">
            {aiProviderGroups.map((group) => {
              const providers = filtered.filter((provider) => provider.group === group);
              if (providers.length === 0) return null;
              return (
                <section className="provider-picker-group" key={group}>
                  <header>
                    <span>{group}</span>
                    <small>{providers.length}</small>
                  </header>
                  {providers.map((provider) => (
                    <button
                      type="button"
                      className={provider.id === value ? "active" : ""}
                      role="option"
                      aria-selected={provider.id === value}
                      onClick={() => {
                        onChange(provider.id);
                        setOpen(false);
                      }}
                      key={provider.id}
                    >
                      <i
                        style={{
                          color: provider.color,
                          borderColor: `color-mix(in srgb, ${provider.color} 38%, transparent)`,
                          background: `color-mix(in srgb, ${provider.color} 10%, transparent)`
                        }}
                      >
                        {provider.shortName}
                      </i>
                      <span>
                        <strong>{provider.name}</strong>
                        <small>{provider.description}</small>
                      </span>
                      {provider.id === value && <Check size={15} />}
                    </button>
                  ))}
                </section>
              );
            })}
            {filtered.length === 0 && (
              <div className="provider-picker-empty">没有匹配的厂商，可选择“自定义兼容服务”。</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
