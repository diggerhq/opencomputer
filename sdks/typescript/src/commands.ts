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

export class Commands {
  constructor(
    private apiUrl: string,
    private apiKey: string,
    private sandboxId: string,
  ) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
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
}
