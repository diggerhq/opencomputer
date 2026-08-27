import { readFile } from "node:fs/promises";

import { GitActionLedger } from "./git-ledger.js";
import { ChildProcessPolicyEvaluator } from "./policy.js";
import type { CompiledActionManifest } from "./protocol.js";
import { ChildProcessActionExecutor, LocalActionWorker } from "./worker.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const secrets = JSON.parse(
  await readFile(required("OPENCOMPUTER_ACTION_SECRETS_FILE"), "utf8"),
) as Record<string, string>;
const reactiveManifest = JSON.parse(
  await readFile(required("OPENCOMPUTER_REACTIVE_MANIFEST_PATH"), "utf8"),
) as { actions?: CompiledActionManifest };
if (!reactiveManifest.actions) {
  throw new Error("Deployment does not declare actions");
}
const repositories = process.env.OPENCOMPUTER_ACTION_REPOSITORIES_FILE
  ? (JSON.parse(
      await readFile(process.env.OPENCOMPUTER_ACTION_REPOSITORIES_FILE, "utf8"),
    ) as Record<
      string,
      { id: string; remote: string; defaultBranch: string }
    >)
  : {};

const worker = new LocalActionWorker(
  new GitActionLedger(required("OPENCOMPUTER_ACTION_REPOSITORY")),
  required("OPENCOMPUTER_ACTION_BUNDLE"),
  reactiveManifest.actions.definitions,
  required("OPENCOMPUTER_ACTION_POLICY_DIGEST"),
  new ChildProcessPolicyEvaluator(),
  {
    async resolve({ name }) {
      const value = secrets[name];
      if (!value) throw new Error(`Local action secret ${name} is unavailable`);
      return { value, version: "local" };
    },
  },
  new ChildProcessActionExecutor(),
  {
    async resolve(id) {
      const repository = repositories[id];
      if (!repository) throw new Error(`Local repository ${id} is unavailable`);
      return repository;
    },
  },
);

const pollMs = Number(process.env.OPENCOMPUTER_ACTION_POLL_MS ?? 100);
for (;;) {
  await worker.processPending();
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
