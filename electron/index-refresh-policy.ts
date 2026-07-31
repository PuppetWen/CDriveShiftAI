export const INDEX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type IndexRefreshReason = "system-restart" | "daily";

export function determineIndexRefreshReason(
  cacheModifiedAtMs: number,
  nowMs: number,
  systemUptimeSeconds: number
): IndexRefreshReason | undefined {
  if (
    !Number.isFinite(cacheModifiedAtMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(systemUptimeSeconds) ||
    cacheModifiedAtMs <= 0 ||
    nowMs <= 0 ||
    systemUptimeSeconds < 0
  ) {
    return undefined;
  }

  if (nowMs - cacheModifiedAtMs >= INDEX_REFRESH_INTERVAL_MS) {
    return "daily";
  }

  const systemStartedAtMs = nowMs - systemUptimeSeconds * 1_000;
  if (cacheModifiedAtMs < systemStartedAtMs) {
    return "system-restart";
  }

  return undefined;
}
