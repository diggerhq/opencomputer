/**
 * Repro: create a sandbox with a single-use secret store, create a checkpoint,
 * then kill the sandbox and delete the attached secret store.
 *
 * Usage:
 *   OPENSANDBOX_API_URL=https://mo-oc-dev.com OPENSANDBOX_API_KEY=... \
 *     npx tsx scripts/qemu-tests/45-secret-store-checkpoint-kill.ts
 *
 * Optional:
 *   CHECKPOINT_KIND=disk_only|full       default: disk_only
 *   READY_TIMEOUT_SECONDS=900            checkpoint wait timeout
 *   SANDBOX_TIMEOUT_SECONDS=3600         sandbox idle timeout
 *   KEEP_ON_FAILURE=1                    leave resources behind for inspection
 */

import { Sandbox, SecretStore } from "../../sdks/typescript/src/index.ts";

const API_URL = process.env.OPENCOMPUTER_API_URL || process.env.OPENSANDBOX_API_URL;
const API_KEY = process.env.OPENCOMPUTER_API_KEY || process.env.OPENSANDBOX_API_KEY;
const CHECKPOINT_KIND = process.env.CHECKPOINT_KIND === "full" ? "full" : "disk_only";
const READY_TIMEOUT_SECONDS = Number(process.env.READY_TIMEOUT_SECONDS || "900");
const SANDBOX_TIMEOUT_SECONDS = Number(process.env.SANDBOX_TIMEOUT_SECONDS || "3600");
const KEEP_ON_FAILURE = process.env.KEEP_ON_FAILURE === "1";

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

async function waitForCheckpointReady(sandbox: Sandbox, checkpointId: string) {
  const deadline = Date.now() + READY_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const checkpoints = await sandbox.listCheckpoints();
    const cp = checkpoints.find((checkpoint) => checkpoint.id === checkpointId);
    if (cp?.status === "ready") return cp;
    if (cp && cp.status !== "processing") {
      throw new Error(`checkpoint ${checkpointId} ended with status ${cp.status}`);
    }
    await sleep(5000);
  }
  throw new Error(`checkpoint ${checkpointId} did not become ready within ${READY_TIMEOUT_SECONDS}s`);
}

async function expectSecretStoreGone(storeId: string) {
  try {
    await SecretStore.get(storeId, { apiUrl: API_URL, apiKey: API_KEY });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404")) {
      ok(`attached secret store was deleted: ${storeId}`);
      return;
    }
    throw err;
  }
  throw new Error(`secret store still exists after sandbox kill: ${storeId}`);
}

async function main() {
  if (!API_URL) throw new Error("set OPENSANDBOX_API_URL or OPENCOMPUTER_API_URL");
  if (!API_KEY) throw new Error("set OPENSANDBOX_API_KEY or OPENCOMPUTER_API_KEY");
  if (!Number.isFinite(READY_TIMEOUT_SECONDS) || READY_TIMEOUT_SECONDS <= 0) {
    throw new Error("READY_TIMEOUT_SECONDS must be a positive number");
  }

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const storeName = `repro-delete-attached-${suffix}`;
  const checkpointName = `repro-cp-${suffix}`;
  const secretValue = `marker-${suffix}`;

  let storeId: string | undefined;
  let sandbox: Sandbox | undefined;
  let killedWithDelete = false;

  try {
    const store = await SecretStore.create({
      apiUrl: API_URL,
      apiKey: API_KEY,
      name: storeName,
      egressAllowlist: ["example.com"],
    });
    storeId = store.id;
    ok(`secret store created: ${storeName} (${storeId})`);

    await SecretStore.setSecret(store.id, "OC_REPRO_SECRET", secretValue, {
      apiUrl: API_URL,
      apiKey: API_KEY,
      allowedHosts: ["example.com"],
    });
    const entries = await SecretStore.listSecrets(store.id, { apiUrl: API_URL, apiKey: API_KEY });
    if (!entries.some((entry) => entry.name === "OC_REPRO_SECRET")) {
      throw new Error("secret entry was not listed after setSecret");
    }
    ok("secret entry created");

    sandbox = await Sandbox.create({
      apiUrl: API_URL,
      apiKey: API_KEY,
      timeout: SANDBOX_TIMEOUT_SECONDS,
      secretStore: storeName,
      metadata: { repro: "secret-store-checkpoint-kill", storeId },
    });
    ok(`sandbox created with attached secret store: ${sandbox.sandboxId}`);

    const allowedHosts = await sandbox.getAllowedHosts();
    if (allowedHosts.secretStore !== storeName) {
      throw new Error(`sandbox reports secretStore=${allowedHosts.secretStore || "<empty>"}, expected ${storeName}`);
    }
    if (!allowedHosts.egressAllowlist.includes("example.com")) {
      throw new Error(`sandbox egress allowlist does not include example.com: ${allowedHosts.egressAllowlist.join(",")}`);
    }
    ok("sandbox reports attached secret store allowlist");

    const envCheck = await sandbox.exec.run("test -n \"$OC_REPRO_SECRET\" && printf present", {
      timeout: 30,
      timeoutMs: 120_000,
    });
    if (envCheck.exitCode !== 0 || envCheck.stdout.trim() !== "present") {
      throw new Error(`secret env marker not visible in sandbox: exit=${envCheck.exitCode} stdout=${JSON.stringify(envCheck.stdout)} stderr=${JSON.stringify(envCheck.stderr)}`);
    }
    ok("secret env marker is visible in sandbox");

    const checkpoint = await sandbox.createCheckpoint(checkpointName, { kind: CHECKPOINT_KIND });
    ok(`checkpoint requested: ${checkpointName} (${checkpoint.id}, kind=${CHECKPOINT_KIND})`);
    const ready = await waitForCheckpointReady(sandbox, checkpoint.id);
    ok(`checkpoint ready: ${ready.name} (${ready.id})`);

    await sandbox.kill({ deleteSecretStore: true });
    killedWithDelete = true;
    ok("sandbox killed with deleteSecretStore=true");

    await expectSecretStoreGone(store.id);
  } finally {
    if (!killedWithDelete && sandbox && !KEEP_ON_FAILURE) {
      await sandbox.kill({ deleteSecretStore: true }).catch(() => undefined);
    }
    if (storeId && !killedWithDelete && !KEEP_ON_FAILURE) {
      await SecretStore.delete(storeId, { apiUrl: API_URL, apiKey: API_KEY }).catch(() => undefined);
    }
  }

  summary();
}

main().catch((err) => {
  bad(err instanceof Error ? err.stack || err.message : String(err));
  summary();
});
