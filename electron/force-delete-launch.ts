import { normalizeForceDeletePath } from "./force-delete";

const FORCE_DELETE_FLAG = "--force-delete-path";
const MAX_PATH_LENGTH = 32_768;
const INVALID_LAUNCH_MESSAGE = "右键强制删除参数无效，请重新选择一个文件或文件夹";

export interface ForceDeleteLaunchData {
  forceDeleteArgv: string[];
}

// Electron may reorder second-instance argv. Preserve only the original request
// arguments, including duplicate flags and missing values so they can be rejected.
export function createForceDeleteLaunchData(argv: readonly string[]): ForceDeleteLaunchData {
  return {
    forceDeleteArgv: argv.flatMap((arg, index) =>
      arg === FORCE_DELETE_FLAG ? argv.slice(index, index + 2) : []
    )
  };
}

// Explorer supplies one exact path as an argument, never a command to execute.
export function parseForceDeleteLaunch(
  argv: readonly string[],
  additionalData?: unknown
): string | undefined {
  let requestArgv = argv;
  if (additionalData !== undefined) {
    if (!additionalData || typeof additionalData !== "object" || Array.isArray(additionalData)) {
      throw new Error(INVALID_LAUNCH_MESSAGE);
    }
    // Older versions acquire the lock without request metadata, so their argv
    // remains a compatibility fallback. Malformed metadata must never use it.
    if (Object.prototype.hasOwnProperty.call(additionalData, "forceDeleteArgv")) {
      const original = (additionalData as Record<string, unknown>).forceDeleteArgv;
      if (
        !Array.isArray(original) ||
        (original.length !== 0 && original.length !== 2) ||
        original.some((arg) => typeof arg !== "string" || arg.length > MAX_PATH_LENGTH) ||
        (original.length === 2 && original[0] !== FORCE_DELETE_FLAG)
      ) {
        throw new Error(INVALID_LAUNCH_MESSAGE);
      }
      requestArgv = original;
    }
  }
  const indices = requestArgv.flatMap((arg, index) => arg === FORCE_DELETE_FLAG ? [index] : []);
  if (!indices.length) return undefined;
  const target = requestArgv[indices[0] + 1];
  if (indices.length !== 1 || typeof target !== "string" || !target || target.length > MAX_PATH_LENGTH) {
    throw new Error(INVALID_LAUNCH_MESSAGE);
  }
  return normalizeForceDeletePath(target);
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
