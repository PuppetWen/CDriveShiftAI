import { normalizeUiScale } from "./uiScale";

export function applyTextScale(value: number): number {
  const scale = normalizeUiScale(value);
  document.documentElement.style.setProperty("--text-scale", String(scale));
  return scale;
}
