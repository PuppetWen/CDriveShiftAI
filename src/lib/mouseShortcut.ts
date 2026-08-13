import type { MouseShortcutButton } from "../types";

export type RecordableMouseShortcutButton = Exclude<
  MouseShortcutButton,
  "disabled"
>;

export const MOUSE_HOLD_MIN_MS = 500;
export const MOUSE_HOLD_MAX_MS = 10_000;
export const MOUSE_HOLD_STEP_MS = 100;

export function mouseShortcutButtonFromEventCode(
  button: number
): RecordableMouseShortcutButton | undefined {
  switch (button) {
    case 1:
      return "middle";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return undefined;
  }
}

export function normalizeMouseHoldMs(value: number): number {
  if (!Number.isFinite(value)) return MOUSE_HOLD_MIN_MS;
  const stepped = Math.round(value / MOUSE_HOLD_STEP_MS) * MOUSE_HOLD_STEP_MS;
  return Math.min(MOUSE_HOLD_MAX_MS, Math.max(MOUSE_HOLD_MIN_MS, stepped));
}

export function mouseHoldProgress(value: number): number {
  const normalized = normalizeMouseHoldMs(value);
  return (
    ((normalized - MOUSE_HOLD_MIN_MS) /
      (MOUSE_HOLD_MAX_MS - MOUSE_HOLD_MIN_MS)) *
    100
  );
}
