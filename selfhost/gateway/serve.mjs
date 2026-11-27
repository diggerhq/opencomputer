// The self-hosted gateway (spike): the managed-agents edge Worker's Computer path
// (services/managed-agents/src/selfhost/entry.ts) under Miniflare, every Durable Object, D1,
// R2 and KV write persisted under GATEWAY_DATA (default /data).
//
//   SETUP_TOKEN=… node serve.mjs
//
// Env: SETUP_TOKEN (required; the operator's bearer on /v1/computer/*), GATEWAY_DATA (/data),
// PORT (8080), HOST (0.0.0.0), GATEWAY_ORG (org_selfhost), GATEWAY_BUNDLE (a prebuilt
// entry.js; unset: built now with wrangler from MANAGED_AGENTS_DIR), COMPUTER_ANTHROPIC_API_KEY
// (optional, the sessions' shared model key), PUBLIC_URL (or SP_ORIGIN; the public https origin),
// SP_SETUP_OPEN (1: /setup stays open once complete), GATEWAY_PORT (the host-side port the host
// agent dials, for /setup's install command; default PORT).
//
// Keys the gateway needs and nobody types (the host token key, the store key) are generated on
// first start into GATEWAY_DATA/keys.json (0600). The organization's host token is written to
// GATEWAY_DATA/host-token (0600) for the host agent's SP_HOST_TOKEN; it is never printed.

import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const managedAgents = resolve(process.env.MANAGED_AGENTS_DIR ?? join(here, "../../services/managed-agents"));
const { Miniflare } = await import(process.env.MINIFLARE_MODULE ?? join(managedAgents, "node_modules/miniflare/dist/src/index.js"));

const data = resolve(process.env.GATEWAY_DATA ?? "/data");
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const org = process.env.GATEWAY_ORG ?? "org_selfhost";
const setupToken = process.env.SETUP_TOKEN;
const publicUrl = (process.env.PUBLIC_URL || process.env.SP_ORIGIN || "").replace(/\/+$/, "");
const hostUrl = `ws://127.0.0.1:${process.env.GATEWAY_PORT || port}/v1/computer/host?organizationId=${org}`;
if (!setupToken) {
  console.error("SETUP_TOKEN is required (openssl rand -hex 32)");
  process.exit(1);
}

mkdirSync(data, { recursive: true });

// ---- keys: generated once, kept with the data they protect.
const keysPath = join(data, "keys.json");
const keys = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : {};
let generated = false;
const keep = (name, make) => {
  if (!keys[name]) { keys[name] = make(); generated = true; }
  return keys[name];
};
const hostTokenKey = keep("COMPUTER_HOST_TOKEN_KEY", () => randomBytes(32).toString("hex"));
const channelKey = keep("BLUE_CHANNEL_ENCRYPTION_KEY", () => randomBytes(32).toString("base64"));
const usageSecret = keep("BLUE_USAGE_HMAC_SECRET", () => randomBytes(32).toString("hex"));
const wireTicketKey = keep("WIRE_TICKET_KEY", () => randomBytes(32).toString("hex"));
if (generated) {
  writeFileSync(keysPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log(`generated gateway keys in ${keysPath}`);
}

// ---- the organization's host token (host-token.ts): `sph_` + base64url(HMAC(key, "calvin-host:" + org)).
const hostToken = `sph_${createHmac("sha256", hostTokenKey).update(`calvin-host:${org}`).digest("base64url")}`;
writeFileSync(join(data, "host-token"), `${hostToken}\n`, { mode: 0o600 });
chmodSync(join(data, "host-token"), 0o600);

// ---- the bundle.
let bundle = process.env.GATEWAY_BUNDLE;
if (!bundle) {
  const out = join(data, "bundle");
  execFileSync(join(managedAgents, "node_modules/.bin/wrangler"),
    ["deploy", "--dry-run", "--config", "wrangler.selfhost.jsonc", "--outdir", out],
    { cwd: managedAgents, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  bundle = join(out, "entry.js");
}

const name = "selfhost-gateway";
const sqlite = (className) => ({ className, useSQLite: true });
const mf = new Miniflare({
  host,
  port,
  durableObjectsPersist: join(data, "do"),
  d1Persist: join(data, "d1"),
  r2Persist: join(data, "r2"),
  kvPersist: join(data, "kv"),
  cachePersist: join(data, "cache"),
  workers: [{
    name,
    modules: true,
    scriptPath: bundle,
    modulesRoot: dirname(bundle),
    compatibilityDate: "2026-07-24",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      BLUE_ENVIRONMENT: "selfhost",
      BLUE_ACCOUNT_ID: org,
      BLUE_API_KEY: setupToken,
      SELFHOST_SETUP_TOKEN: setupToken,
      SELFHOST_HOST_URL: hostUrl,
      SELFHOST_HOST_TOKEN: hostToken,
      ...(process.env.SP_SETUP_OPEN === "1" ? { SP_SETUP_OPEN: "1" } : {}),
      COMPUTER_VMS: "self-managed",
      COMPUTER_HOST_TOKEN_KEY: hostTokenKey,
      BLUE_CHANNEL_ENCRYPTION_KEY: channelKey,
      BLUE_USAGE_HMAC_SECRET: usageSecret,
      WIRE_TICKET_KEY: wireTicketKey,
      ...(publicUrl ? { COMPUTER_PUBLIC_ORIGIN: publicUrl } : {}),
      ...(process.env.COMPUTER_ANTHROPIC_API_KEY ? { COMPUTER_ANTHROPIC_API_KEY: process.env.COMPUTER_ANTHROPIC_API_KEY } : {}),
    },
    durableObjects: {
      COMPUTERS: sqlite("ComputerDurableObject"),
      SESSION_LOG: sqlite("SessionLogDurableObject"),
      ORGS: sqlite("OrgDurableObject"),
      SLACK: sqlite("SlackDurableObject"),
      LIVE: sqlite("LiveDurableObject"),
      ACCOUNTS: sqlite("SelfhostAccountDurableObject"),
    },
    d1Databases: { SERVERLESS_AGENTS_DB: "selfhost" },
    r2Buckets: { SESSION_LOG_BLOBS: "session-log" },
    kvNamespaces: { WIRE_KEYS: "wire-keys" },
    serviceBindings: { EDGE: { name, entrypoint: "LiveCredentials" } },
  }],
});

const url = await mf.ready;

// ---- D1: apply migrations not applied yet, wrangler's way (a d1_migrations table).
const db = await mf.getD1Database("SERVERLESS_AGENTS_DB");
await db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)");
const applied = new Set((await db.prepare("SELECT name FROM d1_migrations").all()).results.map((r) => r.name));
const migrations = join(managedAgents, "migrations");
for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  const statements = readFileSync(join(migrations, file), "utf8")
    .split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  await db.batch([...statements.map((s) => db.prepare(s)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(file)]);
  console.log(`d1: applied ${file}`);
}

console.log(`gateway listening on ${url.href} (org ${org}; data ${data})`);
console.log(`host agent: SP_GATEWAY_URL=${hostUrl}, SP_HOST_TOKEN from ${join(data, "host-token")}`);
console.log(`setup: ${publicUrl || url.origin}/setup (sign in with SETUP_TOKEN)`);

const stop = async () => { await mf.dispose(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
