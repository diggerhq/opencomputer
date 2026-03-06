export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  timeout?: number;
  env?: Record<string, string>;
  cwd?: string;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  /** Allocate a PTY for real-time unbuffered output (npm, apt, pip, etc.). */
  tty?: boolean;
  /** Run the command in the background. Returns a CommandHandle immediately
   *  instead of waiting for the process to exit. Use for long-running servers,
   *  dev tools, etc. The process keeps running even if you don't hold a reference. */
  background?: boolean;
}

export interface ExecChunk {
  stream: "stdout" | "stderr";
  data: string;
}

/** Handle for a background process. Allows waiting, killing, or disconnecting. */
export class CommandHandle {
  readonly sessionId: string;
  private _ws: WebSocket | null = null;
  private _killed = false;

  constructor(
    sessionId: string,
    private apiUrl: string,
    private headers: Record<string, string>,
    private sandboxId: string,
    ws: WebSocket | null,
    private onStdout?: (data: string) => void,
    private onStderr?: (data: string) => void,
  ) {
    this.sessionId = sessionId;
    this._ws = ws;
  }

  /** Send data to the process's stdin. */
  sendInput(data: string): void {
    if (this._ws && this._ws.readyState === this._ws.OPEN) {
      this._ws.send(data);
    }
  }

  /** Kill the background process. */
  async kill(): Promise<void> {
    if (this._killed) return;
    this._killed = true;
    this._ws?.close();
    await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/pty/${this.sessionId}`, {
      method: "DELETE",
      headers: this.headers,
    }).catch(() => {});
  }

  /** Disconnect from the process without killing it. The process keeps running
   *  in the sandbox. You can reconnect later via `commands.connect()`. */
  disconnect(): void {
    this._ws?.close();
    this._ws = null;
  }

  /** Wait for the background process to exit. Resolves when the WebSocket closes. */
  async wait(): Promise<void> {
    if (!this._ws) return;
    const ws = this._ws;
    if (ws.readyState === ws.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
    });
  }
}

export class Commands {
  constructor(
    private apiUrl: string,
    private apiKey: string,
    private sandboxId: string,
    private token: string = "",
  ) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) {
      h["Authorization"] = `Bearer ${this.token}`;
    } else if (this.apiKey) {
      h["X-API-Key"] = this.apiKey;
    }
    return h;
  }

  /**
   * Run a command in the sandbox.
   *
   * - Default: waits for completion, returns ProcessResult.
   * - `{ background: true }`: starts the process and returns a CommandHandle immediately.
   *   The process runs in a PTY session and survives client disconnect.
   * - `onStdout`/`onStderr`: stream output in real-time via SSE (foreground only).
   */
  run(command: string, opts: RunOpts & { background: true }): Promise<CommandHandle>;
  run(command: string, opts?: RunOpts & { background?: false }): Promise<ProcessResult>;
  run(command: string, opts: RunOpts = {}): Promise<ProcessResult | CommandHandle> {
    if (opts.background) {
      return this._runBackground(command, opts);
    }
    if (opts.onStdout || opts.onStderr || opts.tty) {
      return this._runStreaming(command, opts);
    }
    return this._runSimple(command, opts);
  }

  /**
   * Connect to an already-running background process by its session ID.
   */
  async connect(sessionId: string, opts?: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  }): Promise<CommandHandle> {
    const ws = this._connectWebSocket(sessionId, opts?.onStdout, opts?.onStderr);
    return new CommandHandle(sessionId, this.apiUrl, this.headers, this.sandboxId, ws, opts?.onStdout, opts?.onStderr);
  }

  /** List active PTY sessions (background processes). */
  // Note: This relies on the existing PTY list if/when the backend exposes it.
  // For now, callers track session IDs themselves.

  /** Kill a background process by session ID. */
  async kill(sessionId: string): Promise<void> {
    await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/pty/${sessionId}`, {
      method: "DELETE",
      headers: this.headers,
    }).catch(() => {});
  }

  // --- Private implementations ---

  private async _runSimple(command: string, opts: RunOpts): Promise<ProcessResult> {
    const timeout = opts.timeout ?? 60;

    const body: Record<string, unknown> = {
      cmd: command,
      timeout,
    };
    if (opts.env) body.envs = opts.env;
    if (opts.cwd) body.cwd = opts.cwd;

    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), (timeout + 5) * 1000);

    try {
      const resp = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/commands`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Command failed: ${resp.status} ${text}`);
      }

      return await resp.json();
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  private async _runStreaming(command: string, opts: RunOpts): Promise<ProcessResult> {
    const timeout = opts.timeout ?? 60;

    const body: Record<string, unknown> = {
      cmd: command,
      timeout,
    };
    if (opts.env) body.envs = opts.env;
    if (opts.cwd) body.cwd = opts.cwd;
    if (opts.tty) body.tty = true;

    const controller = new AbortController();
    const idleMs = (timeout + 30) * 1000;
    let idleTimer = globalThis.setTimeout(() => controller.abort(), idleMs);
    const resetIdle = () => {
      globalThis.clearTimeout(idleTimer);
      idleTimer = globalThis.setTimeout(() => controller.abort(), idleMs);
    };

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      const resp = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/exec`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Command failed: ${resp.status} ${text}`);
      }

      if (!resp.body) {
        throw new Error("No response body for streaming");
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const event = parseSSEEvent(part);
          if (!event) continue;

          if (event.type === "stdout" || event.type === "stderr") {
            const data = JSON.parse(event.data);
            if (event.type === "stdout") {
              stdout += data.data;
              opts.onStdout?.(data.data);
            } else {
              stderr += data.data;
              opts.onStderr?.(data.data);
            }
          } else if (event.type === "exit") {
            const data = JSON.parse(event.data);
            exitCode = data.exit_code;
          } else if (event.type === "error") {
            const data = JSON.parse(event.data);
            throw new Error(data.error);
          }
        }
      }
    } finally {
      globalThis.clearTimeout(idleTimer);
    }

    return { exitCode, stdout, stderr };
  }

  private async _runBackground(command: string, opts: RunOpts): Promise<CommandHandle> {
    // Create a PTY session
    const resp = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/pty`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        cols: 120,
        rows: 40,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to start background process: ${resp.status} ${text}`);
    }

    const data = await resp.json();
    const sessionId: string = data.sessionID;

    // Connect WebSocket for output
    const ws = this._connectWebSocket(sessionId, opts.onStdout, opts.onStderr);

    // Wait for WebSocket to open, then send the command
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", (e) => reject(new Error("WebSocket connection failed")), { once: true });
    });

    // Send command + newline to execute it
    const envPrefix = opts.env
      ? Object.entries(opts.env).map(([k, v]) => `export ${k}=${shellEscape(v)}`).join(" && ") + " && "
      : "";
    const cdPrefix = opts.cwd ? `cd ${shellEscape(opts.cwd)} && ` : "";
    ws.send(`${envPrefix}${cdPrefix}${command}\n`);

    return new CommandHandle(sessionId, this.apiUrl, this.headers, this.sandboxId, ws, opts.onStdout, opts.onStderr);
  }

  private _connectWebSocket(
    sessionId: string,
    onStdout?: (data: string) => void,
    onStderr?: (data: string) => void,
  ): WebSocket {
    const wsUrl = this.apiUrl
      .replace("http://", "ws://")
      .replace("https://", "wss://");
    const ws = new WebSocket(`${wsUrl}/sandboxes/${this.sandboxId}/pty/${sessionId}`);
    ws.binaryType = "arraybuffer";

    if (onStdout) {
      const decoder = new TextDecoder();
      ws.onmessage = (event) => {
        const text = event.data instanceof ArrayBuffer
          ? decoder.decode(new Uint8Array(event.data))
          : event.data as string;
        // PTY merges stdout/stderr, so everything comes as stdout
        onStdout(text);
      };
    }

    return ws;
  }
}

function parseSSEEvent(raw: string): { type: string; data: string } | null {
  let type = "message";
  let data = "";

  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) {
      type = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      data = line.slice(6);
    }
  }

  if (!data) return null;
  return { type, data };
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
