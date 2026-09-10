import type { ForceDeletePreview } from "../types";

type Localize = (zh: string, en: string) => string;
export type DeleteHelpCategory = "permission" | "busy" | "writing" | "protected" | "migration" | "operation" | "refresh" | "missing" | "authorization" | "elevation" | "unknown";
export const SAFE_MODE_HELP_URL = "https://support.microsoft.com/en-us/windows/experience/startup-boot/windows-startup-settings";

export function deleteHelpCategory(message: string): DeleteHelpCategory {
  const elevationCode = /(?:^|Error:\s*)(DELETE_ELEVATION_CANCELLED|DELETE_ELEVATION_FAILED)(?=[:：\s]|$)/.exec(message)?.[1];
  if (elevationCode === "DELETE_ELEVATION_CANCELLED") return "authorization";
  if (elevationCode === "DELETE_ELEVATION_FAILED") return "elevation";
  // Prefer the service's error code over words in arbitrary file/process names.
  const code = /强制删除失败[（(](EPERM|EACCES|EBUSY|ENOTEMPTY|ENOENT)[）)]/.exec(message)?.[1];
  if (code === "EPERM" || code === "EACCES") return "permission";
  if (code === "EBUSY") return "busy";
  if (code === "ENOTEMPTY") return "writing";
  if (code === "ENOENT") return "missing";
  if (/属于迁移或恢复事务|迁移或恢复正在执行|迁移记录|请先.*恢复/.test(message)) return "migration";
  if (/其他文件操作正在执行|正在强制删除/.test(message)) return "operation";
  if (/受保护路径不能|该路径受系统保护|包含受保护的系统|位于受保护的系统|Windows 商店应用|不能.*CDriveShiftAI.*目录|设备命名空间|盘符根目录|共享根目录/.test(message)) return "protected";
  if (/确认已过期|预检已过期|预检后已被替换|路径发生变化|目标或父目录已发生变化|目标仍然存在或已被其他程序重新创建|需要明确的绝对文件路径|deletion preview expired/i.test(message)) return "refresh";
  if (/\bENOENT\b|目标不存在|找不到指定的文件/.test(message)) return "missing";
  if (/\bENOTEMPTY\b|持续写入/.test(message)) return "writing";
  if (/\bEBUSY\b/.test(message)) return "busy";
  if (/\b(?:EPERM|EACCES)\b|拒绝访问|权限不足/.test(message)) return "permission";
  return "unknown";
}

export function forceDeleteGuidance(message: string, preview: ForceDeletePreview | undefined, ui: Localize) {
  const category = deleteHelpCategory(message);
  const closeApps = ui("先保存工作并完全退出目标所属应用，包括右下角托盘程序；关闭正在浏览该目录的资源管理器窗口、预览窗格和终端。", "Save your work and fully exit the owning app, including its tray icon. Close Explorer windows, preview panes, and terminals using this folder.");
  const taskManager = ui("仍有占用时，打开任务管理器 → 详细信息，核对应用名称和 PID；仅结束你确认属于目标的普通应用，不要强行结束系统或受保护进程。", "If the app remains open, use Task Manager → Details to check its name and PID. End only the ordinary app you identify as owning the target, not system or protected processes.");
  const retry = ui("完成处理后点击“重新检查”，核对最新目标与进程，再重新勾选确认并删除。", "After resolving the cause, click “Check again”, review the current target and processes, then confirm and delete again.");
  const steps: string[] = [];
  let title = ui("按以下步骤处理后重试", "Resolve the cause, then try again");
  if (category === "protected") {
    title = ui("此路径不能直接强制删除", "This path cannot be force deleted directly");
    steps.push(ui("如果要移除应用，请打开“已安装的应用”，找到对应应用并选择“卸载”；Windows 10 中该页面可能叫“应用和功能”。", "To remove an app, open Installed apps and uninstall the matching app. Windows 10 may call this page Apps & features."));
    steps.push(ui("CDriveShiftAI 自身需先退出后通过卸载程序移除；系统、商店包和受保护目录应使用 Windows 或厂商提供的清理/卸载功能。提权或安全模式不会取消本软件的路径保护。", "Exit CDriveShiftAI before uninstalling it. Use Windows or the vendor's cleanup/uninstall tools for system folders and Store packages. Elevation or Safe Mode does not remove this app's path protection."));
  } else if (category === "migration") {
    title = ui("先完成迁移或恢复", "Finish the migration or restore first");
    steps.push(ui("等待当前文件操作完成。若目标属于已迁移的应用，到“迁移历史”先恢复到原位置，再决定卸载应用或删除文件。", "Wait for the current file operation. If this target belongs to a migrated app, restore it from Migration history before uninstalling the app or deleting its files."));
    steps.push(ui("若历史记录提示清理未完成，先按记录中的路径与错误处理占用，再重启本软件让恢复流程重试；不要直接删除唯一可用的数据副本。", "If history reports incomplete cleanup, resolve the lock at the path shown, then restart this app to retry recovery. Preserve the only usable copy of the data."));
  } else if (category === "authorization") {
    title = ui("管理员授权已取消，删除未完成", "Administrator authorization was cancelled; deletion did not finish");
    steps.push(ui("如果仍要删除，请点击“重新检查”并重新确认；系统再次显示用户账户控制（UAC）窗口时，核对后选择“是”，或输入管理员账户凭据。", "If you still want to delete the target, click “Check again” and confirm again. When Windows shows User Account Control (UAC), review it and choose Yes or enter administrator credentials."));
    steps.push(ui("如果没有管理员凭据，请联系设备管理员。取消授权后不会继续管理员删除，也不会安排重启后删除。", "If you do not have administrator credentials, contact the device administrator. Cancelling authorization stops the administrator attempt and does not schedule deletion on restart."));
  } else if (category === "operation") {
    title = ui("等待当前文件操作完成", "Wait for the current file operation");
    steps.push(ui("目标或其父子目录正被其他文件操作使用。等待该操作完成后再重新检查；如果正在删除，请先确认目标是否仍然存在。", "Another file operation is using this target or a related folder. Wait for it to finish, then check again. If it is being deleted, first check whether the target still exists."));
    steps.push(retry);
  } else if (category === "refresh" || category === "missing") {
    title = category === "missing" ? ui("先确认目标是否仍存在", "Check whether the target still exists") : ui("目标或确认信息已变化", "The target or confirmation has changed");
    steps.push(ui("点击“定位文件”核对原路径。如果文件已被移走或删除，关闭此窗口并刷新搜索结果；如果仍存在，重新选择当前目标。", "Use Locate file to check the original path. If it was moved or deleted, close this dialog and refresh search results; otherwise select the current target again."));
    steps.push(retry);
  } else {
    if (category === "busy") title = ui("文件或目录可能仍被占用", "The file or folder may still be in use");
    if (category === "elevation") {
      title = ui("管理员删除仍未完成", "Administrator deletion did not finish");
      steps.push(ui("展开下方失败原因，核对 PowerShell 的错误与具体路径。系统策略阻止管理员运行时请联系设备管理员；文件锁、驱动占用或访问规则仍可能使管理员删除失败。", "Expand the error details below and check the PowerShell error and exact path. Contact the device administrator if policy prevents elevated execution. File locks, driver locks, and access rules can still prevent administrator deletion."));
    }
    if (category === "permission") {
      title = ui("权限或文件占用可能阻止删除", "Permissions or an open file may be blocking deletion");
      steps.push(preview?.elevated === true
        ? ui("当前已是管理员，无需反复提权。先退出占用应用，再检查下述文件访问权限。", "You are already running as administrator. Exit the owning app, then check the file permissions below.")
        : ui("普通删除重试失败后，本软件会尝试管理员 PowerShell 删除；出现用户账户控制（UAC）窗口时，核对后允许或输入管理员凭据。无需先退出本软件重新提权；无法获得授权时请联系设备管理员。", "After normal deletion retries fail, this app attempts deletion through administrator PowerShell. Review and allow User Account Control (UAC), or enter administrator credentials. You do not need to restart this app as administrator; contact the device administrator if authorization is unavailable."));
      steps.push(ui("点击“定位文件”→ 右键目标“属性”→“安全”→“高级”，检查当前账户的有效访问权限。对你拥有的普通文件，可由所有者/管理员为该账户授予目标及内容的“删除”或“修改”权限；不要修改系统目录或其他用户的权限。", "Locate file → right-click the target → Properties → Security → Advanced, then check your account's effective access. For ordinary files you own, the owner/administrator can grant Delete or Modify for the target and its contents. Leave system folders and other users' permissions unchanged."));
    }
    if (category === "writing") {
      title = ui("先停止后台程序重新写入", "Stop background writes first");
      steps.push(ui("暂停此目录的同步、下载、备份和自动更新任务；退出关联应用及托盘程序。文件删除后立即出现，通常需要先停掉创建它的程序。", "Pause sync, download, backup, and update jobs using this folder, then exit the owning app and its tray icon. If files immediately reappear, stop the program creating them first."));
    } else steps.push(closeApps);
    if (category === "busy") steps.push(ui("如果 PowerShell 正停留在目标目录或其子目录，先执行 Set-Location -LiteralPath $env:USERPROFILE 切换到用户目录，再点击“重新检查”。", "If PowerShell is in this folder or a subfolder, run Set-Location -LiteralPath $env:USERPROFILE to switch to your user folder, then click “Check again”."));
    steps.push(taskManager, retry);
  }
  return {
    category, title, steps,
    canRetry: category !== "protected",
    showTaskManager: ["permission", "busy", "writing", "elevation", "unknown"].includes(category),
    showUninstall: category === "protected" || preview?.highRisk === true || preview?.processes.some((item) => !item.canTerminate) === true,
    showRestartHelp: ["permission", "busy", "writing", "elevation", "unknown"].includes(category)
  };
}
