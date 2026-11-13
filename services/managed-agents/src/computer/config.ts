// The edge's computer settings (work 052) and the public vocabulary of a
// computer. Azure placement and credentials are the platform Worker's
// (src/platform/computers); the edge holds what it decides itself: sizes,
// the host token key, where hosts dial, and the organization Slack app.

import type { ManagedAgentBillingService } from "../edge/billing-admission.js";
import type { PreviewsEnv } from "./previews.js";

/** Preview URLs (work 074, previews.ts): off unless all of PreviewsEnv is set. */
export interface ComputerEdgeEnv extends PreviewsEnv {
  /** The managed-agent session index (session_creations), read by oc-usage-chart. */
  SERVERLESS_AGENTS_DB?: D1Database;
  /** One ComputerDurableObject per organization, plus `computer-slack-team:<teamId>` link objects. */
  COMPUTERS?: DurableObjectNamespace;
  ACCOUNTS: DurableObjectNamespace;
  /** The platform Worker (service binding): owns the cloud credentials. */
  RUNTIMES?: Fetcher;
  OPENCOMPUTER_BILLING?: ManagedAgentBillingService;
  /** AES-GCM key (32 bytes, base64) shared with channel credentials; computer data uses keys derived from it. */
  BLUE_CHANNEL_ENCRYPTION_KEY?: string;
  BLUE_ENVIRONMENT?: string;
  COMPUTER_HOST_TOKEN_KEY?: string;
  /**
   * Who runs the computers' VMs (work 105). Unset: this gateway, through the
   * platform Worker (RUNTIMES). "self-managed": the operator creates, sizes
   * and deletes each organization's VM, and the gateway only accepts its
   * host's connection: it never creates, parks, wakes, resizes or deletes a
   * VM, grows no disk and keeps no warm pool.
   */
  COMPUTER_VMS?: string;
  /** wss origin the VM dials, e.g. wss://managedagents.opencomputer.dev. */
  COMPUTER_HOST_GATEWAY_URL?: string;
  COMPUTER_DEFAULT_SIZE?: string;
  /** The $200 ("max") plan's VM size (e.g. Standard_D8as_v7); empty: the default size. */
  COMPUTER_MAX_SIZE?: string;
  /** Former name of COMPUTER_MAX_SIZE, still read when it is unset. */
  COMPUTER_PAID_SIZE?: string;
  COMPUTER_DEFAULT_DISK_GIB?: string;
  /** The most a computer's data disk grows to on its own (work 071; default 1024). */
  COMPUTER_MAX_DISK_GIB?: string;
  /** Warm pool computers to keep ready for new organizations; "0" or absent: no pool. */
  COMPUTER_POOL_SIZE?: string;
  /** Work 084 rollout gate (api-gate.ts): organizations spoken to at protocol v4. Empty or unset: none; `*`: all; else comma-separated ids. */
  COMPUTER_API_ORGS?: string;
  /** Minutes a free organization's computer stays idle before it parks (default 30). */
  COMPUTER_PARK_AFTER_MINUTES?: string;
  /** Work 086: "on" parks a paid computer billing has refused for 7 days, warning its installer on day 6; else it only logs. */
  COMPUTER_UNPAID_TERMINATION?: string;
  /** The public origin the browser and Slack see (https://app.opencomputer.dev). */
  COMPUTER_PUBLIC_ORIGIN?: string;
  /** The public edge: runtime usage, managed model key provisioning. */
  OPENCOMPUTER_APP_URL?: string;
  /** Signs computer sessions' runtime usage, as it signs serverless agent sessions' (src/edge/runtime-usage.ts). */
  BLUE_USAGE_HMAC_SECRET?: string;
  /** Signs the request that asks the public edge to create an organization's managed model key (model-key.ts). */
  OC_MANAGED_CRED_HMAC_SECRET?: string;
  SLACK_COMPUTER_CLIENT_ID?: string;
  SLACK_COMPUTER_CLIENT_SECRET?: string;
  SLACK_COMPUTER_SIGNING_SECRET?: string;
  SLACK_COMPUTER_SCOPES?: string;
  /** The shared API key, used only for an organization without its own managed key (model-key.ts). */
  COMPUTER_ANTHROPIC_API_KEY?: string;
  /**
   * Telemetry (work 054, telemetry/): off unless both are set. The Tinybird
   * workspace's regional API base (var) and its `calvin_append_gateway` token (secret).
   */
  TINYBIRD_API_URL?: string;
  TINYBIRD_APPEND_TOKEN?: string;
  /** Ed25519 PKCS#8 (base64) that signs hosts' telemetry credentials (secret); unset: none are issued. */
  TELEMETRY_SIGNING_KEY?: string;
  /** Calvin's collector, sent with the credential so hosts provisioned without SP_TELEMETRY_URL send too (var). */
  TELEMETRY_COLLECTOR_URL?: string;
  /** The Worker version stamped on telemetry (version_metadata binding); absent: `dev`. */
  CF_VERSION_METADATA?: { id?: string };
  /** Work 084: one SessionLogDurableObject per session (`getByName(cs_…)`): the API's copy of its event log. */
  SESSION_LOG?: DurableObjectNamespace;
  /** Work 084: the SessionLog's large payloads and sealed segments (`<org>/<session>/…`). */
  SESSION_LOG_BLOBS?: R2Bucket;
  /** Work 084: `h:<sha256(key)>` → the wire's key record, `k:<keyId>` → its hash; written by keys.ts, read by the wire Worker. */
  WIRE_KEYS?: KVNamespace;
  /** Work 084: signs tickets (HKDF → HMAC), shared with the wire Worker. A secret. */
  WIRE_TICKET_KEY?: string;
  /** Work 084: the public wire URL (`wss://wire.opencomputer.dev/v1`), on `/me` and tickets. */
  WIRE_PUBLIC_URL?: string;
  /** Work 084: where the tunnels' wire hostnames live; `w.opencomputer.dev` unless set. */
  WIRE_TUNNEL_DOMAIN?: string;
  /** Work 084: the zone of WIRE_TUNNEL_DOMAIN, for the tunnels' wire DNS records. Unset: no wire hostname. */
  WIRE_CF_ZONE_ID?: string;
}

export const DEFAULT_WIRE_URL = "wss://wire.opencomputer.dev/v1";
export const DEFAULT_WIRE_TUNNEL_DOMAIN = "w.opencomputer.dev";

export const DEFAULT_SIZE = "Standard_D2as_v7";
export const DEFAULT_DISK_GIB = 128;
export const DEFAULT_MAX_DISK_GIB = 1024;
/** Premium SSD v2 needs a zone; every eastus v7 size is offered in zone 1. */
export const DEFAULT_ZONE = "1";

export class ComputersNotConfigured extends Error {
  constructor(readonly missing: string[]) {
    super(`computers are not configured: missing ${missing.join(", ")}`);
    this.name = "ComputersNotConfigured";
  }
}

/** COMPUTER_VMS is "self-managed": the operator runs the VMs, the gateway only accepts their hosts. */
export function selfManagedVms(env: ComputerEdgeEnv): boolean {
  return env.COMPUTER_VMS === "self-managed";
}

/**
 * Edge settings a computer needs before it can be created, by name. With
 * self-managed VMs nothing is created: the platform Worker and the URL
 * written into a new VM are not needed, only what checks a host's token.
 */
export function missingEdgeConfig(env: ComputerEdgeEnv): string[] {
  const missing: string[] = [];
  if (!env.COMPUTERS) missing.push("COMPUTERS");
  if (!selfManagedVms(env)) {
    if (!env.RUNTIMES) missing.push("RUNTIMES");
    if (!env.COMPUTER_HOST_GATEWAY_URL) missing.push("COMPUTER_HOST_GATEWAY_URL");
  }
  if (!env.COMPUTER_HOST_TOKEN_KEY) missing.push("COMPUTER_HOST_TOKEN_KEY");
  return missing;
}

/** The VM size for a size tier (plan.ts sizeTier): "max" is the $200 plan's, everyone else the default. */
export function sizeFor(env: ComputerEdgeEnv, tier: "max" | "default"): string {
  const max = env.COMPUTER_MAX_SIZE || env.COMPUTER_PAID_SIZE;
  return (tier === "max" ? max : undefined) || env.COMPUTER_DEFAULT_SIZE || DEFAULT_SIZE;
}

export function defaultDiskGiB(env: ComputerEdgeEnv): number {
  const disk = Number(env.COMPUTER_DEFAULT_DISK_GIB || DEFAULT_DISK_GIB);
  return Number.isInteger(disk) && disk > 0 ? disk : DEFAULT_DISK_GIB;
}

export function maxDiskGiB(env: ComputerEdgeEnv): number {
  const disk = Number(env.COMPUTER_MAX_DISK_GIB || DEFAULT_MAX_DISK_GIB);
  return Number.isInteger(disk) && disk > 0 ? disk : DEFAULT_MAX_DISK_GIB;
}

/** The host's gateway URL: Calvin dials SP_GATEWAY_URL verbatim; the edge reads `organizationId`. */
export function gatewayUrl(base: string, organizationId: string): string {
  const origin = new URL(base);
  const scheme = origin.protocol === "http:" || origin.protocol === "ws:" ? "ws" : "wss";
  return `${scheme}://${origin.host}/v1/computer/host?organizationId=${encodeURIComponent(organizationId)}`;
}

export function publicOrigin(env: ComputerEdgeEnv): string {
  return (env.COMPUTER_PUBLIC_ORIGIN || env.OPENCOMPUTER_APP_URL || "https://app.opencomputer.dev").replace(/\/+$/, "");
}

export function slackRedirectUri(env: ComputerEdgeEnv): string {
  return `${publicOrigin(env)}/api/managed-agents/computer/slack/callback`;
}

/**
 * vCPUs and memory of a size, without naming it: `Standard_D2as_v7` → 2
 * vCPUs, 8 GiB. D sizes have 4 GiB per vCPU, E 8, F 2.
 */
export function sizeShape(size: string): { vcpus: number; memoryGiB: number } {
  const match = size.match(/^Standard_([A-Z]+)(\d+)/i);
  const family = match?.[1]?.toUpperCase() ?? "D";
  const vcpus = Number(match?.[2] ?? 2);
  const perVcpu = family.startsWith("E") ? 8 : family.startsWith("F") ? 2 : 4;
  return { vcpus, memoryGiB: vcpus * perVcpu };
}

export type PublicComputerState = "provisioning" | "ready" | "parked" | "waking" | "failed" | "deleting";

/** The dashboard's `Computer` (work 052, API contract): no cloud, region, size or host names. */
export interface PublicComputer {
  state: PublicComputerState;
  connected: boolean;
  vcpus: number;
  memoryGiB: number;
  diskGiB: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An error as the dashboard may show it. Lifecycle errors come from the
 * cloud and name it, its resources and regions; the page gets a plain
 * sentence and the full text stays in the logs.
 */
export function publicError(error: string | null): string | null {
  if (!error) return null;
  if (/not configured/i.test(error)) return "Computers are not available yet.";
  if (/quota|capacity|allocation|SkuNotAvailable|NotAvailableForSubscription/i.test(error)) {
    return "No capacity was available for your computer; try again in a few minutes.";
  }
  if (/tagged for/i.test(error)) return "Your computer's resources are in an unexpected state; support has been notified.";
  return "Your computer could not be started.";
}
