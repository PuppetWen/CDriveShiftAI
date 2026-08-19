import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  version: "0.1.2",
  summary: "本版重做非系统盘归属扫描，深入识别普通安装应用、绿色便携应用和应用数据，同时修正受限目录统计。",
  sections: [
    {
      title: "深层目录扫描",
      items: [
        "非系统盘不再只查看根目录一两层，而是在时间和数量保护范围内递归扫描最多 8 层、60000 个目录。",
        "结果页显示实际扫描目录数；达到时间或数量上限时会明确标记结果可能不完整。",
        "自动跳过 node_modules、缓存、虚拟环境和系统噪声目录，兼顾覆盖率与后台资源占用。"
      ]
    },
    {
      title: "应用与绿色版识别",
      items: [
        "根据深层可执行文件、卸载标记、app.asar、portable.ini 等证据识别无安装记录的绿色便携应用。",
        "将 bin、resources、runtime、Binaries 等内部目录归并到应用根目录，减少一个应用被拆成多条记录。",
        "解析 Steam appmanifest 文件，补充 Steam 游戏的正式名称与实际安装目录。"
      ]
    },
    {
      title: "应用数据归属",
      items: [
        "识别应用附近的 data、config、profiles、saves、logs、userdata 等数据目录并关联到对应应用。",
        "应用库目录即使缺少注册表记录，也会依据本地文件结构给出保守的归属结果和可信度。",
        "弱注册表名称匹配不再覆盖更可靠的目录与可执行文件证据。"
      ]
    },
    {
      title: "受限目录与缓存",
      items: [
        "不存在的标准目录不再误报为权限受限；回收站、System Volume Information 等系统目录按系统项处理。",
        "受限统计只记录真实读取或权限错误，并在界面中使用准确提示。",
        "归属缓存结构升级到版本 3，旧的浅层扫描缓存会自动失效并重新扫描。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  version: "0.1.2",
  summary:
    "This release rebuilds non-system-drive ownership discovery to find installed apps, portable apps, and application data more deeply while correcting restricted-directory reporting.",
  sections: [
    {
      title: "Deep directory scanning",
      items: [
        "Non-system drives are recursively inspected up to 8 levels and 60,000 directories instead of stopping near the root.",
        "The result reports the actual directory count and explicitly marks scans truncated by time or quantity limits.",
        "Dependency, cache, virtual-environment, and system-noise trees are skipped to balance coverage with background cost."
      ]
    },
    {
      title: "Installed and portable apps",
      items: [
        "Deep executables, uninstall markers, app.asar, portable.ini, and similar evidence identify unpacked portable applications.",
        "Internal bin, resources, runtime, and Binaries folders are grouped under the application root.",
        "Steam app manifests provide official names and actual installation directories."
      ]
    },
    {
      title: "Application data ownership",
      items: [
        "Nearby data, config, profiles, saves, logs, and userdata directories are associated with their applications.",
        "Application-library directories receive conservative local ownership evidence even without registry records.",
        "Weak registry name matches no longer override stronger filesystem and executable evidence."
      ]
    },
    {
      title: "Restricted paths and cache",
      items: [
        "Missing standard folders no longer count as access restrictions, while protected system folders are classified as system entries.",
        "Only real read or permission failures contribute to the restricted-path warning.",
        "Ownership cache schema version 3 invalidates stale shallow-scan results automatically."
      ]
    }
  ]
};
