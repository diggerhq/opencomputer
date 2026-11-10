/**
 * Fixed egress IPs through exits (work 073). A sandbox with `fixed_ips`
 * tunnels all IPv4 traffic to its region's exits (`deploy/egress/`), which
 * enforce the deployment's allowlist and leave from fixed IPs. This module
 * derives the sandbox's credential and renders its sing-box client config.
 */

import registry from "./egress-registry.json" with { type: "json" };
import type { DeploymentRegion } from "./protocol.js";

/**
 * One exit, as listed in `src/egress-registry.json`. `region` is the exit's
 * pool (its key in `deploy/egress/exits.json`), internal to the platform.
 */
export interface EgressExit {
  region: string;
  app: string;
  server: string;
  egress_ipv4: string;
  reality: { public_key: string; short_id: string; server_name: string };
}

/** Every exit, as `deploy/egress/apply.sh` last wrote them. */
export const EGRESS_EXITS: readonly EgressExit[] = registry.exits;

/**
 * The `fixed_ips` values and the pool each leaves through: every deployment
 * region, and the pools no region maps to under their own names.
 */
const FIXED_IPS_POOLS: Record<DeploymentRegion | "ams" | "ewr" | "lax", string> = {
  us: "iad",
  "us-east": "iad",
  "us-central": "ord",
  "us-south": "dfw",
  "us-west": "sjc",
  mx: "dfw",
  ca: "yyz",
  eu: "fra",
  "eu-west": "cdg",
  "eu-north": "arn",
  "eu-south": "fra",
  uk: "lhr",
  me: "fra",
  ap: "sin",
  "ap-northeast": "nrt",
  "ap-southeast": "sin",
  "ap-south": "sin",
  "ap-melbourne": "au",
  jp: "nrt",
  au: "au",
  sa: "gru",
  af: "jnb",
  ams: "ams",
  ewr: "ewr",
  lax: "lax",
};

/** The `fixed_ips` values (`au`, `eu-west`, ...), sorted. */
export function fixedIpsRegions(): string[] {
  return Object.keys(FIXED_IPS_POOLS).sort();
}

/** The pool a `fixed_ips` value leaves through, or undefined. */
export function egressExitPool(fixedIps: string): string | undefined {
  return Object.hasOwn(FIXED_IPS_POOLS, fixedIps)
    ? FIXED_IPS_POOLS[fixedIps as keyof typeof FIXED_IPS_POOLS]
    : undefined;
}

/** The exit pools, sorted: what each exit polls its policy for. */
export function egressExitPools(): string[] {
  return [...new Set(EGRESS_EXITS.map((exit) => exit.region))].sort();
}

/** The exits a `fixed_ips` value leaves through, empty for an unknown one. */
export function egressExitsFor(fixedIps: string): EgressExit[] {
  const pool = egressExitPool(fixedIps);
  return EGRESS_EXITS.filter((exit) => exit.region === pool);
}

/** Modal's resolver. DNS stays outside the tunnel, as on Modal itself. */
export const MODAL_DNS = "172.21.0.1";
/**
 * sing-box's Clash API in the sandbox; the supervisor switches exits here.
 * Not 9090: an operator image serves its supervisor there.
 */
export const EXIT_CONTROLLER = "127.0.0.1:47213";
/** The selector outbound that holds a region's exits. */
export const EXIT_SELECTOR = "exit";

/**
 * A deployment's VLESS UUID for a UTC day (`YYYY-MM-DD`). Must match
 * `credential()` in `deploy/egress/server/egress.py`: the first 16 bytes of
 * HMAC-SHA256(root key, `oc-egress/v1/<deployment>/<day>`) as a v4 UUID.
 * The sandbox uses the current UTC day, which every exit accepts.
 */
export async function exitCredential(rootKeyHex: string, deploymentId: string, day: string): Promise<string> {
  if (!/^([0-9a-f]{2}){32,}$/i.test(rootKeyHex)) throw new Error("egress root key must be 32+ bytes, hex");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("day must be YYYY-MM-DD");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(rootKeyHex.match(/../g)!, (byte) => parseInt(byte, 16)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`oc-egress/v1/${deploymentId}/${day}`)),
  );
  const bytes = mac.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * What the exits know a deployment by: 32 hex characters of
 * SHA-256(`<account>/<deployment>`). Deployment ids are unique only within an
 * account, and exits need not learn account or agent names.
 */
export async function exitIdentity(accountId: string, deploymentId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${accountId}/${deploymentId}`));
  return [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The current UTC day, `YYYY-MM-DD`. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The sandbox's sing-box config: an IPv4-only TUN that routes everything
 * except Modal's resolver to the selected exit, all exits in one selector,
 * and the Clash API on localhost so the supervisor can switch exits.
 */
export function exitClientConfig(exits: readonly EgressExit[], uuid: string): Record<string, unknown> {
  if (exits.length === 0) throw new Error("no exits for this region");
  const outbounds = exits.map((exit) => ({
    type: "vless",
    tag: exit.app,
    server: exit.server,
    server_port: 443,
    uuid,
    flow: "xtls-rprx-vision",
    tls: {
      enabled: true,
      server_name: exit.reality.server_name,
      utls: { enabled: true, fingerprint: "chrome" },
      reality: { enabled: true, public_key: exit.reality.public_key, short_id: exit.reality.short_id },
    },
  }));
  return {
    log: { level: "warn" },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        address: ["172.19.0.1/30"],
        mtu: 1400,
        auto_route: true,
        strict_route: true,
        route_exclude_address: [`${MODAL_DNS}/32`],
      },
    ],
    outbounds: [
      { type: "selector", tag: EXIT_SELECTOR, outbounds: exits.map((exit) => exit.app), default: exits[0]!.app },
      ...outbounds,
    ],
    route: { auto_detect_interface: true, final: EXIT_SELECTOR },
    experimental: { clash_api: { external_controller: EXIT_CONTROLLER } },
  };
}
