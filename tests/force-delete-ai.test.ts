import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { analyzeForceDelete } from "../electron/force-delete-ai";
import type { AppSettings, ForceDeletePreview } from "../electron/types";

const settings = {
  language: "zh-CN",
  ai: { enabled: true, provider: "custom", protocol: "openai-compatible", baseUrl: "https://ai.example.test/v1", model: "fixture-model", hasApiKey: true, privacyMode: "metadata-only" }
} as AppSettings;
const preview: ForceDeletePreview = {
  verificationId: "local-confirmation-token", path: `${os.homedir()}\\Documents\\target`, name: "target",
  isDirectory: true, isSymbolicLink: false, highRisk: false, elevated: false,
  processes: [{ pid: 987, name: "terminal.exe", executablePath: `${os.homedir()}\\terminal.exe`, lockedPath: `${os.homedir()}\\Documents\\target\\locked.txt`, canTerminate: true, matchReason: "file-handle" }]
};

describe("read-only force delete AI diagnosis", () => {
  it("sends only bounded local evidence and redacts the user profile", async () => {
    const complete = vi.fn().mockResolvedValue("检测到 terminal.exe (PID 987) 占用目标。请复核最新名单。");
    const reply = await analyzeForceDelete(preview, `EBUSY: ${preview.path}`, settings, "fixture-secret", complete);
    expect(reply).toContain("PID 987");
    const [connection, request] = complete.mock.calls[0];
    expect(connection.apiKey).toBe("fixture-secret");
    const evidence = JSON.parse(request.user);
    expect(evidence.processes).toEqual([expect.objectContaining({ pid: 987, matchReason: "file-handle", canTerminate: true })]);
    expect(evidence.target).toBe("%USERPROFILE%\\Documents\\target");
    expect(request.user).not.toContain(os.homedir());
    expect(request.user).not.toContain("local-confirmation-token");
    expect(request.user).not.toContain("fixture-secret");
    expect(evidence).not.toHaveProperty("commandLine");
    expect(request.system).toContain("不要生成命令");
    expect(preview.processes[0].canTerminate).toBe(true);
  });

  it("does not contact AI when it is disabled", async () => {
    const complete = vi.fn();
    await expect(analyzeForceDelete(preview, "", { ...settings, ai: { ...settings.ai, enabled: false } }, undefined, complete)).rejects.toThrow("启用并配置");
    expect(complete).not.toHaveBeenCalled();
  });

  it("caps evidence and rejects an empty diagnosis", async () => {
    const complete = vi.fn().mockResolvedValue("   ");
    await expect(analyzeForceDelete({ ...preview, processes: Array(100).fill(preview.processes[0]) }, "x".repeat(10_000), settings, undefined, complete)).rejects.toThrow("未返回");
    const evidence = JSON.parse(complete.mock.calls[0][1].user);
    expect(evidence.processes).toHaveLength(64);
    expect(evidence.omittedProcesses).toBe(36);
    expect(evidence.previousFailure).toHaveLength(2_000);
  });
});
