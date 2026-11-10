#!/usr/bin/env node
// Render + deploy an isolated managed-agents preview stack (edge, platform,
// Workerd runtime, D1) in a development Cloudflare account.
//
//   node scripts/stack.mjs <devin-name> render|up|status|destroy [--api-edge-url URL]
//                                       [--runtime-image ARN --runtime-image-version V]
//
// Stack names must start with `devin-`. Only `devin-*` workers/databases are
// ever touched; the production configs are never read for deploys.
//
// Env: OC_STACK_CLOUDFLARE_ACCOUNT_ID (the account the stack lives in),
//      OC_STACK_EDGE_DOMAIN (a zone in that account, for the edge's custom domain),
//      OC_STACK_AWS_REGION, OC_STACK_ARTIFACT_BUCKET and OC_STACK_RUNTIME_IMAGE_ARN
//      (artifact storage and the default MicroVM runtime image),
//      CLOUDFLARE_API_TOKEN (falls back to CLOUDFLARE_DEVIN_API_TOKEN),
//      AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (fall back to
//      AWS_DEVIN_MICROVM_ACCESS_KEY_ID/AWS_DEVIN_MICROVM_SECRET_ACCESS_KEY),
//      OPENROUTER_API_KEY (falls back to OPENROUTER_DEVIN_API_KEY),
//      OC_STACK_HOME (default ~/.oc-stacks).
//      Optional, forwarded to the edge when set so GitHub-backed deploys work
//      on the stack: OC_STACK_GITHUB_APP_ID / _SLUG / _CLIENT_ID (vars),
//      OC_STACK_GITHUB_APP_PRIVATE_KEY / _CLIENT_SECRET / _WEBHOOK_SECRET,
//      OC_STACK_TRIGGER_SECRET_KEY, OC_STACK_TRIGGER_API_URL and
//      OC_STACK_TEMPLATE_TASK_SECRET (secrets).
//      Computers (work 052), all optional: OC_STACK_COMPUTER_CONFIG = path of
//      a JSON file {subscriptionId, resourceGroup, region, subnetId,
//      identityId, identityClientId, bootstrapUrl, defaultSize?, paidSize?,
//      diskGiB?} (copied into stack.json); OC_STACK_AZURE_TENANT_ID /
//      _CLIENT_ID / _CLIENT_SECRET (platform secrets);
//      OC_STACK_SLACK_COMPUTER_CLIENT_ID (var), _CLIENT_SECRET and
//      _SIGNING_SECRET; OC_STACK_COMPUTER_ANTHROPIC_API_KEY (edge secret).
//      OC_STACK_COMPUTER_POOL_SIZE (var COMPUTER_POOL_SIZE, default "0": no
//      warm pool). COMPUTER_HOST_TOKEN_KEY is generated into secrets.json. AWS credentials
//      are optional; without them artifact storage fails but computers work.
//
// State lives in $OC_STACK_HOME/<name>/stack.json (ids, urls) and
// secrets.json (generated shared secrets, mode 0600). Secrets are only ever
// written to the stack home or streamed to wrangler via --secrets-file.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ACCOUNT_ID = stackEnv("OC_STACK_CLOUDFLARE_ACCOUNT_ID");
const AWS = {
  BLUE_AWS_REGION: stackEnv("OC_STACK_AWS_REGION"),
  BLUE_ARTIFACT_BUCKET: stackEnv("OC_STACK_ARTIFACT_BUCKET"),
};
const DEVIN_RUNTIME_IMAGE_NAME = "managed-agents-devin-runtime";
const DEVIN_RUNTIME_IMAGE_ARN = stackEnv("OC_STACK_RUNTIME_IMAGE_ARN");
const DEFAULT_RUNTIME_IMAGE = { arn: DEVIN_RUNTIME_IMAGE_ARN, version: "1.0" };

const [, , rawName, command, ...rest] = process.argv;
const flags = parseFlags(rest);
if (!rawName || !command) usage();
if (!/^devin-[a-z0-9-]{1,30}$/.test(rawName)) {
  die(`stack name must match ^devin-[a-z0-9-]+$ (got "${rawName}")`);
}
const name = rawName;
const names = {
  edge: `managed-agents-edge-${name}`,
  platform: `managed-agents-platform-${name}`,
  workerd: `managed-agents-workerd-${name}`,
  d1: `serverless-agents-${name}`,
  apiEdge: `opencomputer-api-edge-${name}`,
};
const stackHome = path.join(
  process.env.OC_STACK_HOME ?? path.join(os.homedir(), ".oc-stacks"),
  name,
);
const stackFile = path.join(stackHome, "stack.json");
const secretsFile = path.join(stackHome, "secrets.json");
const cfToken =
  process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_DEVIN_API_TOKEN;
// Worker-to-worker subrequests on *.workers.dev never reach the target, so the
// edge (called by the api-edge Worker) needs a custom domain.
const EDGE_DOMAIN = stackEnv("OC_STACK_EDGE_DOMAIN");

const commands = { render, up, status, destroy };
if (!commands[command]) usage();
await commands[command]();

// ── commands ─────────────────────────────────────────────────────────────

async function render() {
  const stack = loadStack();
  const files = writeConfigs(stack, { bootstrap: false });
  console.log(
    Object.values(files)
      .filter((file) => fs.existsSync(file))
      .join("\n"),
  );
}

async function up() {
  requireEnv(["CLOUDFLARE_API_TOKEN"]);
  const stack = loadStack();
  const secrets = loadSecrets();
  stack.accountId = ACCOUNT_ID;
  stack.workersDevSubdomain ??= await workersDevSubdomain();
  stack.d1 = await ensureD1(names.d1);
  stack.edgeHost = `${names.edge}.${EDGE_DOMAIN}`;
  stack.edgeUrl = `https://${stack.edgeHost}`;
  if (flags["api-edge-url"]) stack.apiEdgeUrl = flags["api-edge-url"];
  stack.runtimeImage ??= { ...DEFAULT_RUNTIME_IMAGE };
  if (process.env.OC_STACK_COMPUTER_CONFIG) {
    stack.computer = JSON.parse(
      fs.readFileSync(process.env.OC_STACK_COMPUTER_CONFIG, "utf8"),
    );
  }
  if (
    Boolean(flags["runtime-image"]) !== Boolean(flags["runtime-image-version"])
  )
    die("--runtime-image and --runtime-image-version must be given together");
  if (flags["runtime-image"]) {
    stack.runtimeImage = {
      arn: flags["runtime-image"],
      version: String(flags["runtime-image-version"]),
    };
  }
  stack.workers = names;
  saveStack(stack);

  const workerdExists = await workerExists(names.workerd);
  const edgeExists = await workerExists(names.edge);
  const bootstrap = !workerdExists || !edgeExists;
  const files = writeConfigs(stack, { bootstrap });

  step("platform");
  deploy(files.platform, {
    ...awsCredentials(),
    ...optionalSecrets({
      AZURE_TENANT_ID: "OC_STACK_AZURE_TENANT_ID",
      AZURE_CLIENT_ID: "OC_STACK_AZURE_CLIENT_ID",
      AZURE_CLIENT_SECRET: "OC_STACK_AZURE_CLIENT_SECRET",
    }),
    ...optionalSecrets(
      { MODAL_SHIM_TOKEN: "OC_STACK_MODAL_SHIM_TOKEN" },
      secrets,
    ),
  });

  const edgeSecrets = {
    // OPENROUTER_API_KEY wins over the devin fallback; both are optional.
    ...optionalSecrets({ OPENROUTER_API_KEY: "OPENROUTER_DEVIN_API_KEY" }),
    ...optionalSecrets({ OPENROUTER_API_KEY: "OPENROUTER_API_KEY" }),
    OC_MANAGED_AGENTS_SECRET: secrets.OC_MANAGED_AGENTS_SECRET,
    OC_MANAGED_CRED_HMAC_SECRET: secrets.OC_MANAGED_CRED_HMAC_SECRET,
    BLUE_USAGE_HMAC_SECRET: secrets.BLUE_USAGE_HMAC_SECRET,
    BLUE_CHANNEL_ENCRYPTION_KEY: secrets.BLUE_CHANNEL_ENCRYPTION_KEY,
    BLUE_SESSION_INDEX_ADMIN_SECRET: secrets.BLUE_SESSION_INDEX_ADMIN_SECRET,
    COMPUTER_HOST_TOKEN_KEY: secrets.COMPUTER_HOST_TOKEN_KEY,
    ...optionalSecrets({
      SLACK_COMPUTER_CLIENT_SECRET: "OC_STACK_SLACK_COMPUTER_CLIENT_SECRET",
      SLACK_COMPUTER_SIGNING_SECRET: "OC_STACK_SLACK_COMPUTER_SIGNING_SECRET",
      COMPUTER_ANTHROPIC_API_KEY: "OC_STACK_COMPUTER_ANTHROPIC_API_KEY",
    }),
    ...optionalSecrets(
      {
        OC_GITHUB_APP_PRIVATE_KEY: "OC_STACK_GITHUB_APP_PRIVATE_KEY",
        OC_GITHUB_APP_CLIENT_SECRET: "OC_STACK_GITHUB_APP_CLIENT_SECRET",
        OC_GITHUB_APP_WEBHOOK_SECRET: "OC_STACK_GITHUB_APP_WEBHOOK_SECRET",
        TRIGGER_SECRET_KEY: "OC_STACK_TRIGGER_SECRET_KEY",
        TRIGGER_API_URL: "OC_STACK_TRIGGER_API_URL",
        OPENCOMPUTER_TEMPLATE_TASK_SECRET: "OC_STACK_TEMPLATE_TASK_SECRET",
      },
      secrets,
    ),
  };
  if (bootstrap) {
    // Edge ⇄ Workerd bind to each other (service binding one way, MEMORY
    // Durable Object the other). First deploy of the edge omits the Workerd
    // service binding so the Workerd worker can bind to the edge's DO class.
    step("edge (bootstrap, no WORKERD_RUNTIME binding)");
    deploy(files.edgeBootstrap, edgeSecrets);
  }

  step("workerd runtime");
  deploy(
    files.workerd,
    edgeSecrets.OPENROUTER_API_KEY
      ? { OPENROUTER_API_KEY: edgeSecrets.OPENROUTER_API_KEY }
      : {},
  );

  step("d1 migrations");
  wrangler([
    "d1",
    "migrations",
    "apply",
    names.d1,
    "--remote",
    "--config",
    files.edge,
  ]);

  step("edge");
  deploy(files.edge, edgeSecrets);

  stack.deployedAt = new Date().toISOString();
  saveStack(stack);
  console.log(
    JSON.stringify(
      { name, edgeUrl: stack.edgeUrl, d1: stack.d1, stackFile },
      null,
      2,
    ),
  );
}

async function status() {
  requireEnv(["CLOUDFLARE_API_TOKEN"]);
  const stack = fs.existsSync(stackFile) ? loadStack() : null;
  const out = {
    name,
    stackFile: stack ? stackFile : null,
    edgeUrl: stack?.edgeUrl ?? null,
    workers: {},
  };
  for (const [key, worker] of Object.entries(names)) {
    if (key === "d1") continue;
    out.workers[worker] = (await workerExists(worker)) ? "deployed" : "absent";
  }
  const d1 = await findD1(names.d1);
  out.d1 = d1 ? { name: d1.name, id: d1.uuid } : "absent";
  if (stack?.edgeUrl) {
    try {
      const res = await fetch(`${stack.edgeUrl}/health`);
      out.edgeHealth = { status: res.status };
    } catch (error) {
      out.edgeHealth = { error: String(error) };
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

async function destroy() {
  requireEnv(["CLOUDFLARE_API_TOKEN"]);
  for (const worker of [names.edge, names.workerd, names.platform]) {
    if (await workerExists(worker)) {
      step(`delete worker ${worker}`);
      await cf(`/workers/scripts/${worker}?force=true`, { method: "DELETE" });
    }
  }
  const d1 = await findD1(names.d1);
  if (d1) {
    step(`delete d1 ${d1.name}`);
    await cf(`/d1/database/${d1.uuid}`, { method: "DELETE" });
  }
  for (const file of Object.values(configPaths()))
    fs.rmSync(file, { force: true });
  if (fs.existsSync(stackFile)) {
    const stack = loadStack();
    delete stack.d1;
    delete stack.edgeUrl;
    delete stack.deployedAt;
    saveStack(stack);
  }
  console.log(`destroyed ${name} (blue side)`);
}

// ── config rendering ─────────────────────────────────────────────────────

function configPaths() {
  return {
    platform: path.join(repoRoot, `wrangler.platform.${name}.generated.jsonc`),
    workerd: path.join(repoRoot, `wrangler.workerd.${name}.generated.jsonc`),
    edge: path.join(repoRoot, `wrangler.${name}.generated.jsonc`),
    edgeBootstrap: path.join(
      repoRoot,
      `wrangler.${name}.bootstrap.generated.jsonc`,
    ),
  };
}

function writeConfigs(stack, { bootstrap }) {
  const files = configPaths();
  const image = stack.runtimeImage ?? DEFAULT_RUNTIME_IMAGE;
  const d1Id = stack.d1?.id ?? "00000000-0000-0000-0000-000000000000";
  const observability = { enabled: true, head_sampling_rate: 1 };
  const schema = "./node_modules/wrangler/config-schema.json";

  const platform = {
    $schema: schema,
    name: names.platform,
    account_id: ACCOUNT_ID,
    main: "src/platform/index.ts",
    compatibility_date: "2026-07-24",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    vars: {
      ...AWS,
      ...(stack.computer
        ? {
            AZURE_SUBSCRIPTION_ID: stack.computer.subscriptionId,
            AZURE_COMPUTER_RESOURCE_GROUP: stack.computer.resourceGroup,
            AZURE_COMPUTER_REGION: stack.computer.region,
            AZURE_COMPUTER_SUBNET_ID: stack.computer.subnetId,
            AZURE_COMPUTER_IDENTITY_ID: stack.computer.identityId,
            AZURE_COMPUTER_IDENTITY_CLIENT_ID: stack.computer.identityClientId,
            COMPUTER_BOOTSTRAP_URL: stack.computer.bootstrapUrl,
          }
        : {}),
      // Modal provider config: set OC_STACK_* env vars to route
      // sandboxEnsure at the shim. Without them no sandbox starts.
      ...optionalSecrets({
        BLUE_SANDBOX_PROVIDER: "OC_STACK_SANDBOX_PROVIDER",
        MODAL_SHIM_URL: "OC_STACK_MODAL_SHIM_URL",
        MODAL_SANDBOX_IMAGE: "OC_STACK_MODAL_SANDBOX_IMAGE",
        MODAL_SANDBOX_APP: "OC_STACK_MODAL_SANDBOX_APP",
        MODAL_SANDBOX_REGION: "OC_STACK_MODAL_SANDBOX_REGION",
        MODAL_SANDBOX_CPU: "OC_STACK_MODAL_SANDBOX_CPU",
        MODAL_SANDBOX_MEMORY_MIB: "OC_STACK_MODAL_SANDBOX_MEMORY_MIB",
        MODAL_VOLUME_PREFIX: "OC_STACK_MODAL_VOLUME_PREFIX",
        MODAL_DOWNLOAD_BASE_URL: "OC_STACK_MODAL_DOWNLOAD_BASE_URL",
        MODAL_ACCOUNT_ALLOWLIST: "OC_STACK_MODAL_ACCOUNT_ALLOWLIST",
        MODAL_ROLLOUT_PERCENT: "OC_STACK_MODAL_ROLLOUT_PERCENT",
      }),
    },
    observability,
  };

  const workerd = {
    $schema: schema,
    name: names.workerd,
    account_id: ACCOUNT_ID,
    main: "src/workerd-runtime/index.ts",
    compatibility_date: "2026-07-24",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    vars: { SANDBOX_IDLE_GRACE_MS: "180000" },
    worker_loaders: [{ binding: "AGENT_LOADER" }],
    services: [
      { binding: "ARTIFACTS", service: names.platform },
      { binding: "SANDBOX", service: names.platform },
    ],
    durable_objects: {
      bindings: [
        {
          name: "OPENCODE_SESSIONS",
          class_name: "OpenCodeSessionDurableObject",
        },
        {
          name: "MEMORY",
          class_name: "MemoryDurableObject",
          script_name: names.edge,
        },
      ],
    },
    migrations: [
      { tag: "v1", new_sqlite_classes: ["OpenCodeSessionDurableObject"] },
    ],
    observability,
  };

  const edgeServices = [
    { binding: "DEPLOYMENTS", service: names.platform },
    { binding: "RUNTIMES", service: names.platform },
    // The same stack's api-edge owns credit admission; without it the model
    // gateway fails open to full model access for every org.
    ...(stack.apiEdgeUrl
      ? [
          {
            binding: "OPENCOMPUTER_BILLING",
            service: names.apiEdge,
            entrypoint: "ManagedAgentBillingService",
          },
        ]
      : []),
  ];
  const edge = (withWorkerd) => ({
    $schema: schema,
    name: names.edge,
    account_id: ACCOUNT_ID,
    main: "src/edge/index.ts",
    compatibility_date: "2026-09-02",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: false,
    routes: [
      {
        pattern: stack.edgeHost ?? `${names.edge}.${EDGE_DOMAIN}`,
        custom_domain: true,
      },
    ],
    vars: {
      BLUE_ENVIRONMENT: name,
      BLUE_ACCOUNT_ID: "unused",
      OC_MANAGED_AGENTS_ONLY: "true",
      WORKERD_PREWARM_TARGET: "1",
      BLUE_DEFAULT_MODEL: "openrouter/anthropic/claude-sonnet-4.6",
      BLUE_RUNTIME_IMAGE_ARN: image.arn,
      BLUE_RUNTIME_IMAGE_VERSION: image.version,
      ...(stack.apiEdgeUrl ? { OPENCOMPUTER_APP_URL: stack.apiEdgeUrl } : {}),
      COMPUTER_HOST_GATEWAY_URL: `wss://${stack.edgeHost ?? `${names.edge}.${EDGE_DOMAIN}`}`,
      ...(stack.apiEdgeUrl ? { COMPUTER_PUBLIC_ORIGIN: stack.apiEdgeUrl } : {}),
      COMPUTER_DEFAULT_SIZE: stack.computer?.defaultSize ?? "Standard_D2as_v7",
      COMPUTER_PAID_SIZE: stack.computer?.paidSize ?? "",
      COMPUTER_DEFAULT_DISK_GIB: String(stack.computer?.diskGiB ?? 128),
      // Warm computers cost like a free organization's each: opt in per stack.
      COMPUTER_POOL_SIZE: process.env.OC_STACK_COMPUTER_POOL_SIZE || "0",
      SLACK_COMPUTER_SCOPES:
        "app_mentions:read,assistant:write,channels:history,channels:read,channels:manage,groups:history,groups:read,groups:write,im:history,im:read,im:write,chat:write,files:read,files:write,reactions:write,users:read,users:read.email",
      ...optionalSecrets({
        OC_GITHUB_APP_ID: "OC_STACK_GITHUB_APP_ID",
        OC_GITHUB_APP_SLUG: "OC_STACK_GITHUB_APP_SLUG",
        OC_GITHUB_APP_CLIENT_ID: "OC_STACK_GITHUB_APP_CLIENT_ID",
        SLACK_COMPUTER_CLIENT_ID: "OC_STACK_SLACK_COMPUTER_CLIENT_ID",
      }),
    },
    d1_databases: [
      {
        binding: "SERVERLESS_AGENTS_DB",
        database_name: names.d1,
        database_id: d1Id,
        migrations_dir: "migrations",
      },
    ],
    services: withWorkerd
      ? [
          { binding: "WORKERD_RUNTIME", service: names.workerd },
          ...edgeServices,
        ]
      : edgeServices,
    ai: { binding: "AI" },
    durable_objects: {
      bindings: [
        { name: "ACCOUNTS", class_name: "AccountDurableObject" },
        { name: "SESSIONS", class_name: "SessionDurableObject" },
        { name: "POOLS", class_name: "DeploymentPoolDurableObject" },
        { name: "MEMORY", class_name: "MemoryDurableObject" },
        { name: "DATABASES", class_name: "ProjectDatabaseDurableObject" },
        { name: "COMPUTERS", class_name: "ComputerDurableObject" },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["AccountDurableObject", "SessionDurableObject"],
      },
      { tag: "v2", new_sqlite_classes: ["DeploymentPoolDurableObject"] },
      { tag: "v3", new_sqlite_classes: ["MemoryDurableObject"] },
      { tag: "v4", new_sqlite_classes: ["ProjectDatabaseDurableObject"] },
      { tag: "v5", new_sqlite_classes: ["ComputerDurableObject"] },
    ],
    observability,
  });

  writeJson(files.platform, platform);
  writeJson(files.workerd, workerd);
  writeJson(files.edge, edge(true));
  if (bootstrap) writeJson(files.edgeBootstrap, edge(false));
  else fs.rmSync(files.edgeBootstrap, { force: true });
  return files;
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
  if (res.ok) return true;
  if (res.status === 404) return false;
  die(`GET workers/scripts/${worker}/settings failed: ${res.status}`);
}

async function findD1(dbName) {
  const list = await cf(`/d1/database?name=${encodeURIComponent(dbName)}`);
  return list.find((db) => db.name === dbName) ?? null;
}

async function ensureD1(dbName) {
  const existing = await findD1(dbName);
  if (existing) return { name: existing.name, id: existing.uuid };
  step(`create d1 ${dbName}`);
  const created = await cf("/d1/database", {
    method: "POST",
    body: JSON.stringify({ name: dbName, primary_location_hint: "apac" }),
  });
  return { name: created.name, id: created.uuid };
}

// ── wrangler ─────────────────────────────────────────────────────────────

function deploy(configFile, secrets) {
  const tmp = path.join(
    stackHome,
    `.secrets-${path.basename(configFile)}.json`,
  );
  fs.writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 });
  try {
    wrangler(["deploy", "--config", configFile, "--secrets-file", tmp]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Runs a command with output streamed to stderr for visibility; returns stdout.
function run(cmd, args, extraEnv, cwd = repoRoot) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...extraEnv },
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.status !== 0)
    die(`${cmd} ${args.slice(0, 2).join(" ")} failed (exit ${result.status})`);
  return result.stdout ?? "";
}

function wrangler(args) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: cfToken,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      WRANGLER_SEND_METRICS: "false",
    },
  });
  if (result.status !== 0)
    die(
      `wrangler ${args.slice(0, 3).join(" ")} failed (exit ${result.status})`,
    );
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
    "BLUE_CHANNEL_ENCRYPTION_KEY",
    "BLUE_SESSION_INDEX_ADMIN_SECRET",
    "COMPUTER_HOST_TOKEN_KEY",
  ]) {
    secrets[key] ??=
      key === "BLUE_CHANNEL_ENCRYPTION_KEY"
        ? randomBytes(32).toString("base64")
        : randomBytes(32).toString("hex");
  }
  fs.writeFileSync(secretsFile, `${JSON.stringify(secrets, null, 2)}\n`, {
    mode: 0o600,
  });
  return secrets;
}

// ── helpers ──────────────────────────────────────────────────────────────

function writeJson(file, value) {
  fs.writeFileSync(
    file,
    `// generated by scripts/stack.mjs — do not commit\n${JSON.stringify(value, null, 2)}\n`,
  );
}

// { BINDING: ENV_VAR } → { BINDING: value } for the env vars that are set.
function optionalSecrets(mapping, fallback) {
  const stored =
    fallback ??
    (fs.existsSync(secretsFile)
      ? JSON.parse(fs.readFileSync(secretsFile, "utf8"))
      : {});
  return Object.fromEntries(
    Object.entries(mapping)
      .map(
        ([binding, envName]) =>
          [binding, process.env[envName] ?? stored[envName]],
      )
      .filter(([, value]) => value),
  );
}

// Primary (ambient) AWS credentials may be temporary and carry a session
// token; the AWS_DEVIN_MICROVM_* fallback is a long-lived IAM user, for which
// an ambient AWS_SESSION_TOKEN would belong to different credentials.
function awsCredentials() {
  if (
    !process.env.AWS_ACCESS_KEY_ID &&
    !process.env.AWS_DEVIN_MICROVM_ACCESS_KEY_ID
  ) {
    console.warn("stack.mjs: no AWS credentials; artifact storage will fail");
    return {};
  }
  if (process.env.AWS_ACCESS_KEY_ID) {
    return {
      AWS_ACCESS_KEY_ID: env("AWS_ACCESS_KEY_ID"),
      AWS_SECRET_ACCESS_KEY: env("AWS_SECRET_ACCESS_KEY"),
      ...(process.env.AWS_SESSION_TOKEN
        ? { AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN }
        : {}),
    };
  }
  return {
    AWS_ACCESS_KEY_ID: env("AWS_DEVIN_MICROVM_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY: env("AWS_DEVIN_MICROVM_SECRET_ACCESS_KEY"),
  };
}

function env(primary, fallback) {
  const value = process.env[primary] ?? (fallback && process.env[fallback]);
  if (!value)
    die(`missing env ${primary}${fallback ? ` (or ${fallback})` : ""}`);
  return value;
}

function requireEnv(keys) {
  for (const key of keys) {
    if (key === "CLOUDFLARE_API_TOKEN" && cfToken) continue;
    if (!process.env[key]) die(`missing env ${key}`);
  }
}

function stackEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) die(`missing env ${key}`);
  return value;
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith("--")) die(`unexpected argument ${args[i]}`);
    out[args[i].slice(2)] = args[i + 1] ?? "";
    i += 1;
  }
  return out;
}

function step(label) {
  console.log(`\n▶ [${name}] ${label}`);
}

function usage() {
  console.error(
    "usage: node scripts/stack.mjs <devin-name> render|up|status|destroy [--api-edge-url URL]",
  );
  process.exit(2);
}

function die(message) {
  console.error(`stack.mjs: ${message}`);
  process.exit(1);
}
