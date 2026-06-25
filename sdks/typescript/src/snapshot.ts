import { Image } from "./image.js";
import { parseSSEStream } from "./sse.js";

function resolveApiUrl(url: string): string {
  const base = url.replace(/\/+$/, "");
  return base.endsWith("/api") ? base : `${base}/api`;
}

export interface SnapshotInfo {
  id: string;
  orgId: string;
  name: string;
  contentHash: string;
  checkpointId: string;
  status: string;
  manifest: Record<string, unknown>;
  createdAt: string;
  lastUsedAt: string;
}

export interface CreateSnapshotOpts {
  name: string;
  image: Image;
  onBuildLogs?: (log: string) => void;
}

export interface SnapshotOpts {
  apiKey?: string;
  apiUrl?: string;
}

export interface WaitForReadyOpts {
  /** Abort the wait. */
  signal?: AbortSignal;
  /** Max time to wait before throwing, in milliseconds. */
  timeoutMs?: number;
  /** Initial poll interval in ms (default 1000, backs off to 5000). */
  pollIntervalMs?: number;
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

/**
 * Manage pre-built snapshots (named, persistent image checkpoints).
 */
export class Snapshots {
  private apiUrl: string;
  private apiKey: string;

  constructor(opts: SnapshotOpts = {}) {
    this.apiUrl = resolveApiUrl(
      opts.apiUrl ?? process.env.OPENCOMPUTER_API_URL ?? "https://app.opencomputer.dev"
    );
    this.apiKey = opts.apiKey ?? process.env.OPENCOMPUTER_API_KEY ?? "";
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  /**
   * Create a pre-built snapshot from a declarative image.
   * The server boots a sandbox, runs the image steps, checkpoints it, and stores it under the given name.
   */
  async create(opts: CreateSnapshotOpts): Promise<SnapshotInfo> {
    const headers: Record<string, string> = {
      ...this.headers,
      Accept: "text/event-stream",
    };

    const resp = await fetch(`${this.apiUrl}/snapshots`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: opts.name,
        image: opts.image.toJSON(),
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to create snapshot: ${resp.status} ${text}`);
    }

    if (resp.headers.get("content-type")?.includes("text/event-stream")) {
      const onLog = opts.onBuildLogs ?? (() => {});
      return parseSSEStream<SnapshotInfo>(resp, onLog);
    }

    return resp.json();
  }

  /**
   * List all named snapshots for the current org.
   */
  async list(): Promise<SnapshotInfo[]> {
    const resp = await fetch(`${this.apiUrl}/snapshots`, {
      headers: this.headers,
    });

    if (!resp.ok) {
      throw new Error(`Failed to list snapshots: ${resp.status}`);
    }

    return resp.json();
  }

  /**
   * Get a snapshot by name.
   */
  async get(name: string): Promise<SnapshotInfo> {
    const resp = await fetch(`${this.apiUrl}/snapshots/${encodeURIComponent(name)}`, {
      headers: this.headers,
    });

    if (!resp.ok) {
      throw new Error(`Failed to get snapshot: ${resp.status}`);
    }

    return resp.json();
  }

  /**
   * Poll a snapshot until its build reaches a terminal state, resolving with
   * the ready SnapshotInfo. Throws if the build fails or the wait times out.
   *
   * Useful when a snapshot was created via the async (non-SSE) endpoint, which
   * returns a `building` row immediately. The SSE `create()` already waits for
   * completion via the build-log stream, so this is not needed after it.
   *
   * Note: a still-building snapshot is not yet mirrored to the read store, so
   * `get()` 404s until it reaches a terminal state. We treat that 404 as
   * "still building" and keep polling; `failed` is mirrored, so it surfaces as
   * a thrown error rather than a poll-to-timeout.
   */
  async waitUntilReady(name: string, opts: WaitForReadyOpts = {}): Promise<SnapshotInfo> {
    const deadline = opts.timeoutMs != null ? Date.now() + opts.timeoutMs : null;
    let delay = opts.pollIntervalMs ?? 1000;
    const maxDelay = 5000;

    for (;;) {
      if (opts.signal?.aborted) {
        throw new Error(`waitUntilReady aborted for snapshot ${name}`);
      }
      if (deadline != null && Date.now() >= deadline) {
        throw new Error(`Snapshot ${name} not ready after ${opts.timeoutMs}ms`);
      }

      const resp = await fetch(`${this.apiUrl}/snapshots/${encodeURIComponent(name)}`, {
        headers: this.headers,
      });
      if (resp.ok) {
        const snap = (await resp.json()) as SnapshotInfo;
        if (snap.status === "ready") return snap;
        if (snap.status === "failed") throw new Error(`Snapshot ${name} build failed`);
        // any other status (e.g. "building") → keep polling
      } else if (resp.status !== 404) {
        // 404 = not yet mirrored (still building); anything else is a real error
        throw new Error(`Failed to get snapshot ${name}: ${resp.status}`);
      }

      await sleep(delay, opts.signal);
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  /**
   * Delete a named snapshot.
   */
  async delete(name: string): Promise<void> {
    const resp = await fetch(`${this.apiUrl}/snapshots/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: this.headers,
    });

    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Failed to delete snapshot: ${resp.status}`);
    }
  }
}
