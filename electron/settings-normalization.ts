export function normalizeStoredUiScale(value: unknown, fallback = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Number(Math.min(3, Math.max(0.5, Math.round(value * 10) / 10)).toFixed(1));
}

export function normalizeStoredMouseHoldMs(value: unknown, fallback = 3_000): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(3_000, Math.max(0, value)) / 100) * 100;
}
