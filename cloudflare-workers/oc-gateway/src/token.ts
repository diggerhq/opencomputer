// The gateway deploy token (design 013 §4 / buildout contract #1, resolved token seam 2026-07-05).
//
// RESOLVED SEAM (option b, header-based). The gateway token is **per-DEPLOY**, not per-session:
//   claims = { org, agt, iat, exp, ep? }  — it authorizes an (org, agent) pair, nothing more.
// There is NO `sub:session` and NO `bud` claim. The session identity rides an `X-OC-Session` request
// header the tenant DO injects (Flue's `registerProvider` `apiKey` is a static string only, so it
// cannot carry per-session data — providers.ts:60); the per-session budget is looked up server-side
// in the SessionBudget DO keyed by that header. The token is bound as the tenant script's
// `OC_SESSION_TOKEN` env var by the deploy pipeline (W7) and rotates every redeploy.
//
// PROD hardening over the 1a spike (HS256 shared secret):
//   1. EdDSA (Ed25519). The MINTER (control plane / deploy pipeline) holds the private key; the
//      gateway holds ONLY the public key — the same asymmetry as the turn token, so a compromised
//      gateway cannot forge deploy tokens. Dependency-free — Ed25519 is in Workers' WebCrypto.
//   2. A **lease epoch** (`ep`, optional): a monotonic per-(org, agt) deploy counter. The gateway
//      fences a token whose `ep` is below the current floor (DeployLease DO) — so a rotated or
//      explicitly-revoked deploy token stops verifying even before `exp`.
//
// MINT↔VERIFY CONTRACT (W7 mints; the gateway verifies):
//   alg "EdDSA"; claims { org, agt, iat, exp, ep?, scopes[] }; the gateway is configured with
//   GATEWAY_TOKEN_PUBLIC_KEY = base64url(raw 32-byte Ed25519 public key).

export interface DeployClaims {
  /** org id — selects the org's OpenRouter inference key (never leaves the gateway). */
  org: string;
  /** agent id — the deploy this token authorizes; attribution + the lease-fence key with `org`. */
  agt: string;
  /** lease/deploy epoch (monotonic per (org, agt)). Below the DeployLease floor → fenced. Omit = no fence. */
  ep?: number;
  /** Explicit tenant capabilities; the gateway requires `gateway:invoke`. */
  scopes: Array<"gateway:invoke" | "sandbox:use" | "repo:use" | "ingest:write">;
  /** issued-at / expiry (seconds). */
  iat: number;
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const ED = { name: "Ed25519" } as const;

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/** Import a base64url raw 32-byte Ed25519 public key for verification. */
async function importPublicKey(publicKeyB64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64urlDecode(publicKeyB64url), ED, false, ["verify"]);
}

export type VerifyResult = { ok: true; claims: DeployClaims } | { ok: false; reason: string };

/** Verify a per-deploy EdDSA token: alg pin + signature + exp/iat + required claims (org, agt). */
export async function verifyDeployToken(
  publicKeyB64url: string,
  token: string,
  nowSec: number,
  requiredScope?: DeployClaims["scopes"][number],
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, sig] = parts;

  let alg: string;
  try {
    alg = (JSON.parse(dec.decode(b64urlDecode(header))) as { alg?: string }).alg ?? "";
  } catch {
    return { ok: false, reason: "bad_header" };
  }
  if (alg !== "EdDSA") return { ok: false, reason: "unexpected_alg" }; // pin — never accept "none"/HS256

  let key: CryptoKey;
  try {
    key = await importPublicKey(publicKeyB64url);
  } catch {
    return { ok: false, reason: "bad_public_key" };
  }

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(ED, key, b64urlDecode(sig), enc.encode(`${header}.${payload}`));
  } catch {
    return { ok: false, reason: "bad_signature_encoding" };
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  let claims: DeployClaims;
  try {
    claims = JSON.parse(dec.decode(b64urlDecode(payload)));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return { ok: false, reason: "expired" };
  if (typeof claims.iat === "number" && claims.iat > nowSec + 60) return { ok: false, reason: "future_iat" };
  if (!claims.org || !claims.agt) return { ok: false, reason: "missing_claims" };
  if (!Array.isArray(claims.scopes) || claims.scopes.some((scope) =>
    scope !== "gateway:invoke" && scope !== "sandbox:use" && scope !== "repo:use" && scope !== "ingest:write")) {
    return { ok: false, reason: "bad_scopes" };
  }
  if (claims.ep !== undefined && (!Number.isSafeInteger(claims.ep) || claims.ep < 0)) {
    return { ok: false, reason: "bad_epoch" };
  }
  if (requiredScope && !claims.scopes.includes(requiredScope)) return { ok: false, reason: "missing_scope" };
  return { ok: true, claims };
}

// ── Mint helpers — for the reference minter (W7) + tests. The gateway NEVER mints in prod. ──

/** Generate an Ed25519 keypair; returns the private key + base64url raw public key (gateway config). */
export async function generateKeyPair(): Promise<{ privateKey: CryptoKey; publicKeyB64url: string }> {
  const kp = (await crypto.subtle.generateKey(ED, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  return { privateKey: kp.privateKey, publicKeyB64url: b64urlEncode(raw) };
}

/** Sign a deploy token with the Ed25519 private key (mint side). */
export async function mintDeployToken(privateKey: CryptoKey, claims: DeployClaims): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign(ED, privateKey, enc.encode(signingInput)));
  return `${signingInput}.${b64urlEncode(sig)}`;
}
