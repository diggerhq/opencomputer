export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  timeout?: number;
  env?: Record<string, string>;
  cwd?: string;
}

export interface StreamOpts extends RunOpts {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface ExecChunk {
  stream: "stdout" | "stderr";
  data: string;
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

  async run(command: string, opts: RunOpts = {}): Promise<ProcessResult> {
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

  /**
   * Execute a command and stream stdout/stderr in real time via SSE.
   * Returns an async iterable of output chunks that also resolves to the final ProcessResult.
   */
  stream(command: string, opts: StreamOpts = {}): StreamHandle {
    const timeout = opts.timeout ?? 60;

    const body: Record<string, unknown> = {
      cmd: command,
      timeout,
    };
    if (opts.env) body.envs = opts.env;
    if (opts.cwd) body.cwd = opts.cwd;

    return new StreamHandle(
      `${this.apiUrl}/sandboxes/${this.sandboxId}/exec`,
      this.headers,
      body,
      timeout,
      opts.onStdout,
      opts.onStderr,
    );
  }
}

/**
 * Handle for a streaming command execution.
 * Can be used as an async iterable or awaited for the final result.
 */
export class StreamHandle implements AsyncIterable<ExecChunk>, PromiseLike<ProcessResult> {
  private _resultPromise: Promise<ProcessResult> | null = null;
  private _chunks: ExecChunk[] = [];
  private _listeners: Array<(chunk: ExecChunk) => void> = [];
  private _done = false;
  private _exitCode = 0;

  constructor(
    private url: string,
    private headers: Record<string, string>,
    private body: Record<string, unknown>,
    private timeout: number,
    private onStdout?: (data: string) => void,
    private onStderr?: (data: string) => void,
  ) {}

  private _start(): Promise<ProcessResult> {
    if (this._resultPromise) return this._resultPromise;

    this._resultPromise = this._run();
    return this._resultPromise;
  }

  private async _run(): Promise<ProcessResult> {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(
      () => controller.abort(),
      (this.timeout + 10) * 1000,
    );

    let stdout = "";
    let stderr = "";

    try {
      const resp = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(this.body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Stream exec failed: ${resp.status} ${text}`);
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

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const event = parseSSEEvent(part);
          if (!event) continue;

          if (event.type === "stdout" || event.type === "stderr") {
            const data = JSON.parse(event.data);
            const chunk: ExecChunk = { stream: event.type, data: data.data };

            if (event.type === "stdout") {
              stdout += data.data;
              this.onStdout?.(data.data);
            } else {
              stderr += data.data;
              this.onStderr?.(data.data);
            }

            this._chunks.push(chunk);
            for (const listener of this._listeners) {
              listener(chunk);
            }
          } else if (event.type === "exit") {
            const data = JSON.parse(event.data);
            this._exitCode = data.exit_code;
          } else if (event.type === "error") {
            const data = JSON.parse(event.data);
            throw new Error(data.error);
          }
        }
      }
    } finally {
      globalThis.clearTimeout(timeoutId);
      this._done = true;
    }

    return {
      exitCode: this._exitCode,
      stdout,
      stderr,
    };
  }

  then<TResult1 = ProcessResult, TResult2 = never>(
    onfulfilled?: ((value: ProcessResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this._start().then(onfulfilled, onrejected);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ExecChunk> {
    // Start the stream
    const resultPromise = this._start();

    let resolveNext: ((value: ExecChunk | null) => void) | null = null;
    const pending: ExecChunk[] = [];

    const listener = (chunk: ExecChunk) => {
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve(chunk);
      } else {
        pending.push(chunk);
      }
    };

    this._listeners.push(listener);

    try {
      while (true) {
        if (pending.length > 0) {
          yield pending.shift()!;
          continue;
        }

        if (this._done) break;

        const chunk = await new Promise<ExecChunk | null>((resolve) => {
          if (this._done) {
            resolve(null);
            return;
          }
          resolveNext = resolve;
        });

        if (chunk === null) break;
        yield chunk;
      }
    } finally {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    }

    await resultPromise;
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
