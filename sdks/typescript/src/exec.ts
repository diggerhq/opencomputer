import { ShellImpl, type Shell, type ShellOpts } from "./shell.js";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  /** Server-side command timeout in seconds (default 60). */
  timeout?: number;
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Abort the client-side wait for the result. The command keeps running on the
   * worker and stays retrievable by execId (exposed on the thrown error).
   */
  signal?: AbortSignal;
  /**
   * Max time to wait client-side for the command to finish, in milliseconds.
   * On expiry, run() throws an ExecTimeoutError but the command keeps running.
   */
  timeoutMs?: number;
}

/**
 * Thrown when run()'s client-side wait is aborted or times out. The command is
 * still running on the worker; re-poll or attach via execId to recover it.
 */
export class ExecTimeoutError extends Error {
  constructor(public readonly execId: string, message: string) {
    super(message);
    this.name = "ExecTimeoutError";
  }
}

interface ExecRunHandle {
  execId?: string;
  running?: boolean;
  startedAt?: string;
  // Back-compat: a pre-async origin returns the full result synchronously.
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

interface ExecRunResult {
  running: boolean;
  waking?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  error?: string;
  // Timing breakdown (524 attribution), observable per-request.
  wakeMs?: number;
  createMs?: number;
  commandMs?: number;
}

/** Sleep that resolves early (does not reject) when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

export interface ExecStartOpts {
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  maxRunAfterDisconnect?: number;
  onStdout?: (data: Uint8Array) => void;
  onStderr?: (data: Uint8Array) => void;
  onExit?: (exitCode: number) => void;
  onScrollbackEnd?: () => void;
}

export interface ExecAttachOpts {
  onStdout?: (data: Uint8Array) => void;
  onStderr?: (data: Uint8Array) => void;
  onExit?: (exitCode: number) => void;
  onScrollbackEnd?: () => void;
}

export interface ExecSessionInfo {
  sessionID: string;
  sandboxID: string;
  command: string;
  args: string[];
  running: boolean;
  exitCode?: number;
  startedAt: string;
  attachedClients: number;
}

export interface ExecSession {
  sessionId: string;
  /** Resolves with the exit code when the process exits. */
  done: Promise<number>;
  sendStdin(data: string | Uint8Array): void;
  kill(signal?: number): Promise<void>;
  close(): void;
}

export class Exec {
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

  async start(command: string, opts: ExecStartOpts = {}): Promise<ExecSession> {
    const body: Record<string, unknown> = { cmd: command };
    if (opts.args) body.args = opts.args;
    if (opts.env) body.envs = opts.env;
    if (opts.cwd) body.cwd = opts.cwd;
    if (opts.timeout != null) body.timeout = opts.timeout;
    if (opts.maxRunAfterDisconnect != null) body.maxRunAfterDisconnect = opts.maxRunAfterDisconnect;

    const resp = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/exec`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to create exec session: ${resp.status} ${text}`);
    }

    const data = await resp.json();
    const sessionId: string = data.sessionID;

    return this.attach(sessionId, {
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
      onExit: opts.onExit,
      onScrollbackEnd: opts.onScrollbackEnd,
    });
  }

  async attach(sessionId: string, opts: ExecAttachOpts = {}): Promise<ExecSession> {
    const wsUrl = this.apiUrl
      .replace("http://", "ws://")
      .replace("https://", "wss://");
    // WebSocket can't set custom headers, so pass credentials as query params.
    // Prefer JWT token (direct worker access); fall back to API key (control plane).
    const authParam = this.token
      ? `?token=${encodeURIComponent(this.token)}`
      : this.apiKey
        ? `?api_key=${encodeURIComponent(this.apiKey)}`
        : "";
    const wsEndpoint = `${wsUrl}/sandboxes/${this.sandboxId}/exec/${sessionId}${authParam}`;

    const ws = new WebSocket(wsEndpoint);
    ws.binaryType = "arraybuffer";

    let gotExit = false;
    let opened = false;
    let resolveDone: (code: number) => void;
    const done = new Promise<number>((resolve) => { resolveDone = resolve; });

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onerror = () => {
        if (!opened) reject(new Error(`WebSocket connection failed: ${wsEndpoint}`));
      };
      ws.onclose = () => {
        if (!opened) reject(new Error(`WebSocket closed before opening: ${wsEndpoint}`));
      };
    });

    ws.onmessage = (event) => {
      const buf = new Uint8Array(event.data as ArrayBuffer);
      if (buf.length < 1) return;

      const streamId = buf[0];
      const payload = buf.slice(1);

      switch (streamId) {
        case 0x01: // stdout
          opts.onStdout?.(payload);
          break;
        case 0x02: // stderr
          opts.onStderr?.(payload);
          break;
        case 0x03: // exit
          gotExit = true;
          if (payload.length >= 4) {
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const exitCode = view.getInt32(0, false); // big-endian
            opts.onExit?.(exitCode);
            resolveDone(exitCode);
          } else {
            opts.onExit?.(0);
            resolveDone(0);
          }
          break;
        case 0x04: // scrollback_end
          opts.onScrollbackEnd?.();
          break;
      }
    };

    ws.onclose = () => {
      if (!gotExit) {
        opts.onExit?.(-1);
        resolveDone(-1);
      }
    };

    ws.onerror = () => {
      // Post-open errors are followed by onclose, which handles exit.
    };

    const exec = this;

    return {
      sessionId,
      done,
      sendStdin(data: string | Uint8Array): void {
        if (ws.readyState !== WebSocket.OPEN) return;
        const payload = typeof data === "string"
          ? new TextEncoder().encode(data)
          : data;
        const msg = new Uint8Array(1 + payload.length);
        msg[0] = 0x00; // stdin stream ID
        msg.set(payload, 1);
        ws.send(msg);
      },
      async kill(signal?: number): Promise<void> {
        await exec.kill(sessionId, signal);
      },
      close(): void {
        ws.close();
      },
    };
  }

  async list(): Promise<ExecSessionInfo[]> {
    const resp = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/exec`, {
      headers: this.headers,
    });

    if (!resp.ok) {
      throw new Error(`Failed to list exec sessions: ${resp.status}`);
    }

    return resp.json();
  }

  async kill(sessionId: string, signal?: number): Promise<void> {
    const body: Record<string, unknown> = {};
    if (signal != null) body.signal = signal;

    const resp = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/exec/${sessionId}/kill`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to kill exec session: ${resp.status} ${text}`);
    }
  }

  /**
   * Alias for {@link start}. Use when the intent is "run this command in the
   * background and observe it" rather than the more ambiguous "start". Same
   * options, same return type.
   */
  async background(command: string, opts: ExecStartOpts = {}): Promise<ExecSession> {
    return this.start(command, opts);
  }

  /**
   * Open a stateful shell session. Subsequent `.run()` calls share the same
   * bash process, so `cwd`, exported env vars, and shell functions persist
   * across calls — the ergonomics of a terminal tab.
   *
   * Backed by a long-running exec session running `bash --noprofile --norc`.
   * Foreground-only: concurrent `.run()` rejects. Use `exec.background()` for
   * fire-and-forget processes. If the user command calls `exit`, the shell
   * closes (same as closing a terminal tab) and subsequent `.run()` rejects.
   */
  async shell(opts: ShellOpts = {}): Promise<Shell> {
    let impl: ShellImpl | null = null;
    const session = await this.start("bash", {
      args: ["--noprofile", "--norc", "+m"],
      env: opts.env,
      cwd: opts.cwd,
      onStdout: (chunk) => impl?.onStdoutChunk(chunk),
      onStderr: (chunk) => impl?.onStderrChunk(chunk),
      onScrollbackEnd: () => impl?.onScrollbackEnd(),
    });
    impl = new ShellImpl(session);
    return impl;
  }

  /**
   * Re-attach to a shell session that was previously opened by `shell()` and
   * whose sessionId you've kept. Useful for revisiting a long-lived terminal
   * tab from a different process invocation.
   *
   * Assumes the shell is idle (no in-flight `.run()` from another client).
   * If another client has a run in flight, output will interleave and the
   * results are undefined — coordinate at the application level.
   */
  async reattachShell(sessionId: string): Promise<Shell> {
    let impl: ShellImpl | null = null;
    const session = await this.attach(sessionId, {
      onStdout: (chunk) => impl?.onStdoutChunk(chunk),
      onStderr: (chunk) => impl?.onStderrChunk(chunk),
      onScrollbackEnd: () => impl?.onScrollbackEnd(),
    });
    impl = new ShellImpl(session);
    return impl;
  }

  /**
   * Run a command and wait for it to finish, returning its result.
   *
   * Transparently async: POSTs to /exec/run (which returns a handle
   * immediately) then polls /exec/:execId/result until the command exits. Each
   * HTTP request is sub-second, so there is no proxy 524 regardless of how long
   * the command runs, and a dropped poll simply retries — the result persists
   * on the worker independent of the connection.
   *
   * Pass `timeoutMs`/`signal` to bound the client-side wait; on expiry an
   * {@link ExecTimeoutError} is thrown (carrying execId) while the command
   * keeps running. For live output instead of wait-for-result, use
   * {@link start}/{@link background} + {@link attach}.
   */
  async run(command: string, opts: RunOpts = {}): Promise<ProcessResult> {
    const body: Record<string, unknown> = {
      cmd: "sh",
      args: ["-c", command],
    };
    if (opts.env) body.envs = opts.env;
    if (opts.cwd) body.cwd = opts.cwd;
    body.timeout = opts.timeout != null ? opts.timeout : 60;

    const resp = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/exec/run`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to run command: ${resp.status} ${text}`);
    }

    const handle = (await resp.json()) as ExecRunHandle;

    // Back-compat: an older (synchronous) origin returns the full result.
    if (handle.execId == null && handle.exitCode != null) {
      return {
        exitCode: handle.exitCode,
        stdout: handle.stdout ?? "",
        stderr: handle.stderr ?? "",
      };
    }

    const execId = handle.execId!;
    const deadline = opts.timeoutMs != null ? Date.now() + opts.timeoutMs : null;
    let delay = 200;
    const maxDelay = 2000;

    for (;;) {
      if (opts.signal?.aborted) {
        throw new ExecTimeoutError(execId, `exec.run aborted; command still running (execId=${execId})`);
      }
      if (deadline != null && Date.now() >= deadline) {
        throw new ExecTimeoutError(execId, `exec.run timed out after ${opts.timeoutMs}ms; command still running (execId=${execId})`);
      }

      const result = await this.result(execId);
      if (!result.running) {
        if (result.error) {
          // Wake/restore or session creation failed on the worker.
          throw new Error(`exec.run failed: ${result.error}`);
        }
        return {
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      }

      await sleep(delay, opts.signal);
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  /** Fetch the current result of an exec session (poll target for run()). */
  private async result(execId: string): Promise<ExecRunResult> {
    const resp = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/exec/${execId}/result`, {
      headers: this.headers,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to fetch exec result: ${resp.status} ${text}`);
    }

    return resp.json();
  }
}
