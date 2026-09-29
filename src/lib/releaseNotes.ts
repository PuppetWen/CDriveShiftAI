import type { AppUpdateReleaseSection } from "../types";

export interface BundledReleaseNote {
  version: string;
  summary: string;
  sections: AppUpdateReleaseSection[];
}

export const bundledReleaseNotes: BundledReleaseNote = {
  "version": "0.1.8",
  "summary": "本版补强文件和目录占用检测，删除前显示所属应用、进程和占用路径，并修复搜索索引持有工作目录及后台扫描句柄的问题。",
  "sections": [
    {
      "title": "找出占用应用",
      "items": [
        "删除预检显示应用名称、进程名、PID、程序位置和可识别的占用路径，区分实际句柄占用与启动路径、命令行关联。",
        "增加系统文件句柄扫描，补充大目录遍历上限之外的占用；进程查询不可用时仍可通过原生进程身份识别占用应用。",
        "排除命名管道，避免句柄查询阻塞；检测超时时保留已经完成的结果并提示列表可能不完整。"
      ]
    },
    {
      "title": "确认后处理占用并删除",
      "items": [
        "普通删除失败后，核对本次确认中进程的 PID 与启动时间，只结束身份一致且允许结束的进程，再重试删除。",
        "必要时继续使用管理员权限重试，删除后检查目标确实消失；结束应用前明确提醒未保存内容可能丢失。",
        "保留系统进程、受保护路径和迁移事务保护；系统或驱动锁无法解除时显示实际失败原因。"
      ]
    },
    {
      "title": "搜索不阻碍文件操作",
      "items": [
        "应用和索引子进程使用应用数据目录作为工作目录，避免继承待删除或待移动的文件夹。",
        "名称扫描和内容索引在后台暂停、读取文件或等待队列前释放目录枚举句柄；实时搜索与目录统计同步释放枚举句柄。",
        "内容读取明确允许共享读写和删除，并对实际读取字节数设限，避免增长中的日志突破单文件限制。"
      ]
    }
  ]
};

export const bundledReleaseNotesEnglish: BundledReleaseNote = {
  "version": "0.1.8",
  "summary": "This release improves file and folder lock detection, identifies the owning app before deletion, and releases working-directory and background-scan handles used by search.",
  "sections": [
    {
      "title": "Identify apps using files",
      "items": [
        "Show application name, process name, PID, executable location, and detected open path; distinguish open handles from executable and command-line matches.",
        "Scan system file handles beyond the directory traversal limit and use native process identities when CIM process discovery is unavailable.",
        "Skip named pipes to avoid blocked name queries and retain completed discovery results if a later query times out."
      ]
    },
    {
      "title": "Handle confirmed locks before deletion",
      "items": [
        "After ordinary deletion fails, recheck the confirmed PID and process start time, stop only permitted unchanged processes, and retry deletion.",
        "Retry with administrator privileges when needed and verify that the target is gone; warn that stopping apps can lose unsaved work.",
        "Keep system-process, protected-path, and migration safeguards, and report failures when Windows or driver locks cannot be released."
      ]
    },
    {
      "title": "Keep search from obstructing file operations",
      "items": [
        "Use the application data directory as the working directory for the app and indexer instead of inheriting a folder the user may want to move or delete.",
        "Close directory enumeration before background pauses, file reads, or queue waits; apply the same approach to live search and directory statistics.",
        "Explicitly share content reads with writes and deletion, and bound the actual bytes read from growing log files."
      ]
    }
  ]
};
