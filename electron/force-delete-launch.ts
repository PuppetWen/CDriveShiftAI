import { normalizeForceDeletePath } from "./force-delete";

// Explorer supplies one exact path as an argument, never a command to execute.
export function parseForceDeleteLaunch(argv: readonly string[]): string | undefined {
  const indices = argv.flatMap((arg, index) => arg === "--force-delete-path" ? [index] : []);
  if (!indices.length) return undefined;
  if (indices.length !== 1 || !argv[indices[0] + 1] || argv[indices[0] + 1].length > 32_768) {
    throw new Error("右键强制删除参数无效，请重新选择一个文件或文件夹");
  }
  return normalizeForceDeletePath(argv[indices[0] + 1]);
}

export class ForceDeleteLaunchQueue {
  private readonly paths: string[] = [];
  enqueue(target: string): void {
    if (this.paths.some((item) => item.toLowerCase() === target.toLowerCase())) return;
    if (this.paths.length >= 20) throw new Error("等待确认的删除请求过多，请先处理已打开的窗口");
    this.paths.push(target);
  }
  get pending(): boolean { return this.paths.length > 0; }
  takeAll(): string[] { return this.paths.splice(0); }
}
