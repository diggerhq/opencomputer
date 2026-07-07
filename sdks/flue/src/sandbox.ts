// ocSandbox — a Flue `SandboxApi`/`SandboxFactory` (design 013 §5) driving an OpenComputer fleet sandbox
// over its public HTTP API, so the workspace is DURABLE across turns (git checkout + build cache survive)
// and also serves the repo plane (§5.2). Public-seam impl, no trick.
//
// The session's sandbox is provisioned by the control plane at Flue-session create (§5.2); this client
// resolves it per instance and proxies exec/fs. Endpoints (from @opencomputer/sdk, all fetch-based so
// they run in a CF DO):
//   exec  POST {base}/sandboxes/{id}/exec/run   {args:["-c",cmd],cwd,envs,timeout}  -> {exitCode,stdout,stderr}
//   read  GET  {base}/sandboxes/{id}/files?path=
//   write PUT  {base}/sandboxes/{id}/files?path=   (body = content)
//   list  GET  {base}/sandboxes/{id}/files/list?path=   -> [{name,...}]
// stat/exists/mkdir/rm compose over exec (shell), mirroring cloudflareSandbox.

import { createSandboxSessionEnv } from "@flue/runtime";
import type { SandboxApi, SandboxFactory, FileStat, ShellResult, SessionEnv } from "@flue/runtime";
import type { OcEnv } from "./gateway.js";
import { ocResolveEnv } from "./cf-env.js";

/** Constant workspace cwd (matches the OC session contract — flue resolves skills at `${cwd}/.agents/skills`). */
export const WORKSPACE_CWD = "/workspace";

export interface OcSandboxEnv extends OcEnv {
  /** OC sandbox API base, e.g. `https://app.opencomputer.dev/api`. */
  OC_SANDBOX_API?: string;
  /** Pre-resolved sandbox id, when the control plane injects it; else resolved lazily (see below). */
  OC_SANDBOX_ID?: string;
}

class OcSandboxApi implements SandboxApi {
  constructor(private readonly base: string, private readonly token: string, private sandboxId: string) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }
  private url(suffix: string): string {
    return `${this.base.replace(/\/+$/, "")}/sandboxes/${this.sandboxId}${suffix}`;
  }

  async exec(command: string, options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }): Promise<ShellResult> {
    const body: Record<string, unknown> = { args: ["-c", command], timeout: Math.ceil((options?.timeoutMs ?? 60_000) / 1000) };
    if (options?.cwd) body.cwd = options.cwd;
    if (options?.env) body.envs = options.env;
    const resp = await fetch(this.url("/exec/run"), { method: "POST", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify(body), signal: options?.signal });
    if (!resp.ok) throw new Error(`oc sandbox exec failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const r = (await resp.json()) as { exitCode?: number; stdout?: string; stderr?: string };
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  }

  async readFile(path: string): Promise<string> {
    const resp = await fetch(this.url(`/files?path=${encodeURIComponent(path)}`), { headers: this.headers() });
    if (!resp.ok) throw new Error(`oc sandbox read ${path}: ${resp.status}`);
    return resp.text();
  }
  async readFileBuffer(path: string): Promise<Uint8Array> {
    const resp = await fetch(this.url(`/files?path=${encodeURIComponent(path)}`), { headers: this.headers() });
    if (!resp.ok) throw new Error(`oc sandbox read ${path}: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const resp = await fetch(this.url(`/files?path=${encodeURIComponent(path)}`), { method: "PUT", headers: this.headers({ "content-type": "application/octet-stream" }), body: content });
    if (!resp.ok) throw new Error(`oc sandbox write ${path}: ${resp.status}`);
  }
  async readdir(path: string): Promise<string[]> {
    const resp = await fetch(this.url(`/files/list?path=${encodeURIComponent(path)}`), { headers: this.headers() });
    if (!resp.ok) throw new Error(`oc sandbox list ${path}: ${resp.status}`);
    const entries = (await resp.json()) as Array<{ name?: string; path?: string }>;
    return entries.map((e) => e.name ?? (e.path ?? "").split("/").pop() ?? "").filter(Boolean);
  }

  // stat/exists/mkdir/rm over the shell (mirrors cloudflareSandbox — the files API has no stat/mkdir/rm).
  async stat(path: string): Promise<FileStat> {
    const r = await this.exec(`stat -L -c '%s/%F' ${shq(path)}`);
    if (r.exitCode !== 0) throw new Error(`oc sandbox stat ${path}: ${r.stderr.slice(0, 120)}`);
    const [sizeStr, kind = ""] = r.stdout.trim().split("/");
    return { isFile: /regular file/.test(kind), isDirectory: /directory/.test(kind), size: Number(sizeStr) || undefined };
  }
  async exists(path: string): Promise<boolean> {
    return (await this.exec(`test -e ${shq(path)}`)).exitCode === 0;
  }
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const r = await this.exec(`mkdir ${options?.recursive ? "-p " : ""}${shq(path)}`);
    if (r.exitCode !== 0) throw new Error(`oc sandbox mkdir ${path}: ${r.stderr.slice(0, 120)}`);
  }
  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const flags = `${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`;
    const r = await this.exec(`rm ${flags ? `-${flags} ` : ""}${shq(path)}`);
    if (r.exitCode !== 0 && !options?.force) throw new Error(`oc sandbox rm ${path}: ${r.stderr.slice(0, 120)}`);
  }
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Resolve the session's OC sandbox id (control-plane seam). Uses the injected id when present, else a
 *  documented resolve endpoint keyed by the session id. Kept a single point so W1/W5 can pin the contract. */
async function resolveSandboxId(env: OcSandboxEnv, sessionId: string): Promise<string> {
  if (env.OC_SANDBOX_ID) return env.OC_SANDBOX_ID;
  const base = (env.OC_SANDBOX_API ?? "").replace(/\/+$/, "");
  const resp = await fetch(`${base}/flue/session-sandbox?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OC_SESSION_TOKEN ?? ""}` },
  });
  if (!resp.ok) throw new Error(`oc sandbox resolve failed for ${sessionId}: ${resp.status}`);
  return ((await resp.json()) as { sandbox_id: string }).sandbox_id;
}

/**
 * The OC-fleet sandbox factory. Set `sandbox: ocSandbox(env)` in your `defineAgent` initializer; the OC
 * template scaffolds exactly this. Lazily resolves the session's sandbox (keyed by the DO instance id =
 * `ses_`) on first tool use, so no sandbox is provisioned for tool-free turns (§5).
 *
 * Reads the CF ambient env (`cloudflare:workers`), not the passed `ctx.env`: on the `--target
 * cloudflare` build the real `OC_SANDBOX_*`/`OC_SESSION_TOKEN` bindings live on the ambient env and
 * `ctx.env` is empty for them (same reason as `useOcGateway`). The resolution happens lazily inside
 * `createSessionEnv`, so a tool-free turn never touches the sandbox config.
 */
export function ocSandbox(env: OcSandboxEnv, opts?: { cwd?: string }): SandboxFactory {
  const cwd = opts?.cwd ?? WORKSPACE_CWD;
  return {
    async createSessionEnv({ id }: { id: string }): Promise<SessionEnv> {
      const resolved = ocResolveEnv<OcSandboxEnv>(env);
      if (!resolved.OC_SANDBOX_API && !resolved.OC_SANDBOX_ID) {
        throw new Error("[oc-flue] ocSandbox: set OC_SANDBOX_API (+ OC_SESSION_TOKEN) or OC_SANDBOX_ID — the OC sandbox binding is not configured.");
      }
      const sandboxId = await resolveSandboxId(resolved, id);
      const api = new OcSandboxApi((resolved.OC_SANDBOX_API ?? "").replace(/\/+$/, ""), resolved.OC_SESSION_TOKEN ?? "", sandboxId);
      return createSandboxSessionEnv(api, cwd);
    },
  };
}
