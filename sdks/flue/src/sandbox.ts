// ocSandbox — an optional Flue `SandboxApi`/`SandboxFactory` driving an OpenComputer fleet sandbox
// over its public HTTP API. Merely declaring the adapter does not allocate a machine: the first real
// shell/file operation resolves the session sandbox and all concurrent callers share that promise.
//
// The first real shell/file operation resolves (and, when needed, provisions) the persistent session
// sandbox through the control plane; this client then proxies exec/fs. Endpoints (from
// @opencomputer/sdk, all fetch-based so they run in a CF DO):
//   exec  POST {base}/sandboxes/{id}/exec/run   {args:["-c",cmd],cwd,envs,timeout}  -> {exitCode,stdout,stderr}
//   read  GET  {base}/sandboxes/{id}/files?path=
//   write PUT  {base}/sandboxes/{id}/files?path=   (body = content)
//   list  GET  {base}/sandboxes/{id}/files/list?path=   -> [{name,...}]
// stat/exists/mkdir/rm compose over exec (shell), mirroring cloudflareSandbox.

import { createSandboxSessionEnv } from "@flue/runtime";
import type {
  SandboxApi,
  SandboxFactory,
  FileStat,
  ShellResult,
  SessionEnv,
} from "@flue/runtime";
import type { OcEnv } from "./gateway.js";
import { ocResolveEnv } from "./cf-env.js";

/** Constant workspace cwd (matches the OC session contract — flue resolves skills at `${cwd}/.agents/skills`). */
export const WORKSPACE_CWD = "/workspace";

export interface OcSandboxEnv extends OcEnv {
  /** OC sandbox API base, e.g. `https://api.opencomputer.dev`. */
  OC_SANDBOX_API?: string;
  /** Pre-resolved sandbox id, when the control plane injects it; else resolved lazily (see below). */
  OC_SANDBOX_ID?: string;
}

class OcSandboxApi implements SandboxApi {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private sandboxId: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }
  private url(suffix: string): string {
    return `${this.base.replace(/\/+$/, "")}/sandboxes/${this.sandboxId}${suffix}`;
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<ShellResult> {
    const body: Record<string, unknown> = {
      args: ["-c", command],
      timeout: Math.ceil((options?.timeoutMs ?? 60_000) / 1000),
    };
    if (options?.cwd) body.cwd = options.cwd;
    if (options?.env) body.envs = options.env;
    const resp = await fetch(this.url("/exec/run"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!resp.ok)
      throw new Error(
        `oc sandbox exec failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`,
      );
    const r = (await resp.json()) as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? 0,
    };
  }

  async readFile(path: string): Promise<string> {
    const resp = await fetch(
      this.url(`/files?path=${encodeURIComponent(path)}`),
      { headers: this.headers() },
    );
    if (!resp.ok) throw new Error(`oc sandbox read ${path}: ${resp.status}`);
    return resp.text();
  }
  async readFileBuffer(path: string): Promise<Uint8Array> {
    const resp = await fetch(
      this.url(`/files?path=${encodeURIComponent(path)}`),
      { headers: this.headers() },
    );
    if (!resp.ok) throw new Error(`oc sandbox read ${path}: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const resp = await fetch(
      this.url(`/files?path=${encodeURIComponent(path)}`),
      {
        method: "PUT",
        headers: this.headers({ "content-type": "application/octet-stream" }),
        body: content,
      },
    );
    if (!resp.ok) throw new Error(`oc sandbox write ${path}: ${resp.status}`);
  }
  async readdir(path: string): Promise<string[]> {
    const resp = await fetch(
      this.url(`/files/list?path=${encodeURIComponent(path)}`),
      { headers: this.headers() },
    );
    if (!resp.ok) throw new Error(`oc sandbox list ${path}: ${resp.status}`);
    const entries = (await resp.json()) as Array<{
      name?: string;
      path?: string;
    }>;
    return entries
      .map((e) => e.name ?? (e.path ?? "").split("/").pop() ?? "")
      .filter(Boolean);
  }

  // stat/exists/mkdir/rm over the shell (mirrors cloudflareSandbox — the files API has no stat/mkdir/rm).
  async stat(path: string): Promise<FileStat> {
    const r = await this.exec(`stat -L -c '%s/%F' ${shq(path)}`);
    if (r.exitCode !== 0)
      throw new Error(`oc sandbox stat ${path}: ${r.stderr.slice(0, 120)}`);
    const [sizeStr, kind = ""] = r.stdout.trim().split("/");
    return {
      isFile: /regular file/.test(kind),
      isDirectory: /directory/.test(kind),
      size: Number(sizeStr) || undefined,
    };
  }
  async exists(path: string): Promise<boolean> {
    return (await this.exec(`test -e ${shq(path)}`)).exitCode === 0;
  }
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const r = await this.exec(
      `mkdir ${options?.recursive ? "-p " : ""}${shq(path)}`,
    );
    if (r.exitCode !== 0)
      throw new Error(`oc sandbox mkdir ${path}: ${r.stderr.slice(0, 120)}`);
  }
  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    const flags = `${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`;
    const r = await this.exec(`rm ${flags ? `-${flags} ` : ""}${shq(path)}`);
    if (r.exitCode !== 0 && !options?.force)
      throw new Error(`oc sandbox rm ${path}: ${r.stderr.slice(0, 120)}`);
  }
}

/**
 * Flue discovers workspace context while initializing every harness. OC does not materialize repo
 * sources for Flue sessions yet, and a newly allocated sandbox is empty, so those fixed bootstrap
 * probes must not turn a model-only turn into a machine allocation. Any operation outside the exact
 * discovery sequence falls through to the real remote environment.
 */
class LazyOcSandboxApi implements SandboxApi {
  private bootstrapping = true;
  private readonly bootstrapAbsent: Set<string>;

  constructor(
    private readonly cwd: string,
    private readonly load: () => Promise<SandboxApi>,
  ) {
    this.bootstrapAbsent = new Set([
      `${cwd}/AGENTS.md`,
      `${cwd}/CLAUDE.md`,
      `${cwd}/.agents/skills`,
    ]);
  }

  private remote(): Promise<SandboxApi> {
    this.bootstrapping = false;
    return this.load();
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<ShellResult> {
    return (await this.remote()).exec(command, options);
  }
  async readFile(path: string): Promise<string> {
    return (await this.remote()).readFile(path);
  }
  async readFileBuffer(path: string): Promise<Uint8Array> {
    return (await this.remote()).readFileBuffer(path);
  }
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    return (await this.remote()).writeFile(path, content);
  }
  async stat(path: string): Promise<FileStat> {
    return (await this.remote()).stat(path);
  }
  async readdir(path: string): Promise<string[]> {
    if (this.bootstrapping && path === this.cwd) {
      this.bootstrapping = false;
      return [];
    }
    return (await this.remote()).readdir(path);
  }
  async exists(path: string): Promise<boolean> {
    if (this.bootstrapping && this.bootstrapAbsent.has(path)) return false;
    return (await this.remote()).exists(path);
  }
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return (await this.remote()).mkdir(path, options);
  }
  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    return (await this.remote()).rm(path, options);
  }
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Resolve the session's OC sandbox id (control-plane seam). Uses the injected id when present, else a
 *  documented resolve endpoint keyed by the session id. Kept a single point so W1/W5 can pin the contract. */
async function resolveSandboxId(
  env: OcSandboxEnv,
  sessionId: string,
): Promise<string> {
  if (env.OC_SANDBOX_ID) return env.OC_SANDBOX_ID;
  const base = (env.OC_SANDBOX_API ?? "").replace(/\/+$/, "");
  const resp = await fetch(
    `${base}/flue/session-sandbox?session=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.OC_SESSION_TOKEN ?? ""}` },
    },
  );
  if (!resp.ok)
    throw new Error(
      `oc sandbox resolve failed for ${sessionId}: ${resp.status}`,
    );
  const sandboxId = ((await resp.json()) as { sandbox_id?: unknown })
    .sandbox_id;
  if (typeof sandboxId !== "string" || !sandboxId) {
    throw new Error(
      `oc sandbox resolve failed for ${sessionId}: response has no sandbox_id`,
    );
  }
  return sandboxId;
}

/**
 * The optional OC-fleet sandbox factory. Add `sandbox: ocSandbox(env)` only when an agent needs a
 * Linux shell or durable files. The default starter intentionally omits it.
 *
 * Resolves the captured runtime env lazily and layers in plain bindings from the CF ambient env
 * (`cloudflare:workers`). The request-time `OC_SESSION_TOKEN` remains on the captured env proxy and is
 * read directly; that proxy is never spread or enumerated. `createSessionEnv` validates local
 * configuration and returns a lazy environment without fetching or provisioning anything.
 */
export function ocSandbox(
  env: OcSandboxEnv,
  opts?: { cwd?: string },
): SandboxFactory {
  const cwd = opts?.cwd ?? WORKSPACE_CWD;
  const remoteBySession = new Map<string, Promise<SandboxApi>>();
  return {
    async createSessionEnv({ id }: { id: string }): Promise<SessionEnv> {
      const resolved = ocResolveEnv<OcSandboxEnv>(env);
      if (!resolved.OC_SANDBOX_API) {
        throw new Error(
          "[oc-flue] ocSandbox: OC_SANDBOX_API is required for sandbox operations.",
        );
      }
      const load = (): Promise<SandboxApi> => {
        const existing = remoteBySession.get(id);
        if (existing) return existing;
        const pending = (async () => {
          const sandboxId = await resolveSandboxId(resolved, id);
          return new OcSandboxApi(
            (resolved.OC_SANDBOX_API ?? "").replace(/\/+$/, ""),
            resolved.OC_SESSION_TOKEN ?? "",
            sandboxId,
          );
        })();
        remoteBySession.set(id, pending);
        void pending.catch(() => {
          if (remoteBySession.get(id) === pending) remoteBySession.delete(id);
        });
        return pending;
      };
      return createSandboxSessionEnv(new LazyOcSandboxApi(cwd, load), cwd);
    },
  };
}
