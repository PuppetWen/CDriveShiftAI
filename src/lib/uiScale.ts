export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 3;
export const UI_SCALE_STEP = 0.1;

export function normalizeUiScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const stepped = Math.round(value * 10) / 10;
  return Number(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped)).toFixed(2));
}

export function uiScaleProgress(value: number): number {
  const normalized = normalizeUiScale(value);
  return ((normalized - UI_SCALE_MIN) / (UI_SCALE_MAX - UI_SCALE_MIN)) * 100;
}

export function uiScaleFromLockedDrag(
  startValue: number,
  screenDeltaX: number,
  initialTrackWidth: number
): number {
  if (!Number.isFinite(screenDeltaX) || !Number.isFinite(initialTrackWidth) || initialTrackWidth <= 0) {
    return normalizeUiScale(startValue);
  }
  const range = UI_SCALE_MAX - UI_SCALE_MIN;
  return normalizeUiScale(startValue + (screenDeltaX / initialTrackWidth) * range);
}
