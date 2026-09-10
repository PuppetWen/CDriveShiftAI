import { describe, expect, it } from "vitest";
import type { AppSettings } from "../types";
import { mergeSettingsDraft } from "./settings-draft";

const settings: AppSettings = {
  effectMode: "aurora", language: "zh-CN", uiScale: 1,
  launchAtLogin: false, launchMinimized: false, minimizeToTray: true,
  forceDeleteContextMenu: false,
  globalShortcut: "", quickSearchShortcut: "", mouseQuickSearchButton: "disabled",
  mouseQuickSearchHoldMs: 3000, magnifierEnabled: false,
  magnifierModifiers: "Ctrl", magnifierWidth: 480, magnifierHeight: 320,
  indexRoots: ["C:\\"], excludedPaths: [],
  ai: {
    enabled: false, provider: "openai", protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1", model: "model-before",
    hasApiKey: false, privacyMode: "metadata-only"
  }
};

describe("settings draft reconciliation", () => {
  it("retains a newer slider value when an earlier save is broadcast", () => {
    const draft = { ...settings, uiScale: 1.8 };
    const saved = { ...settings, uiScale: 1.3, launchAtLogin: true };
    const result = mergeSettingsDraft(draft, settings, saved);
    expect(result.uiScale).toBe(1.8);
    expect(result.launchAtLogin).toBe(true);
    expect(settings.uiScale).toBe(1);
  });

  it("keeps a model typed while an API key save completes", () => {
    const draft = { ...settings, ai: { ...settings.ai, model: "model-new" } };
    const saved = { ...settings, ai: { ...settings.ai, hasApiKey: true } };
    expect(mergeSettingsDraft(draft, settings, saved).ai).toMatchObject({
      model: "model-new", hasApiKey: true, enabled: false
    });
  });

  it("does not apply credentials or connection verification from a previous provider", () => {
    const draft: AppSettings = {
      ...settings,
      ai: { ...settings.ai, provider: "anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com" }
    };
    const saved = { ...settings, ai: { ...settings.ai, hasApiKey: true, enabled: true, verifiedAt: "2026-09-08" } };
    expect(mergeSettingsDraft(draft, settings, saved).ai).toMatchObject({
      provider: "anthropic", hasApiKey: false, enabled: false, verifiedAt: undefined
    });
  });

  it("syncs untouched settings from another window", () => {
    const updated = { ...settings, uiScale: 2, excludedPaths: ["C:\\Cache"], ai: { ...settings.ai, model: "other-model" } };
    expect(mergeSettingsDraft(structuredClone(settings), settings, updated)).toEqual(updated);
  });

  it("accepts an external provider switch when the local connection is untouched", () => {
    const updated: AppSettings = {
      ...settings,
      ai: { ...settings.ai, provider: "anthropic", protocol: "anthropic",
        baseUrl: "https://api.anthropic.com", model: "anthropic-model",
        hasApiKey: true, enabled: true, verifiedAt: "2026-09-08" }
    };
    const draft = { ...settings, uiScale: 1.8, ai: { ...settings.ai, privacyMode: "allow-samples" as const } };
    expect(mergeSettingsDraft(draft, settings, updated)).toEqual({
      ...updated, uiScale: 1.8, ai: { ...updated.ai, privacyMode: "allow-samples" }
    });
  });

  it.each([
    { provider: "deepseek" as const },
    { protocol: "gemini" as const },
    { baseUrl: "https://local-provider.example/v1" },
    { model: "locally-typed-model" }
  ])("keeps the whole dirty connection across an external provider switch: %j", (patch) => {
    const draft = { ...settings, ai: { ...settings.ai, ...patch } };
    const updated: AppSettings = {
      ...settings,
      ai: { ...settings.ai, provider: "anthropic", protocol: "anthropic",
        baseUrl: "https://api.anthropic.com", model: "remote-model", hasApiKey: true,
        enabled: true, verifiedAt: "2026-09-08", privacyMode: "allow-samples" }
    };
    expect(mergeSettingsDraft(draft, settings, updated).ai).toEqual({
      ...draft.ai, enabled: false, verifiedAt: undefined, privacyMode: "allow-samples"
    });
  });

  it("clears a revoked verification timestamp that is absent from the saved response", () => {
    const verified = { ...settings, ai: { ...settings.ai, enabled: true, verifiedAt: "2026-09-08" } };
    expect(mergeSettingsDraft(structuredClone(verified), verified, settings).ai.verifiedAt).toBeUndefined();
  });
});
