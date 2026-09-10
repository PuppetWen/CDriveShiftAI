import { describe, expect, it } from "vitest";
import type { ForceDeletePreview } from "../types";
import { deleteHelpCategory, forceDeleteGuidance } from "./force-delete-guidance";

const zh = (text: string) => text;
const en = (_zh: string, text: string) => text;
const preview: ForceDeletePreview = {
  verificationId: "one-use-token", path: "E:\\fixture\\locked.txt", name: "locked.txt",
  isDirectory: false, isSymbolicLink: false, highRisk: false, elevated: true, processes: []
};
const lockExplanation = "目标可能被文件句柄占用或访问控制权限拒绝。文件占用查询有范围限制，目录句柄、驱动锁或新启动进程可能未列出；管理员权限也不能解除所有文件锁或受保护进程。请关闭占用程序并检查目标权限后重新预检";

describe("actionable force-delete guidance", () => {
  it.each([
    ["EPERM", "permission"], ["EACCES", "permission"], ["EBUSY", "busy"]
  ])("routes actual %s errors without mistaking protected-process wording for a protected path", (code, category) => {
    const guidance = forceDeleteGuidance(`强制删除失败（${code}）：E:\\fixture\\locked.txt：${lockExplanation}`, preview, zh);
    expect(guidance.category).toBe(category);
    expect(guidance.showTaskManager).toBe(true);
    expect(guidance.showRestartHelp).toBe(true);
    expect(guidance.canRetry).toBe(true);
  });

  it("does not send an already elevated user through UAC again", () => {
    const guidance = forceDeleteGuidance("EPERM", preview, zh);
    expect(guidance.steps.join(" ")).toContain("当前已是管理员");
    expect(guidance.steps.join(" ")).not.toContain("以管理员身份运行");
    expect(guidance.steps.join(" ")).toContain("有效访问权限");
  });

  it("uses the actual error code instead of matching words in the failed path", () => {
    expect(deleteHelpCategory(`强制删除失败（EPERM）：E:\\fixture\\迁移记录\\EBUSY.txt：${lockExplanation}`)).toBe("permission");
    expect(deleteHelpCategory(`强制删除失败（EPERM）：E:\\fixture\\DELETE_ELEVATION_CANCELLED.txt：${lockExplanation}`)).toBe("permission");
    expect(deleteHelpCategory("Error invoking remote method 'force-delete:execute': Error: DELETE_ELEVATION_CANCELLED：已取消管理员权限授权")).toBe("authorization");
  });

  it("explains automatic PowerShell elevation without asking to restart the app", () => {
    const guidance = forceDeleteGuidance("EACCES", { ...preview, elevated: false }, zh);
    expect(guidance.steps.join(" ")).toContain("管理员 PowerShell");
    expect(guidance.steps.join(" ")).toContain("用户账户控制（UAC）");
    expect(guidance.steps.join(" ")).not.toContain("从托盘退出 CDriveShiftAI");
    expect(guidance.steps.join(" ")).toContain("目标及内容");
  });

  it("explains UAC cancellation and requires a new confirmation before another request", () => {
    const guidance = forceDeleteGuidance("DELETE_ELEVATION_CANCELLED: EACCES 管理员授权已取消", preview, zh);
    expect(guidance.category).toBe("authorization");
    expect(guidance.title).toContain("授权已取消");
    expect(guidance.steps.join(" ")).toContain("重新检查");
    expect(guidance.steps.join(" ")).toContain("重新确认");
    expect(guidance.canRetry).toBe(true);
    expect(guidance.showRestartHelp).toBe(false);
    expect(guidance.showTaskManager).toBe(false);
  });

  it("preserves guidance when the administrator command itself fails", () => {
    const guidance = forceDeleteGuidance("DELETE_ELEVATION_FAILED: EACCES PowerShell execution failed", preview, en);
    expect(guidance.category).toBe("elevation");
    expect(guidance.steps.join(" ")).toContain("PowerShell error and exact path");
    expect(guidance.showRestartHelp).toBe(true);
    expect(guidance.showTaskManager).toBe(true);
    expect(guidance.canRetry).toBe(true);
  });

  it("directs continuously recreated contents to stop the writer first", () => {
    const guidance = forceDeleteGuidance("强制删除失败（ENOTEMPTY）：目录仍有文件，可能有后台程序持续写入；请停止写入后重新预检", preview, zh);
    expect(guidance.category).toBe("writing");
    expect(guidance.steps[0]).toContain("同步、下载、备份和自动更新");
    expect(guidance.steps.join(" ")).not.toContain("以管理员身份运行");
  });

  it.each([
    "受保护路径不能强制删除：位于受保护的系统目录",
    "不能强制删除 CDriveShiftAI 当前程序或数据所在目录",
    "受保护路径不能强制删除：不能删除盘符或共享根目录"
  ])("offers uninstall rather than escalating a protected target: %s", (message) => {
    const guidance = forceDeleteGuidance(message, undefined, zh);
    expect(guidance.category).toBe("protected");
    expect(guidance.showUninstall).toBe(true);
    expect(guidance.showTaskManager).toBe(false);
    expect(guidance.showRestartHelp).toBe(false);
    expect(guidance.canRetry).toBe(false);
    expect(guidance.steps.join(" ")).toContain("路径保护");
  });

  it("directs migrated targets to history before deleting them", () => {
    const guidance = forceDeleteGuidance("该路径属于迁移或恢复事务，直接删除或重命名会导致应用不可用：E:\\fixture。请先在迁移历史中恢复。", preview, zh);
    expect(guidance.category).toBe("migration");
    expect(guidance.showTaskManager).toBe(false);
    expect(guidance.steps.join(" ")).toContain("迁移历史");
  });

  it.each(["其他文件操作正在执行，请完成后重试", "该目标或其父子目录正在强制删除，请等待完成后重新预检"])("waits for a concurrent operation without suggesting privilege changes: %s", (message) => {
    const guidance = forceDeleteGuidance(message, preview, zh);
    expect(guidance.category).toBe("operation");
    expect(guidance.showRestartHelp).toBe(false);
    expect(guidance.showTaskManager).toBe(false);
    expect(guidance.steps[0]).toContain("等待");
  });

  it.each([
    "强制删除确认已过期，请重新预检",
    "The deletion preview expired. Check again and confirm the new preview",
    "目标在预检后已被替换或路径发生变化，请重新预检"
  ])("requires a fresh target check for stale confirmation: %s", (message) => {
    const guidance = forceDeleteGuidance(message, preview, en);
    expect(guidance.category).toBe("refresh");
    expect(guidance.showRestartHelp).toBe(false);
    expect(guidance.steps.join(" ")).toContain("Check again");
  });

  it("distinguishes a removed target from permission failures", () => {
    expect(deleteHelpCategory("ENOENT: no such file or directory")).toBe("missing");
    const guidance = forceDeleteGuidance("ENOENT", undefined, en);
    expect(guidance.steps[0]).toContain("refresh search results");
    expect(guidance.showTaskManager).toBe(false);
  });

  it("offers the vendor uninstall route for a protected process or application directory", () => {
    const protectedProcess = { pid: 100, name: "service.exe", matchReason: "file-handle" as const, canTerminate: false };
    expect(forceDeleteGuidance("EBUSY", { ...preview, processes: [protectedProcess] }, zh).showUninstall).toBe(true);
    expect(forceDeleteGuidance("EBUSY", { ...preview, highRisk: true }, zh).showUninstall).toBe(true);
  });

  it("provides readable English steps without untranslated Chinese", () => {
    for (const message of ["EPERM", "EBUSY", "ENOTEMPTY", "ENOENT", "受保护路径不能强制删除", "请先在迁移历史中恢复", "其他文件操作正在执行", "确认已过期", "DELETE_ELEVATION_CANCELLED", "DELETE_ELEVATION_FAILED", "Unexpected failure"]) {
      const guidance = forceDeleteGuidance(message, preview, en);
      expect([guidance.title, ...guidance.steps].join(" ")).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });
});
