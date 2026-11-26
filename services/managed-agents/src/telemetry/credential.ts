// Host telemetry credentials (work 054, "Host
// credentials", decision 13). The gateway signs `{org_id, host_id, exp}` with
// Ed25519; Calvin's telemetry collector checks the signature with the public
// key alone, so collection calls nothing we run and hosts share no secret.
//
// Wire form, byte-identical to the collector's reference issuer (calvin
// telemetry/collector/src/credential.ts `sign`):
//   v1.<base64url(JSON {org_id, host_id, exp})>.<base64url(Ed25519 signature)>
// The signature covers the ASCII of `v1.<payload>`; `exp` is seconds since
// epoch; ids match `[A-Za-z0-9_.:-]{1,128}` or the collector rejects them.
// Keys: TELEMETRY_SIGNING_KEY is PKCS#8 DER, CREDENTIAL_PUBLIC_KEY (the
// collector's) the raw 32 bytes, each base64 or base64url.
//
// Dependency-free on purpose: scripts/telemetry-credential.mjs imports it
// under Node.

export interface TelemetryClaims {
  org_id: string;
  host_id: string;
  /** Seconds since epoch. */
  exp: number;
}

/** 90 days: a gateway outage stops renewal, not collection. */
export const CREDENTIAL_TTL_S = 90 * 24 * 60 * 60;
const PREFIX = "v1";
const ED25519 = { name: "Ed25519" } as const;
/** The collector's id rule. */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.trim().replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Whether the collector accepts this as an `org_id` or `host_id`. */
export function credentialId(value: string): boolean {
  return ID.test(value);
}

/** Sign a credential for one host of one organization, valid for 90 days from `now` (ms). */
export async function issueTelemetryCredential(
  signingKey: string,
  host: { orgId: string; hostId: string },
  now = Date.now(),
): Promise<string> {
  if (!credentialId(host.orgId) || !credentialId(host.hostId)) throw new Error("telemetry credential: invalid organization or host id");
  const claims: TelemetryClaims = { org_id: host.orgId, host_id: host.hostId, exp: Math.floor(now / 1000) + CREDENTIAL_TTL_S };
  const body = `${PREFIX}.${toBase64Url(encoder.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey("pkcs8", fromBase64(signingKey), ED25519, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign(ED25519, key, encoder.encode(body)));
  return `${body}.${toBase64Url(signature)}`;
}

/**
 * The collector's check, for tests and the CLI: the claims when well-formed,
 * signed by `publicKey` and unexpired; null otherwise. Never throws.
 */
export async function verifyTelemetryCredential(publicKey: string, credential: string, now = Date.now()): Promise<TelemetryClaims | null> {
  try {
    const [prefix, payload, signature, extra] = credential.split(".");
    if (prefix !== PREFIX || !payload || !signature || extra !== undefined) return null;
    const key = await crypto.subtle.importKey("raw", fromBase64(publicKey), ED25519, false, ["verify"]);
    if (!(await crypto.subtle.verify(ED25519, key, fromBase64(signature), encoder.encode(`${prefix}.${payload}`)))) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64(payload))) as Partial<TelemetryClaims>;
    if (typeof claims.org_id !== "string" || !ID.test(claims.org_id)) return null;
    if (typeof claims.host_id !== "string" || !ID.test(claims.host_id)) return null;
    if (typeof claims.exp !== "number" || !(claims.exp * 1000 > now)) return null;
    return { org_id: claims.org_id, host_id: claims.host_id, exp: claims.exp };
  } catch {
    return null;
  }
}

/** A new key pair: TELEMETRY_SIGNING_KEY for this gateway, CREDENTIAL_PUBLIC_KEY for the collector. */
export async function generateTelemetryKeys(): Promise<{ signingKey: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    signingKey: toBase64Url(new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer)),
    publicKey: toBase64Url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)),
  };
}
