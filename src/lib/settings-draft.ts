import type { AppSettings } from "../types";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Apply persisted changes without discarding edits made while a save was pending. */
export function mergeSettingsDraft(
  draft: AppSettings,
  previous: AppSettings,
  updated: AppSettings
): AppSettings {
  const merge = <T extends object>(local: T, before: T, remote: T): T => {
    const result = { ...local };
    for (const key of Object.keys({ ...before, ...remote }) as (keyof T)[]) {
      if (same(local[key], before[key])) result[key] = remote[key];
    }
    return result;
  };
  const connectionFields = ["provider", "protocol", "baseUrl", "model"] as const;
  const localConnectionDirty = connectionFields.some((field) => draft.ai[field] !== previous.ai[field]);
  const providerConflict = updated.ai.provider !== previous.ai.provider || updated.ai.provider !== draft.ai.provider;
  const mergedAi = merge(draft.ai, previous.ai, updated.ai);
  // A provider transition changes the meaning of its URL, model and saved key.
  // Accept it when untouched locally; preserve the complete local connection
  // when edits are pending instead of combining fields from two providers.
  const ai = localConnectionDirty && providerConflict
    ? { ...draft.ai, privacyMode: mergedAi.privacyMode }
    : mergedAi;
  if (connectionFields.some((field) => ai[field] !== updated.ai[field])) {
    ai.enabled = false;
    ai.verifiedAt = undefined;
  }
  return {
    ...merge(draft, previous, updated),
    ai
  };
}
