/**
 * Checkpoint retention through the TypeScript SDK.
 *
 * Usage:
 *   OPENSANDBOX_API_URL=https://mo-oc-dev.com OPENSANDBOX_API_KEY=... \
 *     npx tsx scripts/qemu-tests/42-checkpoint-retention-sdk.ts
 */

import { Sandbox } from "../../sdks/typescript/src/index.ts";

const MAX_COUNT = Number(process.env.MAX_COUNT || "3");
const READY_TIMEOUT_SECONDS = Number(process.env.READY_TIMEOUT_SECONDS || "900");
const RETENTION_ONLY = process.env.RETENTION_ONLY === "1";
const API_URL = process.env.OPENCOMPUTER_API_URL || process.env.OPENSANDBOX_API_URL;
const API_KEY = process.env.OPENCOMPUTER_API_KEY || process.env.OPENSANDBOX_API_KEY;

let pass = 0;
let fail = 0;

function ok(message: string) {
  pass += 1;
  console.log(`PASS ${message}`);
}

function bad(message: string) {
  fail += 1;
  console.error(`FAIL ${message}`);
}

function summary() {
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCheckpointReady(sandbox: Sandbox, name: string) {
  const deadline = Date.now() + READY_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const checkpoints = await sandbox.listCheckpoints();
    const cp = checkpoints.find((checkpoint) => checkpoint.name === name);
    if (cp?.status === "ready") return true;
    if (cp && cp.status !== "processing") return false;
    await sleep(5000);
  }
  return false;
}

async function main() {
  if (MAX_COUNT < 1 || MAX_COUNT > 10) {
    throw new Error("MAX_COUNT must be between 1 and 10");
  }

  let sandbox: Sandbox | undefined;
  const prefix = `ts-retention-${Date.now()}`;
  const total = MAX_COUNT + 1;

  try {
    sandbox = await Sandbox.create({ apiUrl: API_URL, apiKey: API_KEY, timeout: 3600 });
    ok(`sandbox running: ${sandbox.sandboxId}`);

    for (let i = 1; i <= total; i += 1) {
      const name = `${prefix}-${i}`;
      const cp = await sandbox.createCheckpoint(name, {
        retentionPolicy: { mode: "delete_oldest", maxCount: MAX_COUNT },
      });
      ok(`created checkpoint ${i}/${total}: ${name} (${cp.id})`);

      if (RETENTION_ONLY && i === total) {
        ok("retention checkpoint accepted without hard-cap error");
        break;
      }

      if (await waitForCheckpointReady(sandbox, name)) {
        ok(`checkpoint ready: ${name}`);
      } else {
        bad(`checkpoint did not become ready: ${name}`);
        summary();
      }
    }

    const checkpoints = await sandbox.listCheckpoints();
    const names = checkpoints.map((checkpoint) => checkpoint.name);

    if (names.length === MAX_COUNT) ok(`checkpoint count retained at ${MAX_COUNT}`);
    else bad(`checkpoint count is ${names.length}, expected ${MAX_COUNT}`);

    if (!names.includes(`${prefix}-1`)) ok("oldest checkpoint was deleted by retention");
    else bad("oldest checkpoint still exists after retention");

    if (names.includes(`${prefix}-${total}`)) ok("newest checkpoint exists after retention");
    else bad("newest checkpoint missing after retention");
  } finally {
    if (sandbox) await sandbox.kill().catch(() => undefined);
  }

  summary();
}

main().catch((err) => {
  bad(err instanceof Error ? err.message : String(err));
  summary();
});
