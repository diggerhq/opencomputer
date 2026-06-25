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
    if (this.token) return { "Authorization": `Bearer ${this.token}` };
    return this.apiKey ? { "X-API-Key": this.apiKey } : {};
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
    const opts: RequestInit & Record<string, unknown> = {
      method: "PUT",
      headers: this.headers,
      body: content as BodyInit,
    };
    // duplex: "half" is required for ReadableStream bodies in Node.js fetch,
    // but must NOT be set for Uint8Array/Buffer/string bodies.
    const isStream = content instanceof ReadableStream;
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
