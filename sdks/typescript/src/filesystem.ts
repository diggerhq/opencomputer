export interface EntryInfo {
  name: string;
  isDir: boolean;
  path: string;
  size: number;
}

export class Filesystem {
  constructor(
    private apiUrl: string,
    private apiKey: string,
    private sandboxId: string,
    private token: string = "",
  ) {}

  private get headers(): Record<string, string> {
    // X-OSB-Async-Wake opts into the control plane's background-wake + 503
    // {waking} flow on a cold sandbox (wfetch retries it), instead of the inline
    // synchronous wake older SDKs get — which can hold the connection past the
    // edge's ~100s and 524. Harmless when the box is already warm.
    const h: Record<string, string> = { "X-OSB-Async-Wake": "1" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    else if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  // wfetch transparently rides out a cold-start wake. If the sandbox is
  // hibernated, the control plane wakes it in the background and returns
  // 503 { waking: true } immediately (rather than restoring on the connection
  // and risking a proxy 524). We retry until the box is up. Bounded so a wake
  // that can't complete eventually surfaces the 503 instead of hanging forever.
  private async wfetch(url: string, init?: RequestInit): Promise<Response> {
    const deadline = Date.now() + 120_000;
    let delay = 500;
    for (;;) {
      const resp = await fetch(url, init);
      if (resp.status !== 503) return resp;
      let waking = false;
      try { waking = (await resp.clone().json())?.waking === true; } catch { /* not JSON */ }
      if (!waking || Date.now() >= deadline) return resp;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 3000);
    }
  }

  async read(path: string): Promise<string> {
    const resp = await this.wfetch(
      `${this.apiUrl}/sandboxes/${this.sandboxId}/files?path=${encodeURIComponent(path)}`,
      { headers: this.headers },
    );
    if (!resp.ok) throw new Error(`Failed to read ${path}: ${resp.status}`);
    return resp.text();
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const resp = await this.wfetch(
      `${this.apiUrl}/sandboxes/${this.sandboxId}/files?path=${encodeURIComponent(path)}`,
      { headers: this.headers },
    );
    if (!resp.ok) throw new Error(`Failed to read ${path}: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  async write(path: string, content: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    const isStream = content instanceof ReadableStream;
    const headers = { ...this.headers };
    if (isStream) {
      // A stream body can't be replayed across a 503-waking retry, so opt out of
      // the async-wake flow (drop X-OSB-Async-Wake): on a cold box the control
      // plane wakes synchronously on this connection, as it did before, rather
      // than returning a 503 we couldn't retry.
      delete headers["X-OSB-Async-Wake"];
    }
    const opts: RequestInit & Record<string, unknown> = {
      method: "PUT",
      headers,
      body: content as BodyInit,
    };
    // duplex: "half" is required for ReadableStream bodies in Node.js fetch,
    // but must NOT be set for Uint8Array/Buffer/string bodies.
    if (isStream) {
      opts.duplex = "half";
    }
    const url = `${this.apiUrl}/sandboxes/${this.sandboxId}/files?path=${encodeURIComponent(path)}`;
    // A stream body can't be replayed across a wake retry; string/bytes can.
    const resp = isStream ? await fetch(url, opts) : await this.wfetch(url, opts);
    if (!resp.ok) throw new Error(`Failed to write ${path}: ${resp.status}`);
  }

  async list(path: string = "/"): Promise<EntryInfo[]> {
    const resp = await this.wfetch(
      `${this.apiUrl}/sandboxes/${this.sandboxId}/files/list?path=${encodeURIComponent(path)}`,
      { headers: this.headers },
    );
    if (!resp.ok) throw new Error(`Failed to list ${path}: ${resp.status}`);
    const data = await resp.json();
    return data ?? [];
  }

  async makeDir(path: string): Promise<void> {
    const resp = await this.wfetch(
      `${this.apiUrl}/sandboxes/${this.sandboxId}/files/mkdir?path=${encodeURIComponent(path)}`,
      { method: "POST", headers: this.headers },
    );
    if (!resp.ok) throw new Error(`Failed to mkdir ${path}: ${resp.status}`);
  }

  async remove(path: string): Promise<void> {
    const resp = await this.wfetch(
      `${this.apiUrl}/sandboxes/${this.sandboxId}/files?path=${encodeURIComponent(path)}`,
      { method: "DELETE", headers: this.headers },
    );
    if (!resp.ok) throw new Error(`Failed to remove ${path}: ${resp.status}`);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const resp = await this.wfetch(
        `${this.apiUrl}/sandboxes/${this.sandboxId}/files?path=${encodeURIComponent(path)}`,
        { headers: this.headers },
      );
      return resp.ok;
    } catch {
      return false;
    }
  }
}
