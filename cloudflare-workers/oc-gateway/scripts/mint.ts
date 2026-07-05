// Mint a per-session gateway token (EdDSA). The control plane mints these in prod; this is the
// dev/e2e helper. On first use it also generates an Ed25519 keypair.
//
// Generate + mint (PUBLIC key + PRIVATE key printed on stderr; the token on stdout):
//   node --experimental-strip-types scripts/mint.ts --session ses_test --org org_1 --budget 0.50
//     → set the gateway's secret from the printed GATEWAY_TOKEN_PUBLIC_KEY.
// Reuse a private key so the gateway's public key stays fixed across mints:
//   GATEWAY_TOKEN_PRIVATE_KEY=<b64url-pkcs8> node ... scripts/mint.ts --session ses_x --ep 2

import { mintSessionToken, type SessionClaims } from "../src/token.ts";

const b64url = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const ED = { name: "Ed25519" } as const;

let privateKey: CryptoKey;
const existing = process.env.GATEWAY_TOKEN_PRIVATE_KEY;
if (existing) {
  privateKey = await crypto.subtle.importKey("pkcs8", fromB64url(existing), ED, true, ["sign"]);
} else {
  const kp = (await crypto.subtle.generateKey(ED, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = kp.privateKey;
  console.error(`GATEWAY_TOKEN_PUBLIC_KEY=${b64url(await crypto.subtle.exportKey("raw", kp.publicKey))}`);
  console.error(`GATEWAY_TOKEN_PRIVATE_KEY=${b64url(await crypto.subtle.exportKey("pkcs8", kp.privateKey))}`);
}

const now = Math.floor(Date.now() / 1000);
const ttl = Number(arg("ttl", "3600"));
const budget = Number(arg("budget", "0")); // USD; 0 = uncapped
const ep = arg("ep");
const claims: SessionClaims = {
  sub: arg("session", "ses_test")!,
  org: arg("org", "org_1")!,
  agt: arg("agent", "agt_1")!,
  bud: budget > 0 ? budget : undefined,
  ep: ep != null ? Number(ep) : undefined,
  iat: now,
  exp: now + ttl,
};
console.log(await mintSessionToken(privateKey, claims));
