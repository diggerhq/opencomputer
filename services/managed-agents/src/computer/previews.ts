// Preview URLs, the computer object's side (work 074): the organization's
// Cloudflare Tunnel and the names that point at its ports.
//
// One tunnel per organization, created on the first hello of its host (or
// the first `preview` call) and kept for the organization's life: a park, a
// wake, a reset or a warm-pool claim changes the VM, never the tunnel, so the
// names stay valid across all of them. A pool computer has none; the
// organization's object provisions it once the claimed host says hello.
//
// The tunnel is remotely managed (`config_src: cloudflare`): its one ingress
// rule sends `<tunnelId>.t.opencomputer.app` to the host proxy on
// 127.0.0.1:7070, and the host runs `cloudflared tunnel run` with the token
// alone. Names live in their own PreviewDurableObject (src/previews), the
// public source of truth; the `previews` table here is this computer's copy,
// for the host proxy's port allow-list, the 50-name limit and Wake.
//
// Work 084: the same tunnel gains a second hostname, `<tunnelId>.w.opencomputer.dev`,
// for the wire (the relay on 127.0.0.1:7071, paths `/connect` and `/files`
// only), so the wire never shares a hostname with users' artifacts. It is on
// when WIRE_CF_ZONE_ID is set, and applied to existing tunnels on the next
// `ensureTunnel` (the host's hello).

import { previewKey } from "../previews/auth.js";
import { PREVIEW_DOMAIN, generatePreviewName, validPreviewName } from "../previews/names.js";
import { type PreviewClaim, type PreviewClaimResult, validPreviewPort } from "../previews/registry.js";
import { DEFAULT_WIRE_TUNNEL_DOMAIN } from "./config.js";
import type { CalvinGatewayToHost, CalvinPreviewConfig, CalvinPreviewRequest, CalvinPreviewResult } from "./protocol.js";

/** Names one organization may hold at once. */
export const PREVIEW_NAME_LIMIT = 50;
/** Wakes from a preview's Wake button, per computer, per PREVIEW_WAKE_WINDOW_MS. */
export const PREVIEW_WAKE_LIMIT = 6;
export const PREVIEW_WAKE_WINDOW_MS = 3600_000;
/** Generated names tried before giving up (34 bits each: a collision is already rare). */
const GENERATE_ATTEMPTS = 3;
const HOST_PROXY = "http://127.0.0.1:7070";
/** The relay (calvin src/wire), behind the tunnel's wire hostname. */
const WIRE_RELAY = "http://127.0.0.1:7071";
/** The only paths the wire hostname forwards. */
export const WIRE_INGRESS_PATH = "^/(connect|files)(/|$)";

export interface PreviewsEnv {
  /** The `previews` Worker's PreviewDurableObject namespace, bound by script name. */
  PREVIEWS?: { getByName(name: string): PreviewNameRegistry };
  /** Shared with the `previews` Worker; derives each computer's key. A secret. */
  PREVIEW_PLATFORM_KEY?: string;
  /** Cloudflare API token: Account › Cloudflare Tunnel › Edit, Zone › DNS › Edit on the preview zone. A secret. */
  PREVIEW_CF_API_TOKEN?: string;
  PREVIEW_CF_ACCOUNT_ID?: string;
  PREVIEW_CF_ZONE_ID?: string;
  PREVIEW_DOMAIN?: string;
  /** Where the tunnels' hostnames live; `t.<PREVIEW_DOMAIN>` unless set. */
  PREVIEW_TUNNEL_DOMAIN?: string;
  BLUE_ENVIRONMENT?: string;
  /** Work 084: where the tunnels' wire hostnames live; `w.opencomputer.dev` unless set. */
  WIRE_TUNNEL_DOMAIN?: string;
  /** Work 084: the zone of WIRE_TUNNEL_DOMAIN. Unset: the tunnel has no wire hostname. */
  WIRE_CF_ZONE_ID?: string;
}

/** What the computer object uses of a PreviewDurableObject. */
export interface PreviewNameRegistry {
  claim(name: string, claim: PreviewClaim): Promise<PreviewClaimResult>;
  release(organizationId: string): Promise<boolean>;
}

export interface PreviewsConfig {
  apiToken: string;
  accountId: string;
  zoneId: string;
  platformKey: string;
  domain: string;
  tunnelDomain: string;
  environment: string;
  /** Work 084: the tunnel's wire hostname's zone and domain; null: none. */
  wire: { zoneId: string; tunnelDomain: string } | null;
}

/** Null unless every setting and the PREVIEWS binding are there: the feature is off. */
export function previewsConfig(env: PreviewsEnv): PreviewsConfig | null {
  if (!env.PREVIEWS || !env.PREVIEW_PLATFORM_KEY || !env.PREVIEW_CF_API_TOKEN || !env.PREVIEW_CF_ACCOUNT_ID || !env.PREVIEW_CF_ZONE_ID) {
    return null;
  }
  const domain = env.PREVIEW_DOMAIN || PREVIEW_DOMAIN;
  return {
    apiToken: env.PREVIEW_CF_API_TOKEN,
    accountId: env.PREVIEW_CF_ACCOUNT_ID,
    zoneId: env.PREVIEW_CF_ZONE_ID,
    platformKey: env.PREVIEW_PLATFORM_KEY,
    domain,
    tunnelDomain: env.PREVIEW_TUNNEL_DOMAIN || `t.${domain}`,
    environment: env.BLUE_ENVIRONMENT || "development",
    wire: env.WIRE_CF_ZONE_ID ? { zoneId: env.WIRE_CF_ZONE_ID, tunnelDomain: env.WIRE_TUNNEL_DOMAIN || DEFAULT_WIRE_TUNNEL_DOMAIN } : null,
  };
}

/** The tunnel's wire hostname under `config`, or null when the wire is off. */
export function wireHostname(config: PreviewsConfig, tunnelId: string): string | null {
  return config.wire ? `${tunnelId}.${config.wire.tunnelDomain}` : null;
}

/**
 * The computer's wire key, `welcome.wire.key`: the same value as its preview
 * key, b64u(HMAC-SHA256(PREVIEW_PLATFORM_KEY, tunnelId)). Null without the platform key.
 */
export async function wireKeyFor(env: Pick<PreviewsEnv, "PREVIEW_PLATFORM_KEY">, tunnelId: string): Promise<string | null> {
  return env.PREVIEW_PLATFORM_KEY ? previewKey(env.PREVIEW_PLATFORM_KEY, tunnelId) : null;
}

export interface ProvisionedTunnel {
  tunnelId: string;
  token: string;
}

export interface TunnelApi {
  /** Finds or creates the named tunnel, points its ingress and DNS records at the host proxy (and the relay); idempotent. */
  ensure(name: string): Promise<ProvisionedTunnel>;
}

/** The Cloudflare API calls that make an organization's tunnel. */
export class CloudflareTunnels implements TunnelApi {
  constructor(
    private readonly config: PreviewsConfig,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async ensure(name: string): Promise<ProvisionedTunnel> {
    const account = `/accounts/${this.config.accountId}/cfd_tunnel`;
    const found = await this.api<{ id: string }[]>("GET", `${account}?name=${encodeURIComponent(name)}&is_deleted=false`);
    const tunnelId = found[0]?.id ?? (await this.api<{ id: string }>("POST", account, { name, config_src: "cloudflare" })).id;
    const hostname = `${tunnelId}.${this.config.tunnelDomain}`;
    const wire = wireHostname(this.config, tunnelId);
    await this.api("PUT", `${account}/${tunnelId}/configurations`, {
      config: {
        ingress: [
          { hostname, service: HOST_PROXY },
          ...(wire ? [{ hostname: wire, path: WIRE_INGRESS_PATH, service: WIRE_RELAY }] : []),
          { service: "http_status:404" },
        ],
      },
    });
    await this.dnsRecord(this.config.zoneId, hostname, tunnelId, "OpenComputer preview tunnel");
    if (wire) await this.dnsRecord(this.config.wire!.zoneId, wire, tunnelId, "OpenComputer wire tunnel");
    const token = await this.api<string>("GET", `${account}/${tunnelId}/token`);
    return { tunnelId, token };
  }

  /** Points `hostname` (a CNAME in `zoneId`) at the tunnel; creates or updates. */
  private async dnsRecord(zoneId: string, hostname: string, tunnelId: string, comment: string): Promise<void> {
    const zone = `/zones/${zoneId}/dns_records`;
    const records = await this.api<{ id: string }[]>("GET", `${zone}?type=CNAME&name=${encodeURIComponent(hostname)}`);
    const record = { type: "CNAME", name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied: true, comment };
    if (records[0]) await this.api("PUT", `${zone}/${records[0].id}`, record);
    else await this.api("POST", zone, record);
  }

  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${this.config.apiToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] } | null;
    if (!response.ok || !payload?.success) {
      const errors = payload?.errors?.map((error) => `${error.code} ${error.message}`).join("; ");
      throw new Error(`Cloudflare API ${method} ${path.split("?")[0]}: ${response.status}${errors ? ` (${errors})` : ""}`);
    }
    return payload.result as T;
  }
}

export interface ComputerPreviewsDeps {
  sql: SqlStorage;
  env: PreviewsEnv;
  organizationId: () => string;
  /** Seal and unseal the tunnel token (crypto.ts, purpose `tunnel-token`). */
  seal: (value: string, context: string) => Promise<string>;
  unseal: (sealed: string, context: string) => Promise<string>;
  send: (command: CalvinGatewayToHost) => boolean;
  tunnels?: (config: PreviewsConfig) => TunnelApi;
  now?: () => number;
  generateName?: () => string;
}

type TunnelRow = {
  tunnelId: string;
  token: string;
  /** Work 084: the wire hostname last applied to the tunnel; null: none. */
  wireHost: string | null;
  wakeWindowStart: number;
  wakes: number;
};

type PreviewRow = {
  name: string;
  port: number;
};

export class ComputerPreviews {
  private readonly now: () => number;
  /** Registrations run one at a time: each awaits RPCs, and two must not both pass the limit or take one port. */
  private queue: Promise<unknown> = Promise.resolve();
  private provisioning?: Promise<boolean>;

  constructor(private readonly deps: ComputerPreviewsDeps) {
    this.now = deps.now ?? Date.now;
    deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS preview_tunnel (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tunnel_id TEXT NOT NULL,
        token TEXT NOT NULL,
        wake_window_start INTEGER NOT NULL DEFAULT 0,
        wakes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        wire_host TEXT
      );
      CREATE TABLE IF NOT EXISTS previews (
        name TEXT PRIMARY KEY,
        port INTEGER NOT NULL UNIQUE,
        session TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const columns = [...deps.sql.exec<{ name: string }>("PRAGMA table_info(preview_tunnel)")].map((column) => column.name);
    if (!columns.includes("wire_host")) deps.sql.exec("ALTER TABLE preview_tunnel ADD COLUMN wire_host TEXT");
  }

  config(): PreviewsConfig | null {
    return previewsConfig(this.deps.env);
  }

  private tunnel(): TunnelRow | undefined {
    return [
      ...this.deps.sql.exec<TunnelRow>(
        "SELECT tunnel_id AS tunnelId, token, wire_host AS wireHost, wake_window_start AS wakeWindowStart, wakes FROM preview_tunnel WHERE id = 1",
      ),
    ][0];
  }

  /** Work 084: the organization's tunnel id (the wire's records and tickets name it), or null before it has one. */
  tunnelId(): string | null {
    return this.tunnel()?.tunnelId ?? null;
  }

  private rows(): PreviewRow[] {
    return [...this.deps.sql.exec<PreviewRow>("SELECT name, port FROM previews ORDER BY port")];
  }

  private byPort(port: number): PreviewRow | undefined {
    return [...this.deps.sql.exec<PreviewRow>("SELECT name, port FROM previews WHERE port = ?", port)][0];
  }

  private byName(name: string): PreviewRow | undefined {
    return [...this.deps.sql.exec<PreviewRow>("SELECT name, port FROM previews WHERE name = ?", name)][0];
  }

  registered(name: string): boolean {
    return this.byName(name) !== undefined;
  }

  /** What the host needs for `welcome` and `previews`; null while the feature is off or the tunnel not made. */
  async hostConfig(): Promise<CalvinPreviewConfig | null> {
    const config = this.config();
    const tunnel = this.tunnel();
    if (!config || !tunnel) return null;
    return {
      tunnelToken: await this.deps.unseal(tunnel.token, this.tokenContext(tunnel.tunnelId)),
      key: await previewKey(config.platformKey, tunnel.tunnelId),
      ports: this.rows().map((row) => row.port),
    };
  }

  /**
   * Makes the organization's tunnel if it has none; single-flight. Sends the
   * host its config once made. False when the feature is off or Cloudflare
   * failed (logged); the next hello or `preview` call tries again.
   *
   * Work 084: an existing tunnel whose wire hostname is not the configured
   * one is re-applied (ingress and DNS, idempotent); it stays usable for
   * previews meanwhile, so this answers true either way.
   */
  ensureTunnel(): Promise<boolean> {
    const tunnel = this.tunnel();
    const config = this.config();
    if (tunnel && (!config || tunnel.wireHost === wireHostname(config, tunnel.tunnelId))) return Promise.resolve(true);
    if (!config) return Promise.resolve(false);
    this.provisioning ??= this.provision(config).finally(() => {
      this.provisioning = undefined;
    });
    return tunnel ? this.provisioning.then(() => true) : this.provisioning;
  }

  private async provision(config: PreviewsConfig): Promise<boolean> {
    const started = this.now();
    const organizationId = this.deps.organizationId();
    try {
      const api = this.deps.tunnels?.(config) ?? new CloudflareTunnels(config);
      const { tunnelId, token } = await api.ensure(await tunnelName(config.environment, organizationId));
      const sealed = await this.deps.seal(token, this.tokenContext(tunnelId));
      this.deps.sql.exec(
        `INSERT INTO preview_tunnel (id, tunnel_id, token, wire_host, created_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET tunnel_id = excluded.tunnel_id, token = excluded.token, wire_host = excluded.wire_host`,
        tunnelId,
        sealed,
        wireHostname(config, tunnelId),
        this.now(),
      );
      const wireHost = wireHostname(config, tunnelId);
      console.log(JSON.stringify({ level: "info", event: "computer.preview_tunnel_ready", accountId: organizationId, tunnelId, wireHost, ms: this.now() - started }));
      await this.push();
      return true;
    } catch (error) {
      console.error(
        JSON.stringify({ level: "error", event: "computer.preview_tunnel_failed", accountId: organizationId, message: error instanceof Error ? error.message : String(error) }),
      );
      return false;
    }
  }

  /** Registers a port's public name (the `preview` tool); answers with a sentence for the model on failure. */
  register(session: string, req: CalvinPreviewRequest): Promise<CalvinPreviewResult> {
    return this.serially(() => this.registerNow(session, req));
  }

  /** Releases a name this computer holds (the `unpreview` tool). */
  unregister(name: string): Promise<CalvinPreviewResult> {
    return this.serially(async () => {
      const wanted = name.trim().toLowerCase();
      const row = this.byName(wanted);
      if (!row) throw new Error(`No preview named ${wanted} on this computer.`);
      await this.names().getByName(row.name).release(this.deps.organizationId());
      this.deps.sql.exec("DELETE FROM previews WHERE name = ?", row.name);
      await this.push();
      return { url: "", name: row.name, port: 0 };
    });
  }

  /** One more wake from a preview, unless this computer had PREVIEW_WAKE_LIMIT in the window. */
  allowWake(): boolean {
    const tunnel = this.tunnel();
    if (!tunnel) return false;
    const now = this.now();
    if (now - tunnel.wakeWindowStart >= PREVIEW_WAKE_WINDOW_MS) {
      this.deps.sql.exec("UPDATE preview_tunnel SET wake_window_start = ?, wakes = 1 WHERE id = 1", now);
      return true;
    }
    if (tunnel.wakes >= PREVIEW_WAKE_LIMIT) return false;
    this.deps.sql.exec("UPDATE preview_tunnel SET wakes = wakes + 1 WHERE id = 1");
    return true;
  }

  private async registerNow(session: string, req: CalvinPreviewRequest): Promise<CalvinPreviewResult> {
    const config = this.config();
    if (!config) throw new Error("Preview URLs are not available on this computer.");
    const port = Number(req.port);
    if (!validPreviewPort(port)) throw new Error(`Port ${req.port} cannot be previewed: use a port from 1024 to 65535, other than 7070.`);
    if (!(await this.ensureTunnel())) throw new Error("Preview URLs are still being set up on this computer; try again in a minute.");
    const tunnelId = this.tunnel()!.tunnelId;
    const existing = this.byPort(port);
    const claim: PreviewClaim = { organizationId: this.deps.organizationId(), tunnelId, port, createdBy: session };

    let name: string;
    if (req.name !== undefined) {
      name = req.name.trim().toLowerCase();
      if (!validPreviewName(name)) {
        throw new Error(`${req.name} cannot be a preview name: use up to 63 lowercase letters, digits and single hyphens, not starting or ending with a hyphen, and not a reserved word.`);
      }
      if (existing?.name === name) return this.result(config, existing);
      // A pasted link is never silently killed (decision 6): renaming is unpreview, then preview.
      if (existing) {
        throw new Error(`Port ${port} already has ${this.result(config, existing).url}; unpreview ${existing.name} first to give it another name.`);
      }
      if (!this.byName(name)) this.checkLimit();
      const outcome = await this.names().getByName(name).claim(name, claim);
      if (!outcome.ok) throw new Error(claimError(name, outcome.error));
    } else {
      if (existing) return this.result(config, existing);
      this.checkLimit();
      name = await this.claimGenerated(claim);
    }

    // A name this computer holds may have pointed at another port: it moves.
    this.deps.sql.exec("DELETE FROM previews WHERE name = ?", name);
    this.deps.sql.exec("INSERT INTO previews (name, port, session, created_at) VALUES (?, ?, ?, ?)", name, port, session, this.now());
    await this.push();
    return this.result(config, { name, port });
  }

  private async claimGenerated(claim: PreviewClaim): Promise<string> {
    for (let attempt = 0; attempt < GENERATE_ATTEMPTS; attempt++) {
      const name = (this.deps.generateName ?? generatePreviewName)();
      const outcome = await this.names().getByName(name).claim(name, claim);
      if (outcome.ok) return name;
      if (outcome.error !== "name_taken" && outcome.error !== "denied") throw new Error(claimError(name, outcome.error));
    }
    throw new Error("Could not find a free preview name; try again.");
  }

  private checkLimit(): void {
    const count = [...this.deps.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM previews")][0]?.n ?? 0;
    if (count >= PREVIEW_NAME_LIMIT) {
      throw new Error(`This computer already has ${PREVIEW_NAME_LIMIT} preview URLs; release one with unpreview first.`);
    }
  }

  /** The host's allow-list changed: it hears before the tool's answer, so the URL works when the model gets it. */
  private async push(): Promise<void> {
    const preview = await this.hostConfig();
    if (preview) this.deps.send({ t: "previews", preview });
  }

  private result(config: PreviewsConfig, row: PreviewRow): CalvinPreviewResult {
    return { url: `https://${row.name}.${config.domain}`, name: row.name, port: row.port };
  }

  private names(): NonNullable<PreviewsEnv["PREVIEWS"]> {
    if (!this.deps.env.PREVIEWS) throw new Error("Preview URLs are not available on this computer.");
    return this.deps.env.PREVIEWS;
  }

  private tokenContext(tunnelId: string): string {
    return `${this.deps.organizationId()}:${tunnelId}`;
  }

  private serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function claimError(name: string, error: "name_taken" | "denied" | "invalid"): string {
  if (error === "name_taken") return `The preview name ${name} is taken; choose another, or leave the name out to get a generated one.`;
  if (error === "denied") return `The preview name ${name} cannot be used; choose another.`;
  return "That preview could not be registered.";
}

/** The tunnel's name in the Cloudflare account: environment and a hash of the organization, nothing readable. */
export async function tunnelName(environment: string, organizationId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(organizationId)));
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `oc-preview-${environment}-${hex}`;
}
