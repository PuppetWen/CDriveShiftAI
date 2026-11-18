import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { logger, serializeError } from "./logger";

type Request = Record<string, unknown>;
type Reply = Record<string, unknown>;

interface Session {
  child: ChildProcessWithoutNullStreams;
  owner: number;
  ready: boolean;
  visible: boolean;
  stopping: boolean;
  started: NodeJS.Timeout;
  exited: Promise<void>;
}

const MAX_REQUEST_LENGTH = 256 * 1024;

export class NativeQuickSearchHost {
  private session?: Session;
  private nextOwner = -1;

  constructor(private readonly options: {
    executable: string;
    cwd: string;
    args?: () => string[];
    dispatch: (owner: number, request: Request) => Promise<Reply>;
    visibilityChanged: (owner: number, visible: boolean) => void;
    closed: (owner: number) => void;
    fallback: () => void;
  }) {}

  get visible(): boolean {
    return this.session?.visible === true && !this.session.stopping;
  }

  get opened(): boolean {
    return this.session != null && !this.session.stopping;
  }

  open(): boolean {
    if (this.session) {
      if (this.session.stopping) return false;
      if (this.session.ready) this.send(this.session, { command: "show" });
      return true;
    }
    if (process.platform !== "win32" || !existsSync(this.options.executable)) return false;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.executable, ["--hosted", ...(this.options.args?.() ?? [])], {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      logger.warn("quick_search.native_launch_failed", { error: serializeError(error) });
      return false;
    }
    let finish: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => { finish = resolve; });
    const session: Session = {
      child, owner: this.nextOwner--, ready: false, visible: true, stopping: false, exited,
      started: setTimeout(() => this.fail(session, "ready timeout"), 5_000)
    };
    this.session = session;
    session.started.unref();
    this.options.visibilityChanged(session.owner, true);
    child.stdin.on("error", () => {
      if (!session.stopping) this.fail(session, "input closed");
    });
    child.stdout.on("error", () => this.fail(session, "output closed"));
    child.stderr.resume(); // Drain diagnostics without logging request content.
    child.once("error", (error) => {
      logger.warn("quick_search.native_process_error", { error: serializeError(error) });
      if (child.pid == null) this.close(session, null, finish);
      else this.fail(session, "child process error");
    });
    child.once("exit", (code) => this.close(session, code, finish));
    child.stdout.setEncoding("utf8");
    let pending = "";
    child.stdout.on("data", (chunk: string) => {
      if (this.session !== session || session.stopping) return;
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        if (newline > MAX_REQUEST_LENGTH) {
          this.fail(session, "request too large");
          return;
        }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        this.receive(session, line);
        if (session.stopping) return;
      }
      if (pending.length > MAX_REQUEST_LENGTH) this.fail(session, "request too large");
    });
    return true;
  }

  sendEvent(event: string, status: unknown): void {
    const session = this.session;
    if (session?.ready && !session.stopping) this.send(session, { event, status });
  }

  async stop(): Promise<void> {
    const session = this.session;
    if (!session) return;
    session.stopping = true;
    clearTimeout(session.started);
    this.send(session, { command: "shutdown" });
    session.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => { session.child.kill(); resolve(); }, 1_000);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private receive(session: Session, line: string): void {
    let request: Request;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      request = value as Request;
    } catch {
      this.fail(session, "invalid protocol message");
      return;
    }
    if (request.event === "ready") {
      if (session.ready || request.protocol !== 1) {
        this.fail(session, "unsupported protocol");
        return;
      }
      session.ready = true;
      clearTimeout(session.started);
      logger.info("quick_search.native_ready", { pid: session.child.pid });
      return;
    }
    if (!session.ready) {
      this.fail(session, "request before ready");
      return;
    }
    if (request.event === "visibility" && typeof request.visible === "boolean") {
      session.visible = request.visible;
      this.options.visibilityChanged(session.owner, session.visible);
      return;
    }
    const id = request.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || typeof request.op !== "string") {
      this.fail(session, "invalid request");
      return;
    }
    void this.options.dispatch(session.owner, request).then(
      (response) => {
        if (this.session === session && !session.stopping) this.send(session, { ...response, id, ok: true });
      },
      (error: unknown) => {
        if (this.session === session && !session.stopping) this.send(session, {
          id, ok: false, error: error instanceof Error ? error.message : "原生搜索请求失败"
        });
      }
    );
  }

  private send(session: Session, message: Reply): void {
    if (!session.child.stdin.destroyed && !session.child.stdin.writableEnded) {
      session.child.stdin.write(JSON.stringify(message) + "\n");
    }
  }

  private fail(session: Session, reason: string): void {
    if (this.session !== session || session.stopping) return;
    logger.warn("quick_search.native_failed", { reason, pid: session.child.pid });
    session.child.kill();
  }

  private close(session: Session, code: number | null, finish: () => void): void {
    finish();
    clearTimeout(session.started);
    if (this.session !== session) return;
    this.session = undefined;
    this.options.visibilityChanged(session.owner, false);
    if (!session.stopping && (!session.ready || code !== 0)) this.options.fallback();
    this.options.closed(session.owner);
  }
}
