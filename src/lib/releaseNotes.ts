import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  "version": "0.2.1",
  "summary": "修复自动更新助手的工作目录占用和临时目录继承，安装后等待新版窗口真正打开再确认更新成功。",
  "sections": [
    {
      "title": "自动安装与重新打开",
      "items": [
        "更新助手从安装目录外启动，释放应用数据目录占用，避免静默安装前的数据保留失败。",
        "安装器临时文件放在更新目录，新版应用使用长期存在的数据临时目录，避免继承被清理路径。",
        "新版主窗口完成加载并显示后才确认更新成功，启动失败继续保留回滚能力。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  "version": "0.2.1",
  "summary": "Fix automatic update working-directory locks and temporary paths, and acknowledge success only after the new window loads and opens.",
  "sections": [
    {
      "title": "Automatic installation and reopening",
      "items": [
        "Start update helpers outside the installation and data directories so data preservation can proceed.",
        "Keep installer temporary files in staging and give the restarted application a persistent temporary directory.",
        "Acknowledge startup only after the main window has loaded and is visible, preserving rollback on startup failure."
      ]
    }
  ]
};
