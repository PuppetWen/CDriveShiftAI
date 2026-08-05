import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Globe2, Search } from "lucide-react";
import { languageName, languageOptions, resolvedLanguage, useI18n } from "../lib/i18n";
import type { AppLanguage } from "../types";

interface LanguagePickerProps {
  value: AppLanguage;
  disabled?: boolean;
  onChange: (language: AppLanguage) => void;
}

export function LanguagePicker({ value, disabled, onChange }: LanguagePickerProps) {
  const { t, language: displayLanguage } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = languageOptions.find((item) => item.id === value) ?? languageOptions[0];

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return languageOptions;
    return languageOptions.filter((item) =>
      [item.nativeName, item.englishName, item.id, languageName(item.id, displayLanguage)]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized)
    );
  }, [displayLanguage, query]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className={open ? "language-picker open" : "language-picker"} ref={rootRef}>
      <button
        type="button"
        className="language-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="language-picker-code">{selected.shortLabel}</span>
        <span>
          <strong>{value === "system" ? t("settings.languageSystemOption") : selected.nativeName}</strong>
          <small>
            {value === "system"
              ? languageName(resolvedLanguage(value), displayLanguage)
              : selected.englishName === selected.nativeName
                ? selected.id
                : selected.englishName}
          </small>
        </span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="language-picker-popover">
          <label className="language-picker-search">
            <Search size={15} />
            <input
              ref={inputRef}
              value={query}
              placeholder={t("settings.languageSearch")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="language-picker-list" role="listbox" aria-label={t("settings.languageTitle")}>
            {visible.map((item) => (
              <button
                type="button"
                role="option"
                aria-selected={item.id === value}
                className={item.id === value ? "active" : ""}
                key={item.id}
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <span className="language-picker-code">{item.shortLabel}</span>
                <span>
                  <strong>{item.id === "system" ? t("settings.languageSystemOption") : item.nativeName}</strong>
                  <small>
                    {item.id === "system"
                      ? `${item.englishName} · ${languageName(resolvedLanguage(item.id), displayLanguage)}`
                      : item.englishName === item.nativeName
                        ? item.id
                        : item.englishName}
                  </small>
                </span>
                {item.id === value ? <Check size={16} /> : <Globe2 size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
