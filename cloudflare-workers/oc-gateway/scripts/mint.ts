// Mint a per-DEPLOY gateway token (EdDSA). The control plane / deploy pipeline (W7) mints these in
// prod, binding the token as the tenant script's OC_SESSION_TOKEN env var; this is the dev/e2e helper.
// On first use it also generates an Ed25519 keypair.
//
// Generate + mint (the exact CP + gateway provisioning values on stderr; token on stdout):
//   node --experimental-strip-types scripts/mint.ts --org 11111111-1111-4111-8111-111111111111 --agent agt_0123456789abcdef01234567 --ep 1
//     → set the gateway's GATEWAY_TOKEN_PUBLIC_KEY secret from the printed value.
// Reuse the control-plane private value so the gateway public key stays fixed:
//   V3_GATEWAY_TOKEN_PRIVATE_KEY=<base64-pkcs8-pem> node ... scripts/mint.ts ...

import { mintDeployToken, type DeployClaims } from "../src/token.ts";

const b64url = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64url");
const pemFromDer = (der: ArrayBuffer) => {
  const body = Buffer.from(der).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
};
const derFromPemB64 = (value: string) => {
  const pem = Buffer.from(value, "base64").toString("utf8");
  return Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
};

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const ED = { name: "Ed25519" } as const;

let privateKey: CryptoKey;
const existing = process.env.V3_GATEWAY_TOKEN_PRIVATE_KEY;
if (existing) {
  privateKey = await crypto.subtle.importKey("pkcs8", derFromPemB64(existing), ED, true, ["sign"]);
} else {
  const kp = (await crypto.subtle.generateKey(ED, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = kp.privateKey;
  const publicValue = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  const privateValue = Buffer.from(pemFromDer(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), "utf8").toString("base64");
  console.error(`V3_GATEWAY_TOKEN_PRIVATE_KEY=${privateValue}`);
  console.error(`V3_GATEWAY_TOKEN_PUBLIC_KEY=${publicValue}`);
  console.error(`GATEWAY_TOKEN_PUBLIC_KEY=${publicValue}`);
}

const now = Math.floor(Date.now() / 1000);
const ttl = Number(arg("ttl", "3600"));
const ep = arg("ep");
const claims: DeployClaims = {
  org: arg("org", "11111111-1111-4111-8111-111111111111")!,
  agt: arg("agent", "agt_0123456789abcdef01234567")!,
  ep: ep != null ? Number(ep) : undefined,
  iat: now,
  exp: now + ttl,
};
console.log(await mintDeployToken(privateKey, claims));
