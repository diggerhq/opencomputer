// Per-session gateway token (design 013 §4 "session-scoped token the DO mints/reads"). A compact
// HS256 JWT the gateway verifies on-path → (org, agent, session, budget). HS256 (shared secret)
// is the spike choice — the minter (the session DO / sessions-api) and the verifier (this gateway)
// are one trust domain. PROD hardening: switch to EdDSA (minter holds the private key, gateway holds
// only the public key — the same asymmetry as the turn token), and fence on the session's lease
// epoch so a superseded token stops verifying. Kept dependency-free (Web Crypto only).

export interface SessionClaims {
  /** session id (ses_…) — the sub-meter + budget key. */
  sub: string;
  /** org id — selects the org's OpenRouter inference key (never leaves the gateway). */
  org: string;
  /** agent id — attribution only. */
  agt: string;
  /** per-session hard budget in USD. Enforced on-path (§8). Omit/0 = no per-session cap. */
  bud?: number;
  /** issued-at / expiry (seconds). */
  iat: number;
  exp: number;
}

const enc = new TextEncoder();

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

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Mint a session token (used by the DO/sessions-api; here for the spike's mint helper + tests). */
export async function mintSessionToken(secret: string, claims: SessionClaims): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

export type VerifyResult = { ok: true; claims: SessionClaims } | { ok: false; reason: string };

/** Verify a session token. Constant-time signature check (crypto.subtle.verify) + exp check. */
export async function verifySessionToken(secret: string, token: string, nowSec: number): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, sig] = parts;
  const key = await hmacKey(secret);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), enc.encode(`${header}.${payload}`));
  } catch {
    return { ok: false, reason: "bad_signature_encoding" };
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  let claims: SessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return { ok: false, reason: "expired" };
  if (!claims.sub || !claims.org) return { ok: false, reason: "missing_claims" };
  return { ok: true, claims };
}
