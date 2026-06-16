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

/**
 * rclone-driver mount — the easy path. Wraps any of rclone's ~40 backends
 * behind a simple remote+creds shape.
 */
export interface RcloneMountOpts {
  /** Absolute path inside the sandbox where the remote will be mounted. */
  path: string;
  /** Driver. Defaults to `"rclone"`. */
  driver?: "rclone";
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
   * persisted on the worker.
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

/**
 * Command-driver mount — run your own FUSE daemon / mount command. Use this
 * when you already have a FUSE-ready filesystem (your own VFS, gcsfuse, s3fs,
 * …) and don't want rclone as a middle layer. The platform manages the
 * mountpoint, env/secret injection, and teardown; your command establishes the
 * mount.
 */
export interface CommandMountOpts {
  /** Absolute path inside the sandbox where the filesystem will be mounted. */
  path: string;
  driver: "command";
  /**
   * argv for the FUSE daemon / mount command. Any `"{mountpoint}"` token is
   * replaced with `path` (so you can template where the mount lands).
   * @example ["gcsfuse", "my-bucket", "{mountpoint}"]
   */
  command: string[];
  /** Env vars for the command. Returned by `list()`. */
  env?: Record<string, string>;
  /**
   * Secret env vars — injected into the daemon's process environment (never
   * the command line, so they don't leak via `ps`), and never recorded or
   * returned by `list()`.
   */
  secrets?: Record<string, string>;
  /**
   * Advisory for this driver — your command must honor it. Also exported to
   * the daemon as `OC_MOUNT_READONLY=1`. Default `true`.
   */
  readOnly?: boolean;
}

export type AddMountOpts = RcloneMountOpts | CommandMountOpts;

export interface MountInfo {
  path: string;
  driver: "rclone" | "command";
  readOnly: boolean;
  /** rclone driver: the remote spec. */
  remote?: string;
  /** rclone driver: the backend type. */
  backend?: string;
  /**
   * rclone driver: rclone version inside the sandbox at add time (e.g.
   * `"v1.65.2"`). Captured for ops triage — rclone is baked into the rootfs,
   * so different sandboxes may carry different versions.
   */
  rcloneVersion?: string;
  /** command driver: the resolved argv. */
  command?: string[];
  /** command driver: non-secret env vars (secrets are omitted). */
  env?: Record<string, string>;
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
   * Mount a filesystem inside the sandbox. Two drivers:
   *
   * - `rclone` (default): wrap any rclone backend behind remote+creds.
   * - `command`: run your own FUSE daemon / mount command.
   *
   * @example rclone driver
   * ```ts
   * await sandbox.mounts.add({
   *   path: "/mnt/data",
   *   remote: "s3:my-bucket",
   *   backend: "s3",
   *   creds: { access_key_id: "...", secret_access_key: "...", region: "us-east-1" },
   * });
   * ```
   *
   * @example command driver (bring your own FUSE)
   * ```ts
   * await sandbox.mounts.add({
   *   path: "/mnt/data",
   *   driver: "command",
   *   command: ["my-vfs-fuse", "--bucket", "gs://my-bucket", "{mountpoint}"],
   *   secrets: { GOOGLE_APPLICATION_CREDENTIALS_JSON: saJson },
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
