// Host telemetry credentials (work 054, "Host credentials"): the backend signs
// `{org_id, host_id, exp}` with Ed25519 at provisioning and on every
// `welcome`; the collector checks the signature with the public key alone, so
// accepting a batch calls nothing we run.
//
// Wire form: `v1.<base64url(JSON payload)>.<base64url(signature)>`, the
// signature over the ASCII bytes of `v1.<base64url(JSON payload)>`; `exp` is
// seconds since epoch. `sign` is the reference issuer: tests use it, and
// the backend's issuer must produce byte-identical credentials.
//
// Invariants: `verify` never throws; any malformed, unsigned, expired or
// denylisted credential is `undefined`. Several public keys may be configured
// (comma-separated) so the signing key rotates without a gap.

export interface Credential {
  org_id: string;
  host_id: string;
  exp: number;
}

const PREFIX = 'v1';
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keys = new Map<string, Promise<CryptoKey>>();
/** Imported once per isolate per configured key. */
function publicKey(raw: string): Promise<CryptoKey> {
  let k = keys.get(raw);
  if (!k) {
    k = crypto.subtle.importKey('raw', unb64url(raw), { name: 'Ed25519' }, false, ['verify']);
    keys.set(raw, k);
  }
  return k;
}

/** The credential's claims when it is well-formed, signed by one of `publicKeys` and unexpired; never throws. */
export async function verify(token: string, publicKeys: string, nowS: number, denylist: ReadonlySet<string>): Promise<Credential | undefined> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return undefined;
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = unb64url(parts[2]);
    let ok = false;
    for (const raw of publicKeys.split(',').map((s) => s.trim())) {
      if (!raw) continue;
      if (await crypto.subtle.verify({ name: 'Ed25519' }, await publicKey(raw), sig, signed)) {
        ok = true;
        break;
      }
    }
    if (!ok) return undefined;
    const claims: unknown = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
    if (typeof claims !== 'object' || claims === null) return undefined;
    const { org_id, host_id, exp } = claims as Record<string, unknown>;
    if (typeof org_id !== 'string' || !ID.test(org_id) || typeof host_id !== 'string' || !ID.test(host_id)) return undefined;
    if (typeof exp !== 'number' || !(exp > nowS)) return undefined;
    if (denylist.has(host_id) || denylist.has(`org:${org_id}`)) return undefined;
    return { org_id, host_id, exp };
  } catch {
    return undefined;
  }
}

/** Issue a credential with an Ed25519 private key (the reference for the backend's issuer). */
export async function sign(claims: Credential, privateKey: CryptoKey): Promise<string> {
  const body = `${PREFIX}.${b64url(new TextEncoder().encode(JSON.stringify(claims)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** A fresh key pair: the public half as `CREDENTIAL_PUBLIC_KEY` (raw, base64url), the private half for the issuer. */
export async function generateKeys(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return { publicKey: b64url(raw), privateKey: pair.privateKey };
}

/** `CREDENTIAL_DENYLIST`: comma-separated host ids, and `org:<org_id>` to revoke a whole organization. */
export const parseDenylist = (v: string | undefined): Set<string> => new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
