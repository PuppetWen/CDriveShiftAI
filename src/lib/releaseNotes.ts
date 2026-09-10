import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  version: "0.1.4",
  summary: "本版修复跨盘迁移、迁回和再次迁移的数据校验与恢复问题，新增管理员 PowerShell 强制删除及资源管理器右键菜单开关，并完善删除失败指引和设置保存。",
  sections: [
    {
      title: "迁移与恢复",
      items: [
        "迁移前后逐文件校验内容、目录结构与链接，复制并核验 NTFS 访问权限，识别复制期间的写入变化。",
        "修复内部绝对链接和外部相对链接在迁移、迁回后指向错误位置的问题，并核对原路径是否被替换。",
        "修复部分清理失败和中断恢复误判，保留可用数据与待清理状态，恢复后支持再次迁移。"
      ]
    },
    {
      title: "管理员强制删除",
      items: [
        "常规删除及处理已确认的占用进程后仍失败时，自动尝试管理员 PowerShell，支持 UAC 等待、取消与结果反馈。",
        "删除时核对目标和父目录身份，不跟随链接删除外部内容，也不改写目标外硬链接的只读属性。",
        "仅处理本次确认且身份未变的普通相关进程，完成后检查目标确实不存在。系统、自身和迁移事务路径继续受保护。"
      ]
    },
    {
      title: "删除失败操作指引",
      items: [
        "按文件占用、权限拒绝、后台持续写入和受保护路径分别说明下一步，并保留具体错误与失败路径。",
        "提供定位文件、复制路径、任务管理器和已安装应用入口，以及重启、卸载和普通残留文件的安全模式操作说明。",
        "管理员权限无法解除所有驱动锁或系统限制；失败后必须重新预检与确认，不将未删除的目标报告为成功。"
      ]
    },
    {
      title: "资源管理器右键菜单",
      items: [
        "设置中可添加或取消文件、文件夹的“CDriveShiftAI 强制删除”菜单；Windows 11 可能需点击“显示更多选项”。",
        "右键请求打开同一预检确认窗口，支持冷启动、托盘恢复和连续请求排队，不覆盖正在确认的目标。",
        "菜单显示实际注册状态，失败时回滚设置；卸载只清理由当前安装拥有的菜单，升级保留菜单。"
      ]
    },
    {
      title: "配置与操作稳定性",
      items: [
        "修复设置并发保存覆盖新编辑、旧请求覆盖新配置等问题；读取或保存失败明确报错并保留原数据。",
        "保留仍在使用或含待恢复数据的迁移记录，迁移、恢复和文件操作互斥，退出等待正在执行的事务。",
        "修复连续迁移状态、过期预检和弹窗期间后台删除快捷键问题，并改善长路径与大字号下的删除提示。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  version: "0.1.4",
  summary:
    "This release repairs migration and restore verification, adds elevated PowerShell deletion and an Explorer menu switch, and improves failure guidance and settings persistence.",
  sections: [
    {
      title: "Migration and restore",
      items: [
        "Verify individual file contents, structure, links, and NTFS permissions; detect writes during copying.",
        "Repair relocated link targets and reject replaced source paths during migration and restore.",
        "Preserve usable data after interrupted operations or partial cleanup, and allow migration again after restore."
      ]
    },
    {
      title: "Elevated force deletion",
      items: [
        "Retry with elevated PowerShell when ordinary deletion and confirmed process handling fail; report UAC results.",
        "Verify target and parent identities without following links or changing external hard-link attributes.",
        "Only handle confirmed, unchanged ordinary processes; verify deletion and retain protected-path safeguards."
      ]
    },
    {
      title: "Deletion failure guidance",
      items: [
        "Show steps for locks, denied access, ongoing writes, and protected paths while retaining the actual error.",
        "Add file, clipboard, Task Manager, and uninstall links plus restart and Safe Mode steps for ordinary leftovers.",
        "Elevation cannot remove every driver lock or system restriction; retries require a fresh preview and consent."
      ]
    },
    {
      title: "Explorer context menu",
      items: [
        "Enable or remove the file and folder force-delete menu in Settings; Windows 11 may use Show more options.",
        "Open the same confirmation dialog from a cold start or tray, and queue requests without replacing a target.",
        "Read actual registration status, roll back failed changes, and remove only this installation's menu on uninstall."
      ]
    },
    {
      title: "Settings and reliability",
      items: [
        "Keep newer settings edits during concurrent saves and report read or write failures without losing old data.",
        "Protect active migration records, serialize file operations, and wait for active transactions before exit.",
        "Fix repeated migration, stale previews, background delete shortcuts during dialogs, and enlarged-text layouts."
      ]
    }
  ]
};
