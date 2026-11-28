// The self-hosted gateway (spike), under Miniflare, every Durable Object, D1, R2 and KV write
// persisted under GATEWAY_DATA (default /data). Three Workers behind one port:
//
// - managed-agents' Computer path (services/managed-agents/src/selfhost/entry.ts): /setup,
//   /healthz, /v1/* (the host's WebSocket, the operator API, Slack's webhooks).
// - api-edge (cloudflare-workers/api-edge) with SELFHOST=1: WorkOS sign-in, the dashboard's API
//   and the web dashboard (web/dist, built with VITE_SELFHOST=1) as its assets. It reaches
//   managed-agents at https://managed-agents.selfhost, which its outbound router sends to the
//   managed-agents Worker, with the hosted OC_MANAGED_AGENTS_SECRET assertion.
// - the router in front, which splits paths between the two.
//
//   SETUP_TOKEN=… node serve.mjs
//
// Env: SETUP_TOKEN (required; the operator's bearer on /v1/computer/*), GATEWAY_DATA (/data),
// PORT (8080), HOST (0.0.0.0), GATEWAY_ORG (org_selfhost), GATEWAY_BUNDLE (a prebuilt
// entry.js; unset: built now with wrangler from MANAGED_AGENTS_DIR), EDGE_BUNDLE (a prebuilt
// api-edge index.js; unset: built now from API_EDGE_DIR), WEB_DIST (the built dashboard; default
// web/dist), COMPUTER_ANTHROPIC_API_KEY
// (optional, the sessions' shared model key), PUBLIC_URL (or SP_ORIGIN; the public https origin),
// SP_SETUP_OPEN (1: /setup stays open once complete), GATEWAY_PORT (the host-side port the host
// agent dials, for /setup's install command; default PORT), ATTACHMENTS_S3_ENDPOINT, ATTACHMENTS_S3_BUCKET,
// ATTACHMENTS_S3_ACCESS_KEY_ID, ATTACHMENTS_S3_SECRET_ACCESS_KEY, ATTACHMENTS_S3_REGION (optional: an
// S3-compatible store for attachments; unset, they are kept in GATEWAY_DATA/r2 and served by the gateway).
//
// Keys the gateway needs and nobody types (the host token key, the store key, the key that signs
// attachment URLs, the secrets api-edge and managed-agents share) are generated on
// first start into GATEWAY_DATA/keys.json (0600). The organization's host token is written to
// GATEWAY_DATA/host-token (0600) for the host agent's SP_HOST_TOKEN; it is never printed.

import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const managedAgents = resolve(process.env.MANAGED_AGENTS_DIR ?? join(here, "../../services/managed-agents"));
const apiEdge = resolve(process.env.API_EDGE_DIR ?? join(here, "../../cloudflare-workers/api-edge"));
const webDist = resolve(process.env.WEB_DIST ?? join(here, "../../web/dist"));
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
// Signs the URLs an attachment is uploaded to and read from (managed-agents' attachment-objects.ts).
const attachmentsUrlKey = keep("ATTACHMENTS_URL_KEY", () => randomBytes(32).toString("hex"));
// An operator's own S3-compatible store for attachments, used instead of the bucket when all four are set.
const attachmentsS3 = Object.fromEntries(
  ["ATTACHMENTS_S3_ENDPOINT", "ATTACHMENTS_S3_BUCKET", "ATTACHMENTS_S3_ACCESS_KEY_ID", "ATTACHMENTS_S3_SECRET_ACCESS_KEY", "ATTACHMENTS_S3_REGION"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);
// api-edge's, as api-edge/scripts/stack.mjs generates them for a preview stack.
const hex = () => randomBytes(32).toString("hex");
const edgeSecrets = Object.fromEntries(
  ["OC_MANAGED_AGENTS_SECRET", "OC_MANAGED_CRED_HMAC_SECRET", "SESSION_JWT_SECRET", "CF_ADMIN_SECRET", "SECRET_ENCRYPTION_KEY", "EVENT_SECRET"].map((k) => [k, keep(k, hex)]),
);
if (generated) {
  writeFileSync(keysPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log(`generated gateway keys in ${keysPath}`);
}

// ---- the organization's host token (host-token.ts): `sph_` + base64url(HMAC(key, "calvin-host:" + org)).
const hostToken = `sph_${createHmac("sha256", hostTokenKey).update(`calvin-host:${org}`).digest("base64url")}`;
writeFileSync(join(data, "host-token"), `${hostToken}\n`, { mode: 0o600 });
chmodSync(join(data, "host-token"), 0o600);

// ---- the bundles.
const wranglerBundle = (dir, args, out) =>
  execFileSync(join(dir, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", ...args, "--outdir", out],
    { cwd: dir, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
let bundle = process.env.GATEWAY_BUNDLE;
if (!bundle) {
  wranglerBundle(managedAgents, ["--config", "wrangler.selfhost.jsonc"], join(data, "bundle"));
  bundle = join(data, "bundle", "entry.js");
}
let edgeBundle = process.env.EDGE_BUNDLE;
if (!edgeBundle) {
  mkdirSync(join(apiEdge, "assets"), { recursive: true }); // wrangler checks the assets directory exists
  wranglerBundle(apiEdge, [], join(data, "edge-bundle"));
  edgeBundle = join(data, "edge-bundle", "index.js");
}
if (!existsSync(join(webDist, "index.html"))) {
  console.error(`no dashboard build at ${webDist} (cd web && VITE_SELFHOST=1 npm run build)`);
  process.exit(1);
}

// The router in front: managed-agents' paths, everything else to api-edge.
const routerScript = `
const SLACK_CALLBACK_PATH = "/api/managed-agents/computer/slack/callback";
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    // Behind the tunnel the request arrives as http://; addressed to PUBLIC_URL's host, it is PUBLIC_URL's
    // scheme, so api-edge's WorkOS redirect URI (<origin>/auth/callback) is the registered one.
    if (env.PUBLIC_URL) {
      const pub = new URL(env.PUBLIC_URL);
      if (url.host === pub.host && url.protocol !== pub.protocol) {
        url.protocol = pub.protocol;
        request = new Request(url, request);
      }
    }
    const managedAgents =
      p === "/healthz" || p === "/setup" || p.startsWith("/setup/") || p.startsWith("/v1/") || p === SLACK_CALLBACK_PATH ||
      // Slack's install outcome (COMPUTER_PUBLIC_ORIGIN/computer?slack=…), for an operator who may not sign in.
      (p === "/computer" && url.searchParams.has("slack"));
    return (managedAgents ? env.MANAGED_AGENTS : env.EDGE).fetch(request);
  },
};`;
// api-edge's outbound: https://managed-agents.selfhost (its MANAGED_AGENTS_API_URL) is the Worker; the rest is the internet.
const egressScript = `
export default {
  fetch(request, env) {
    return new URL(request.url).hostname === "managed-agents.selfhost" ? env.MANAGED_AGENTS.fetch(request) : fetch(request);
  },
};`;

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
    name: "router",
    modules: true,
    script: routerScript,
    compatibilityDate: "2026-07-24",
    bindings: publicUrl ? { PUBLIC_URL: publicUrl } : {},
    serviceBindings: { MANAGED_AGENTS: name, EDGE: "api-edge" },
  }, {
    name: "egress",
    modules: true,
    script: egressScript,
    compatibilityDate: "2026-07-24",
    serviceBindings: { MANAGED_AGENTS: name },
  }, {
    name: "api-edge",
    modules: true,
    scriptPath: edgeBundle,
    modulesRoot: dirname(edgeBundle),
    compatibilityDate: "2026-04-28",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      WORKER_ENV: "selfhost",
      SELFHOST: "1",
      SELFHOST_ORG_ID: org,
      COMPUTER_ENABLED_FOR_ALL: "true",
      MANAGED_AGENTS_API_URL: "https://managed-agents.selfhost",
      // Filled from /setup on each sign-in request (api-edge src/selfhost.ts).
      WORKOS_CLIENT_ID: "",
      WORKOS_API_KEY: "",
      AGENT_RUNTIME_USAGE_HMAC_SECRET: usageSecret,
      ...edgeSecrets,
    },
    d1Databases: { OPENCOMPUTER_DB: "api-edge" },
    kvNamespaces: { SESSIONS_KV: "sessions" },
    durableObjects: { CREDIT_ACCOUNT: sqlite("CreditAccount") },
    ratelimits: {
      CLI_AUTH_START_RATE_LIMIT: { namespace_id: "2026072421", simple: { limit: 30, period: 60 } },
      CLI_AUTH_EXCHANGE_RATE_LIMIT: { namespace_id: "2026072422", simple: { limit: 180, period: 60 } },
      COMPUTER_CONNECT_RATE_LIMIT: { namespace_id: "2026102321", simple: { limit: 20, period: 60 } },
      COMPUTER_API_RATE_LIMIT: { namespace_id: "2026102621", simple: { limit: 600, period: 60 } },
    },
    serviceBindings: { SELFHOST_SETUP: { name, entrypoint: "SelfhostSignIn" } },
    outboundService: "egress",
    assets: {
      directory: webDist,
      binding: "ASSETS",
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      assetConfig: { not_found_handling: "single-page-application" },
    },
  }, {
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
      ATTACHMENTS_URL_KEY: attachmentsUrlKey,
      ...attachmentsS3,
      // api-edge's assertion (x-opencomputer-agent-token) and credential handoff.
      OC_MANAGED_AGENTS_SECRET: edgeSecrets.OC_MANAGED_AGENTS_SECRET,
      OC_MANAGED_CRED_HMAC_SECRET: edgeSecrets.OC_MANAGED_CRED_HMAC_SECRET,
      ...(publicUrl ? { OPENCOMPUTER_APP_URL: publicUrl } : {}),
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
    r2Buckets: { SESSION_LOG_BLOBS: "session-log", ATTACHMENTS: "attachments" },
    kvNamespaces: { WIRE_KEYS: "wire-keys" },
    serviceBindings: { EDGE: { name, entrypoint: "LiveCredentials" } },
  }],
});

const url = await mf.ready;

// ---- D1: apply migrations not applied yet, wrangler's way (a d1_migrations table).
const sqlStatements = (path) =>
  readFileSync(path, "utf8").split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
async function migrate(binding, dir, label, snapshot) {
  const db = await mf.getD1Database(binding, binding === "OPENCOMPUTER_DB" ? "api-edge" : name);
  const fresh = !(await db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'd1_migrations'").first());
  await db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  // A new database starts from the schema snapshot, as api-edge's README says.
  if (fresh && snapshot) {
    await db.batch(sqlStatements(snapshot).map((s) => db.prepare(s)));
    console.log(`d1 ${label}: applied the schema snapshot`);
  }
  const applied = new Set((await db.prepare("SELECT name FROM d1_migrations").all()).results.map((r) => r.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    await db.batch([...sqlStatements(join(dir, file)).map((s) => db.prepare(s)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(file)]);
    console.log(`d1 ${label}: applied ${file}`);
  }
}
await migrate("SERVERLESS_AGENTS_DB", join(managedAgents, "migrations"), "managed-agents");
await migrate("OPENCOMPUTER_DB", join(apiEdge, "migrations"), "api-edge", join(apiEdge, "schema-snapshots/current_schema.sql"));

console.log(`gateway listening on ${url.href} (org ${org}; data ${data})`);
console.log(`host agent: SP_GATEWAY_URL=${hostUrl}, SP_HOST_TOKEN from ${join(data, "host-token")}`);
console.log(`setup: ${publicUrl || url.origin}/setup (sign in with SETUP_TOKEN)`);
console.log(`dashboard: ${publicUrl || url.origin}/ (WorkOS sign-in, once /setup has the WorkOS app)`);

const stop = async () => { await mf.dispose(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
