// Mint a per-session gateway token for live verification (the DO / sessions-api mints these in prod).
// Usage:
//   GATEWAY_TOKEN_SECRET=<secret> node --experimental-strip-types scripts/mint.ts \
//     --session ses_test --org org_1 --agent agt_1 --budget 0.50 --ttl 3600
// Prints the token to stdout. Use it as the `apiKey` in registerProvider (or an Authorization
// Bearer header) when driving a real turn through the gateway.

import { mintSessionToken } from "../src/token.ts";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const secret = process.env.GATEWAY_TOKEN_SECRET;
if (!secret) { console.error("set GATEWAY_TOKEN_SECRET"); process.exit(1); }

const now = Math.floor(Date.now() / 1000);
const ttl = Number(arg("ttl", "3600"));
const budget = Number(arg("budget", "0")); // USD; 0 = uncapped

const token = await mintSessionToken(secret, {
  sub: arg("session", "ses_test")!,
  org: arg("org", "org_1")!,
  agt: arg("agent", "agt_1")!,
  bud: budget > 0 ? budget : undefined,
  iat: now,
  exp: now + ttl,
});
console.log(token);
