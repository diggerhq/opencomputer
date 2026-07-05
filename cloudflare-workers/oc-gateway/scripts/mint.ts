// Mint a per-DEPLOY gateway token (EdDSA). The control plane / deploy pipeline (W7) mints these in
// prod, binding the token as the tenant script's OC_SESSION_TOKEN env var; this is the dev/e2e helper.
// On first use it also generates an Ed25519 keypair.
//
// Generate + mint (PUBLIC + PRIVATE key printed on stderr; the token on stdout):
//   node --experimental-strip-types scripts/mint.ts --org org_1 --agent agt_1 --ep 1
//     → set the gateway's GATEWAY_TOKEN_PUBLIC_KEY secret from the printed value.
// Reuse a private key so the gateway's public key stays fixed across mints:
//   GATEWAY_TOKEN_PRIVATE_KEY=<b64url-pkcs8> node ... scripts/mint.ts --org org_1 --agent agt_1 --ep 2

import { mintDeployToken, type DeployClaims } from "../src/token.ts";

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
const ep = arg("ep");
const claims: DeployClaims = {
  org: arg("org", "org_1")!,
  agt: arg("agent", "agt_1")!,
  ep: ep != null ? Number(ep) : undefined,
  iat: now,
  exp: now + ttl,
};
console.log(await mintDeployToken(privateKey, claims));
