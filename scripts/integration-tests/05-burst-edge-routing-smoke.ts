/**
 * Smoke test for Burst sandbox edge routing.
 *
 * Creates a Burst sandbox through the main public API, verifies basic exec,
 * then proves the sandbox landed in the expected cell by either:
 *   - listing sandboxes through the direct cell/LB API, or
 *   - reading sandbox_sessions from Postgres.
 *
 * Usage:
 *   OPENCOMPUTER_API_KEY=osb_... \
 *   OPENCOMPUTER_VERIFY_MODE=postgres \
 *   OPENCOMPUTER_DATABASE_URL=postgres://... \
 *   npx tsx scripts/integration-tests/05-burst-edge-routing-smoke.ts
 *
 * Or verify via the direct cell API:
 *   OPENCOMPUTER_API_KEY=osb_... \
 *   OPENCOMPUTER_VERIFY_MODE=direct-list \
 *   OPENCOMPUTER_DIRECT_API_URL=https://oc-alb-aws-us-east-2-burst-prod-972530125.us-east-2.elb.amazonaws.com \
 *   OPENCOMPUTER_DIRECT_API_KEY=osb_... \
 *   OPENCOMPUTER_DIRECT_TLS_INSECURE=1 \
 *   npx tsx scripts/integration-tests/05-burst-edge-routing-smoke.ts
 */

import { Sandbox } from "../../sdks/typescript/src";
import { execFileSync } from "node:child_process";

const MAIN_API_URL = process.env.OPENCOMPUTER_API_URL || "https://app.opencomputer.dev";
const MAIN_API_KEY = process.env.OPENCOMPUTER_API_KEY || "";
const VERIFY_MODE = process.env.OPENCOMPUTER_VERIFY_MODE || "direct-list";
const DIRECT_API_URL =
  process.env.OPENCOMPUTER_DIRECT_API_URL ||
  "https://oc-alb-aws-us-east-2-burst-prod-972530125.us-east-2.elb.amazonaws.com";
const DIRECT_API_KEY = process.env.OPENCOMPUTER_DIRECT_API_KEY || MAIN_API_KEY;
const DATABASE_URL = process.env.OPENCOMPUTER_DATABASE_URL || "";

if (process.env.OPENCOMPUTER_DIRECT_TLS_INSECURE === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

function apiBase(url: string): string {
  const base = url.replace(/\/+$/, "");
  return base.endsWith("/api") ? base : `${base}/api`;
}

function requireEnv(name: string, value: string): void {
  if (!value) {
    throw new Error(`${name} is required`);
  }
}

interface SessionRow {
  sandboxID: string;
  status: string;
  workerID: string;
  region: string;
  template: string;
  config: Record<string, unknown>;
}

async function listDirectSandboxes(): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(`${apiBase(DIRECT_API_URL)}/sandboxes`, {
    headers: DIRECT_API_KEY ? { "X-API-Key": DIRECT_API_KEY } : {},
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`direct sandbox list failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  if (!Array.isArray(data)) {
    throw new Error(`direct sandbox list returned non-array response: ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForDirectList(sandboxID: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;

  while (Date.now() < deadline) {
    const sandboxes = await listDirectSandboxes();
    lastCount = sandboxes.length;
    const found = sandboxes.find((sb) => sb.sandboxID === sandboxID || sb.id === sandboxID);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`sandbox ${sandboxID} was not visible from direct cell list after ${timeoutMs}ms (last count=${lastCount})`);
}

function queryPostgresSession(sandboxID: string): SessionRow {
  if (!/^[a-zA-Z0-9_-]+$/.test(sandboxID)) {
    throw new Error(`refusing unsafe sandbox id for SQL lookup: ${sandboxID}`);
  }

  const query = `
    SELECT json_build_object(
      'sandboxID', sandbox_id,
      'status', status,
      'workerID', worker_id,
      'region', region,
      'template', template,
      'config', config
    )::text
    FROM sandbox_sessions
    WHERE sandbox_id = '${sandboxID}'
    ORDER BY started_at DESC
    LIMIT 1;
  `;

  const out = execFileSync("psql", [DATABASE_URL, "-XAt", "-c", query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  if (!out) {
    throw new Error(`sandbox ${sandboxID} was not found in sandbox_sessions`);
  }
  return JSON.parse(out) as SessionRow;
}

async function main() {
  requireEnv("OPENCOMPUTER_API_KEY", MAIN_API_KEY);

  console.log(`main API: ${MAIN_API_URL}`);
  console.log(`verify mode: ${VERIFY_MODE}`);

  if (VERIFY_MODE === "direct-list") {
    requireEnv("OPENCOMPUTER_DIRECT_API_KEY", DIRECT_API_KEY);
    console.log(`direct API: ${DIRECT_API_URL}`);
    const before = await listDirectSandboxes();
    console.log(`direct list before create: ${before.length} running sandbox(es)`);
  } else if (VERIFY_MODE === "postgres") {
    requireEnv("OPENCOMPUTER_DATABASE_URL", DATABASE_URL);
  } else {
    throw new Error(`unsupported OPENCOMPUTER_VERIFY_MODE=${VERIFY_MODE}`);
  }

  const sandbox = await Sandbox.create({
    apiUrl: MAIN_API_URL,
    apiKey: MAIN_API_KEY,
    template: "base",
    burst: true,
    timeout: 0,
  });

  console.log(`created burst sandbox: ${sandbox.sandboxId} (${sandbox.status})`);

  try {
    const result = await sandbox.exec.run("echo hello world", { timeout: 30 });
    const stdout = result.stdout.trim();
    if (result.exitCode !== 0 || stdout !== "hello world") {
      throw new Error(`exec failed: exit=${result.exitCode}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(result.stderr)}`);
    }
    console.log("exec check: ok");

    if (VERIFY_MODE === "direct-list") {
      const direct = await waitForDirectList(sandbox.sandboxId);
      console.log(`direct list check: ok (${sandbox.sandboxId})`);
      if (direct.workerID || direct.workerId || direct.worker_id) {
        console.log(`worker: ${String(direct.workerID || direct.workerId || direct.worker_id)}`);
      }
      if (direct.region) {
        console.log(`region: ${String(direct.region)}`);
      }
    } else {
      const row = queryPostgresSession(sandbox.sandboxId);
      if (row.status !== "running") {
        throw new Error(`expected running session, got ${row.status}`);
      }
      if (!row.workerID) {
        throw new Error("session has no workerID");
      }
      if (row.config?.burst !== true && row.config?.resumable !== true && row.config?.sandboxFamily !== "spot") {
        throw new Error(`session config does not look like Burst: ${JSON.stringify(row.config)}`);
      }
      console.log(`postgres check: ok (${row.sandboxID})`);
      console.log(`worker: ${row.workerID}`);
      console.log(`region: ${row.region}`);
      console.log(`template: ${row.template}`);
    }
  } finally {
    try {
      await sandbox.kill();
      console.log(`cleaned up: ${sandbox.sandboxId}`);
    } catch (err) {
      console.error(`cleanup failed for ${sandbox.sandboxId}:`, err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
