/**
 * Backends supported by the typed `creds` shape. For any backend not in this
 * list (or for advanced rclone tuning), pass `rcloneConfig` instead — the raw
 * string is dropped into the in-VM config file unchanged.
 */
export type MountBackend =
  | "s3"
  | "gcs"
  | "azureblob"
  | "sftp"
  | "webdav"
  | "dropbox";

export interface AddMountOpts {
  /** Absolute path inside the sandbox where the remote will be mounted. */
  path: string;
  /** rclone remote spec — `<name>:<path>` (e.g. `"s3:my-bucket/prefix"`). */
  remote: string;
  /**
   * Backend type. Determines how `creds` are templated into the rclone
   * config. Omit and pass `rcloneConfig` directly for backends not listed.
   */
  backend?: MountBackend;
  /**
   * Backend-specific credential / config keys (rclone config field names —
   * e.g. for S3: `access_key_id`, `secret_access_key`, `region`).
   *
   * Creds are written to a tmpfs file inside the VM (mode 0600) and never
   * persisted on the worker. v1 does not auto-restore mounts on hibernate —
   * re-call `mounts.add` after wake if you need the mount back.
   */
  creds?: Record<string, string>;
  /**
   * Raw rclone config to use verbatim. Overrides `backend`+`creds`. Useful
   * for backends not in the typed list, or for advanced tuning.
   */
  rcloneConfig?: string;
  /** Default `true`. Object-store FUSE mounts have well-known write footguns. */
  readOnly?: boolean;
  /** Extra args appended to `rclone mount` (e.g. `["--dir-cache-time", "1m"]`). */
  mountOptions?: string[];
}

export interface MountInfo {
  path: string;
  remote: string;
  backend?: string;
  readOnly: boolean;
  /**
   * rclone version inside the sandbox at the moment this mount was added
   * (e.g. `"v1.65.2"`). Captured for ops triage — rclone is baked into the
   * rootfs, so different sandboxes may carry different versions.
   */
  rcloneVersion?: string;
}

export class Mounts {
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

  /**
   * Mount a remote filesystem via rclone+FUSE inside the sandbox.
   *
   * @example
   * ```ts
   * await sandbox.mounts.add({
   *   path: "/mnt/data",
   *   remote: "s3:my-bucket",
   *   backend: "s3",
   *   creds: { access_key_id: "...", secret_access_key: "...", region: "us-east-1" },
   * });
   * ```
   */
  async add(opts: AddMountOpts): Promise<MountInfo> {
    const resp = await fetch(
      `${this.apiUrl}/sandboxes/${this.sandboxId}/mounts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify(opts),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to add mount: ${resp.status} ${text}`);
    }
    return resp.json();
  }

  /**
   * List the mounts this worker is tracking for the sandbox. Returns empty
   * after hibernate/wake — re-issue `add()` for any mounts you need back.
   */
  async list(): Promise<MountInfo[]> {
    const resp = await fetch(
      `${this.apiUrl}/sandboxes/${this.sandboxId}/mounts`,
      { headers: this.headers },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to list mounts: ${resp.status} ${text}`);
    }
    return resp.json();
  }

  /** Unmount a path previously passed to `add()`. No-op if not mounted. */
  async remove(path: string): Promise<void> {
    const resp = await fetch(
      `${this.apiUrl}/sandboxes/${this.sandboxId}/mounts?path=${encodeURIComponent(path)}`,
      { method: "DELETE", headers: this.headers },
    );
    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text();
      throw new Error(`Failed to remove mount: ${resp.status} ${text}`);
    }
  }
}
