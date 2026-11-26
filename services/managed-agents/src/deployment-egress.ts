import type { DeploymentEgress } from "./protocol.js";

/**
 * Deployment egress allowlist (work 057). A deployment with `egress` runs
 * its tool sandboxes with Modal's outbound allowlists: `domains` (exact or
 * `*.` wildcard, matched on TLS SNI, port 443 only) and `cidrs` (any
 * protocol and port). Absent means an open network.
 */
export const EGRESS_MAX_ENTRIES = 64;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A lowercased domain or `*.` wildcard, or null when it is not one. */
export function egressDomain(value: string): string | null {
  const lowered = value.trim().toLowerCase().replace(/\.$/, "");
  const wildcard = lowered.startsWith("*.");
  const host = wildcard ? lowered.slice(2) : lowered;
  if (host.length > 253 || IPV4.test(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return wildcard ? `*.${host}` : host;
}

function ipv6(address: string): boolean {
  if (!address.includes(":") || !/^[0-9a-f:.]+$/.test(address)) return false;
  try {
    new URL(`http://[${address}]/`);
    return true;
  } catch {
    return false;
  }
}

/** An IP or CIDR as a CIDR (a bare address gets /32 or /128), or null. */
export function egressCidr(value: string): string | null {
  const [address = "", prefix, extra] = value.trim().toLowerCase().split("/");
  if (extra !== undefined) return null;
  const max = IPV4.test(address) ? 32 : ipv6(address) ? 128 : null;
  if (max === null) return null;
  if (prefix === undefined) return `${address}/${max}`;
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) return null;
  return `${address}/${Number(prefix)}`;
}

function entries(
  value: unknown,
  normalize: (entry: string) => string | null,
): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > EGRESS_MAX_ENTRIES) return null;
  const out = new Set<string>();
  for (const entry of value) {
    const normalized = typeof entry === "string" ? normalize(entry) : null;
    if (normalized === null) return null;
    out.add(normalized);
  }
  return [...out].sort();
}

/**
 * The egress allowlist, undefined when absent, or null when present and
 * invalid. Empty lists are valid: only the platform's own hosts are open.
 */
export function parseDeploymentEgress(
  value: unknown,
): DeploymentEgress | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "domains" && key !== "cidrs")) {
    return null;
  }
  const domains = entries(record.domains, egressDomain);
  const cidrs = entries(record.cidrs, egressCidr);
  if (domains === null || cidrs === null) return null;
  return { domains, cidrs };
}

/**
 * Hosts a tool sandbox needs whatever the deployment allows: the edge (the
 * supervisor's runtime routes) and the artifact bucket's S3 endpoint.
 */
export function platformEgressDomains(edge: string, awsRegion: string): string[] {
  return [new URL(edge).hostname, `*.s3.${awsRegion}.amazonaws.com`];
}
