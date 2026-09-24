#!/usr/bin/env node
// Render + deploy an isolated api-edge preview stack (Worker + D1 + dashboard
// SPA) in the shared dev Cloudflare account, wired to the matching
// managed-agents stack created by `blue/scripts/stack.mjs`.
//
//   node scripts/stack.mjs <devin-name> render|up|status|seed-key|workos-redirect|destroy [--skip-dashboard]
//   node scripts/stack.mjs <devin-name> add-member --email <email>
//
// Stack names must start with `devin-`. Only `opencomputer-api-edge-devin-*`
// workers / `opencomputer-devin-*` databases are ever touched.
//
// Env: CLOUDFLARE_API_TOKEN (falls back to CLOUDFLARE_DEVIN_API_TOKEN),
//      WORKOS_STAGING_API_KEY/WORKOS_STAGING_CLIENT_ID (staging app only),
//      OPENROUTER_PROVISIONING_KEY, OC_STACK_HOME (default ~/.oc-stacks).
//
// Reads/writes $OC_STACK_HOME/<name>/stack.json and secrets.json shared with
// the blue script (OC_MANAGED_AGENTS_SECRET, OC_MANAGED_CRED_HMAC_SECRET and
// BLUE_USAGE_HMAC_SECRET must match on both sides). `seed-key` writes the
// CLI API key to $OC_STACK_HOME/<name>/api-key (mode 0600) — never to stdout.
// `up` registers <apiEdgeUrl>/auth/callback as a redirect URI on the staging
// WorkOS app (Management API) and `destroy` removes it. `add-member` pre-creates
// a dashboard user by email as owner of the seeded org, so that WorkOS login
// lands in the same org the CLI key deploys to.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const edgeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(edgeRoot, "../..");
const ACCOUNT_ID = "10a2123d1440c5fbf090968ca59bfb28";

const [, , rawName, command, ...rest] = process.argv;
const flags = parseFlags(rest);
if (!rawName || !command) usage();
if (!/^devin-[a-z0-9-]{1,30}$/.test(rawName)) {
  die(`stack name must match ^devin-[a-z0-9-]+$ (got "${rawName}")`);
}
const name = rawName;
const workerName = `opencomputer-api-edge-${name}`;
const d1Name = `opencomputer-${name}`;
const stackHome = path.join(
  process.env.OC_STACK_HOME ?? path.join(os.homedir(), ".oc-stacks"),
  name,
);
const stackFile = path.join(stackHome, "stack.json");
const secretsFile = path.join(stackHome, "secrets.json");
const apiKeyFile = path.join(stackHome, "api-key");
const configFile = path.join(edgeRoot, `wrangler.${name}.generated.jsonc`);
const cfToken =
  process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_DEVIN_API_TOKEN;

const WORKOS_API = "https://api.workos.com";

const commands = {
  render,
  up,
  status,
  "seed-key": seedKey,
  "workos-redirect": workosRedirect,
  "add-member": addMember,
  destroy,
};
if (!commands[command]) usage();
await commands[command]();

// ── commands ─────────────────────────────────────────────────────────────

async function render() {
  writeConfig(loadStack());
  console.log(configFile);
}

async function up() {
  requireToken();
  const stack = loadStack();
  const secrets = loadSecrets();
  if (!stack.edgeUrl)
    die(
      `stack.json has no edgeUrl — run blue/scripts/stack.mjs ${name} up first`,
    );
  stack.workersDevSubdomain ??= await workersDevSubdomain();
  stack.apiEdgeUrl = `https://${workerName}.${stack.workersDevSubdomain}.workers.dev`;
  stack.apiEdgeWorker = workerName;
  const { db, fresh } = await ensureD1(d1Name);
  stack.apiEdgeD1 = db;
  saveStack(stack);
  writeConfig(stack);

  if (!flags["skip-dashboard"]) buildDashboard();
  else fs.mkdirSync(path.join(edgeRoot, "assets"), { recursive: true });

  if (fresh) {
    step("d1 bootstrap from schema snapshot");
    wrangler([
      "d1",
      "execute",
      d1Name,
      "--remote",
      "--config",
      configFile,
      "--file",
      "schema-snapshots/current_schema.sql",
      "--yes",
    ]);
  }
  step("d1 migrations");
  wrangler([
    "d1",
    "migrations",
    "apply",
    d1Name,
    "--remote",
    "--config",
    configFile,
  ]);

  step("api-edge worker");
  deploy({
    WORKOS_API_KEY: env("WORKOS_STAGING_API_KEY"),
    WORKOS_CLIENT_ID: env("WORKOS_STAGING_CLIENT_ID"),
    OPENROUTER_PROVISIONING_KEY: env("OPENROUTER_PROVISIONING_KEY"),
    OC_MANAGED_AGENTS_SECRET: secrets.OC_MANAGED_AGENTS_SECRET,
    OC_MANAGED_CRED_HMAC_SECRET: secrets.OC_MANAGED_CRED_HMAC_SECRET,
    AGENT_RUNTIME_USAGE_HMAC_SECRET: secrets.BLUE_USAGE_HMAC_SECRET,
    SESSION_JWT_SECRET: secrets.SESSION_JWT_SECRET,
    CF_ADMIN_SECRET: secrets.CF_ADMIN_SECRET,
    SECRET_ENCRYPTION_KEY: secrets.SECRET_ENCRYPTION_KEY,
    OC_ORG_TOKEN_SECRET: secrets.OC_ORG_TOKEN_SECRET,
    OC_PROVISION_SECRET: secrets.OC_PROVISION_SECRET,
    EVENT_SECRET: secrets.EVENT_SECRET,
  });

  stack.apiEdgeDeployedAt = new Date().toISOString();
  saveStack(stack);
  if (!fs.existsSync(apiKeyFile)) await seedKey();
  await workosRedirect();
  console.log(
    JSON.stringify(
      { name, apiEdgeUrl: stack.apiEdgeUrl, d1: db, apiKeyFile, stackFile },
      null,
      2,
    ),
  );
  console.log(
    `Blue edge must point back here: node blue/scripts/stack.mjs ${name} up --api-edge-url ${stack.apiEdgeUrl}`,
  );
}

async function seedKey() {
  requireToken();
  const stack = loadStack();
  if (!stack.apiEdgeD1) die("api-edge D1 not provisioned — run `up` first");
  writeConfig(stack);
  const orgId = stack.orgId ?? randomUUID();
  const apiKey = `osb_${randomBytes(24).toString("base64url")}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  const sql = [
    `INSERT OR IGNORE INTO orgs (id, name, slug, plan, home_cell, is_personal, created_at, updated_at, billing_provider)
       VALUES ('${orgId}', 'Devin ${name}', '${name}', 'pro', '${name}', 0, ${now}, ${now}, 'legacy');`,
    `INSERT INTO api_keys (id, org_id, created_by, key_hash, key_prefix, name, scopes, created_at)
       VALUES ('${randomUUID()}', '${orgId}', NULL, '${keyHash}', '${apiKey.slice(0, 8)}', 'devin-verify', 'sandbox:*', ${now});`,
  ].join("\n");
  const sqlFile = path.join(stackHome, ".seed.sql");
  fs.writeFileSync(sqlFile, sql, { mode: 0o600 });
  try {
    step("seed org + api key");
    wrangler([
      "d1",
      "execute",
      d1Name,
      "--remote",
      "--config",
      configFile,
      "--file",
      sqlFile,
      "--yes",
    ]);
  } finally {
    fs.rmSync(sqlFile, { force: true });
  }
  fs.writeFileSync(apiKeyFile, apiKey, { mode: 0o600 });
  stack.orgId = orgId;
  saveStack(stack);
  console.log(`api key written to ${apiKeyFile} (org ${orgId})`);
}

async function workosRedirect() {
  const stack = loadStack();
  if (!stack.apiEdgeUrl) die("stack.json has no apiEdgeUrl — run `up` first");
  const uri = `${stack.apiEdgeUrl}/auth/callback`;
  const existing = await workosRedirectUris();
  if (existing.some((r) => r.uri === uri)) {
    console.log(`workos redirect uri already registered: ${uri}`);
    return;
  }
  step(`workos redirect uri ${uri}`);
  await workos("/user_management/redirect_uris", {
    method: "POST",
    body: JSON.stringify({ uri }),
  });
}

async function addMember() {
  requireToken();
  const email = flags.email;
  if (typeof email !== "string" || !/^[^\s'@]+@[^\s']+$/.test(email))
    die("add-member requires --email <address>");
  const stack = loadStack();
  if (!stack.orgId) die("no seeded org — run `seed-key` first");
  if (!stack.apiEdgeD1?.id) die("api-edge D1 not provisioned — run `up` first");
  const now = Math.floor(Date.now() / 1000);
  step(`add ${email} as owner of org ${stack.orgId}`);
  // The login handler upserts on email and keeps the existing user id, so a
  // pre-created row inherits this membership on first WorkOS sign-in.
  await d1Query(
    stack.apiEdgeD1.id,
    `INSERT OR IGNORE INTO users (id, email, name, created_at, durable_sessions_enabled, infrastructure_enabled)
       VALUES (?1, ?2, ?2, ?3, 0, 0)`,
    [randomUUID(), email, now],
  );
  await d1Query(
    stack.apiEdgeD1.id,
    `INSERT OR IGNORE INTO org_memberships (org_id, user_id, role, created_at)
       SELECT ?1, id, 'owner', ?2 FROM users WHERE email = ?3`,
    [stack.orgId, now, email],
  );
  await d1Query(
    stack.apiEdgeD1.id,
    `UPDATE orgs SET owner_user_id = (SELECT id FROM users WHERE email = ?2), updated_at = ?3
       WHERE id = ?1 AND owner_user_id IS NULL`,
    [stack.orgId, email, now],
  );
}

async function status() {
  requireToken();
  const stack = fs.existsSync(stackFile) ? loadStack() : null;
  const d1 = await findD1(d1Name);
  const out = {
    name,
    worker: (await workerExists(workerName)) ? "deployed" : "absent",
    d1: d1 ? { name: d1.name, id: d1.uuid } : "absent",
    apiEdgeUrl: stack?.apiEdgeUrl ?? null,
    apiKeyFile: fs.existsSync(apiKeyFile) ? apiKeyFile : null,
  };
  if (stack?.apiEdgeUrl) {
    try {
      const res = await fetch(
        `${stack.apiEdgeUrl}/api/managed-agents/v1/agents`,
      );
      out.apiEdgeReachable = res.status;
    } catch (error) {
      out.apiEdgeReachable = String(error);
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

async function destroy() {
  requireToken();
  if (await workerExists(workerName)) {
    step(`delete worker ${workerName}`);
    await cf(`/workers/scripts/${workerName}?force=true`, { method: "DELETE" });
  }
  const d1 = await findD1(d1Name);
  if (d1) {
    step(`delete d1 ${d1.name}`);
    await cf(`/d1/database/${d1.uuid}`, { method: "DELETE" });
  }
  fs.rmSync(configFile, { force: true });
  fs.rmSync(apiKeyFile, { force: true });
  let strandedCallback = null;
  if (fs.existsSync(stackFile)) {
    const stack = loadStack();
    if (stack.apiEdgeUrl) {
      const uri = `${stack.apiEdgeUrl}/auth/callback`;
      if (process.env.WORKOS_STAGING_API_KEY) {
        for (const r of await workosRedirectUris()) {
          if (r.uri !== uri) continue;
          step(`remove workos redirect uri ${uri}`);
          await workos(`/user_management/redirect_uris/${r.id}`, {
            method: "DELETE",
          });
        }
      } else {
        strandedCallback = uri;
      }
    }
    for (const key of [
      "apiEdgeWorker",
      "apiEdgeD1",
      "apiEdgeDeployedAt",
      "orgId",
    ])
      delete stack[key];
    // Keep apiEdgeUrl until the WorkOS callback is confirmed gone, so a retry
    // with WORKOS_STAGING_API_KEY set can still find and delete it.
    if (!strandedCallback) delete stack.apiEdgeUrl;
    saveStack(stack);
  }
  console.log(`destroyed ${name} (api-edge side)`);
  if (strandedCallback)
    console.warn(
      `WORKOS_STAGING_API_KEY unset: redirect uri ${strandedCallback} still registered; rerun destroy with the key to remove it`,
    );
}

// ── config rendering ─────────────────────────────────────────────────────

function writeConfig(stack) {
  // Rate-limit namespace ids must be unique per account; derive from the name.
  const base =
    2_100_000_000 +
    (parseInt(createHash("sha1").update(name).digest("hex").slice(0, 6), 16) %
      1_000_000) *
      2;
  const config = {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: workerName,
    account_id: ACCOUNT_ID,
    main: "src/index.ts",
    compatibility_date: "2026-04-28",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: false,
    assets: {
      directory: "./assets",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: true,
    },
    d1_databases: [
      {
        binding: "OPENCOMPUTER_DB",
        database_name: d1Name,
        database_id:
          stack.apiEdgeD1?.id ?? "00000000-0000-0000-0000-000000000000",
        migrations_dir: "migrations",
      },
    ],
    ratelimits: [
      {
        name: "CLI_AUTH_START_RATE_LIMIT",
        namespace_id: String(base),
        simple: { limit: 30, period: 60 },
      },
      {
        name: "CLI_AUTH_EXCHANGE_RATE_LIMIT",
        namespace_id: String(base + 1),
        simple: { limit: 180, period: 60 },
      },
    ],
    durable_objects: {
      bindings: [{ name: "CREDIT_ACCOUNT", class_name: "CreditAccount" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["CreditAccount"] }],
    vars: {
      WORKER_ENV: name,
      BURST_CELL_ID: "",
      MANAGED_AGENTS_API_URL: stack.edgeUrl ?? "",
      SESSIONS_API_URL: stack.edgeUrl ?? "",
      MANAGED_DEFAULT_BUDGET_USD: "5",
    },
    observability: { enabled: true, head_sampling_rate: 1 },
  };
  fs.writeFileSync(
    configFile,
    `// generated by scripts/stack.mjs — do not commit\n${JSON.stringify(config, null, 2)}\n`,
  );
}

function buildDashboard() {
  step("build dashboard SPA");
  const web = path.join(repoRoot, "web");
  if (!fs.existsSync(path.join(web, "node_modules")))
    run("npm", ["ci", "--no-audit", "--no-fund"], web);
  run("npm", ["run", "build"], web);
  const assets = path.join(edgeRoot, "assets");
  fs.rmSync(assets, { recursive: true, force: true });
  fs.cpSync(path.join(web, "dist"), assets, { recursive: true });
}

// ── cloudflare api ───────────────────────────────────────────────────────

async function cf(pathname, init = {}) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${pathname}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${cfToken}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(
      `cloudflare ${init.method ?? "GET"} ${pathname}: ${res.status} ${JSON.stringify(body.errors ?? body)}`,
    );
  }
  return body.result;
}

async function workersDevSubdomain() {
  return (await cf("/workers/subdomain")).subdomain;
}

async function workerExists(worker) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${worker}/settings`,
    {
      headers: { authorization: `Bearer ${cfToken}` },
    },
  );
  return res.ok;
}

async function d1Query(databaseId, sql, params) {
  return cf(`/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
}

async function findD1(dbName) {
  const list = await cf(`/d1/database?name=${encodeURIComponent(dbName)}`);
  return list.find((db) => db.name === dbName) ?? null;
}

async function ensureD1(dbName) {
  let existing = await findD1(dbName);
  if (!existing) {
    step(`create d1 ${dbName}`);
    existing = await cf("/d1/database", {
      method: "POST",
      body: JSON.stringify({ name: dbName, primary_location_hint: "apac" }),
    });
  }
  const db = { name: existing.name, id: existing.uuid };
  return { db, fresh: !(await d1HasTable(db.id, "orgs")) };
}

async function d1HasTable(dbId, table) {
  const result = await cf(`/d1/database/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      params: [table],
    }),
  });
  return (result[0]?.results?.length ?? 0) > 0;
}

// ── wrangler ─────────────────────────────────────────────────────────────

function deploy(secrets) {
  const tmp = path.join(stackHome, ".secrets-api-edge.json");
  fs.writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 });
  try {
    wrangler(["deploy", "--config", configFile, "--secrets-file", tmp]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function workos(pathname, init = {}) {
  const res = await fetch(`${WORKOS_API}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env("WORKOS_STAGING_API_KEY")}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok)
    die(`workos ${init.method ?? "GET"} ${pathname} failed: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function workosRedirectUris() {
  const all = [];
  let after = null;
  for (;;) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    const body = await workos(`/user_management/redirect_uris?${qs}`);
    const page = body?.data ?? [];
    all.push(...page);
    after = body?.list_metadata?.after ?? null;
    if (!after || page.length === 0) break;
  }
  return all;
}

function wrangler(args) {
  run("npx", ["wrangler", ...args], edgeRoot);
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: cfToken,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      WRANGLER_SEND_METRICS: "false",
    },
  });
  if (result.status !== 0)
    die(`${cmd} ${args.slice(0, 3).join(" ")} failed (exit ${result.status})`);
}

// ── state ────────────────────────────────────────────────────────────────

function loadStack() {
  fs.mkdirSync(stackHome, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(stackFile))
    return { name, accountId: ACCOUNT_ID, createdAt: new Date().toISOString() };
  return JSON.parse(fs.readFileSync(stackFile, "utf8"));
}

function saveStack(stack) {
  fs.mkdirSync(stackHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stackFile, `${JSON.stringify(stack, null, 2)}\n`);
}

function loadSecrets() {
  fs.mkdirSync(stackHome, { recursive: true, mode: 0o700 });
  const secrets = fs.existsSync(secretsFile)
    ? JSON.parse(fs.readFileSync(secretsFile, "utf8"))
    : {};
  for (const key of [
    "OC_MANAGED_AGENTS_SECRET",
    "OC_MANAGED_CRED_HMAC_SECRET",
    "BLUE_USAGE_HMAC_SECRET",
    "SESSION_JWT_SECRET",
    "CF_ADMIN_SECRET",
    "SECRET_ENCRYPTION_KEY",
    "OC_ORG_TOKEN_SECRET",
    "OC_PROVISION_SECRET",
    "EVENT_SECRET",
  ]) {
    secrets[key] ??= randomBytes(32).toString("hex");
  }
  fs.writeFileSync(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`, {
    mode: 0o600,
  });
  return secrets;
}

// ── helpers ──────────────────────────────────────────────────────────────

function env(primary, fallback) {
  const value =
    process.env[primary] ?? (fallback ? process.env[fallback] : undefined);
  if (!value)
    die(`missing env ${primary}${fallback ? ` (or ${fallback})` : ""}`);
  return value;
}

function requireToken() {
  if (!cfToken)
    die("missing env CLOUDFLARE_API_TOKEN (or CLOUDFLARE_DEVIN_API_TOKEN)");
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) die(`unexpected argument ${arg}`);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[arg.slice(2)] = next;
      i++;
    } else out[arg.slice(2)] = true;
  }
  return out;
}

function step(label) {
  console.log(`\n▶ [${name}] ${label}`);
}

function usage() {
  console.error(
    "usage: node scripts/stack.mjs <devin-name> render|up|status|seed-key|workos-redirect|destroy [--skip-dashboard]\n" +
      "       node scripts/stack.mjs <devin-name> add-member --email <email>",
  );
  process.exit(2);
}

function die(message) {
  console.error(`stack.mjs: ${message}`);
  process.exit(1);
}
