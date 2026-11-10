import {
  MEMORY_LIMITS,
  memoryObjectName,
  type ApplyConfigOutcome,
  type HttpToolDeclaration,
  type MemoryDeclaration,
  type MemoryEnvironment,
  type MemoryNamespace,
  type ResourceConfig,
} from "./memory-contract.js";

/**
 * Configuration activation, the Account DO's side of the promotion
 * protocol (product note, "Configuration activation"). A promotion of an
 * environment allocates that environment's next `activation_seq` in the
 * Account DO's own transaction and records the intent; then it applies the
 * memory configuration to the Memory DO; then it flips the alias, but only
 * while its seq is still the environment's latest intent. The identity of
 * an activation is the seq, never the deployment id, so a rollback
 * `A -> B -> A` is a fresh activation and a delayed retry of an older one
 * cannot overwrite a newer one.
 *
 * Every step is idempotent by seq, so a crash anywhere is re-driven by the
 * Account DO alarm from the recorded row. The row is born with a next
 * attempt at the apply call's deadline and the caller arms its alarm before
 * the call leaves, so an object that dies with the call in flight is woken
 * as well. The states: `allocated` (intent recorded, nothing applied),
 * `applied` (limits in force, code not yet selected), `selected` (done),
 * `superseded` (a newer promotion owns the environment), `rejected` (a
 * resource changed provider kind).
 */

export type MemoryActivationState =
  | "allocated"
  | "applied"
  | "selected"
  | "superseded"
  | "rejected";

export interface MemoryActivationRow {
  [key: string]: SqlStorageValue;
  project_id: string;
  environment: string;
  seq: number;
  account_id: string;
  deployment_id: string;
  resources_json: string;
  flip_json: string;
  state: MemoryActivationState;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  updated_at: string;
}

/**
 * What the commit step flips; recorded so a re-drive needs no recomputation.
 * `activeDeploymentId` is absent when the promotion does not change the
 * environment's primary deployment (a secondary agent deployed alone).
 */
export interface MemoryActivationFlip {
  aliases: Array<{ agentId: string; deploymentId: string }>;
  activeDeploymentId?: string;
}

export interface MemoryActivationEnv {
  MEMORY?: MemoryNamespace;
}

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000];
/** When the alarm re-drives an apply whose object never came back to record its outcome. */
export const ACTIVATION_ATTEMPT_DEADLINE_MS = 11_000;

function attemptDeadline(): string {
  return new Date(Date.now() + ACTIVATION_ATTEMPT_DEADLINE_MS).toISOString();
}

export class MemoryConfigRejectedError extends Error {
  constructor(readonly resource: string) {
    super(
      `Memory resource ${resource} changes its provider kind; declare a new resource and migrate the data`,
    );
    this.name = "MemoryConfigRejectedError";
  }
}

export function ensureMemoryActivationSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS deployment_memory (
      deployment_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      declaration_json TEXT NOT NULL,
      PRIMARY KEY (deployment_id, resource)
    );
    CREATE TABLE IF NOT EXISTS memory_activations (
      project_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      seq INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      flip_json TEXT NOT NULL,
      state TEXT NOT NULL
        CHECK (state IN ('allocated', 'applied', 'selected', 'superseded', 'rejected')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, environment, seq)
    );
    CREATE INDEX IF NOT EXISTS memory_activations_due
      ON memory_activations(next_attempt_at)
      WHERE state IN ('allocated', 'applied');
  `);
  const columns = sql
    .exec<{ name: string }>("PRAGMA table_info(project_environments)")
    .toArray();
  if (!columns.some((column) => column.name === "activation_seq")) {
    sql.exec(
      "ALTER TABLE project_environments ADD COLUMN activation_seq INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!columns.some((column) => column.name === "selected_activation_seq")) {
    sql.exec(
      "ALTER TABLE project_environments ADD COLUMN selected_activation_seq INTEGER",
    );
  }
}

/** Validates the wire shape of `memory` on a deployment registration; null when invalid. */
export function parseMemoryDeclarations(value: unknown): MemoryDeclaration[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) return null;
  const declarations: MemoryDeclaration[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const provider = record.provider;
    if (
      typeof record.id !== "string" ||
      !MEMORY_LIMITS.documentIdPattern.test(record.id) ||
      ids.has(record.id) ||
      typeof record.description !== "string" ||
      record.description.length > 2_048 ||
      typeof provider !== "object" ||
      provider === null
    ) {
      return null;
    }
    ids.add(record.id);
    const config = provider as Record<string, unknown>;
    const maxBytes = config.maxBytes ?? MEMORY_LIMITS.defaultMaxBytes;
    if (
      typeof maxBytes !== "number" ||
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MEMORY_LIMITS.maxMaxBytes
    ) {
      return null;
    }
    if (config.kind === "document") {
      declarations.push({
        id: record.id,
        description: record.description,
        provider: { kind: "document", maxBytes },
      });
      continue;
    }
    if (config.kind === "http") {
      const tools = config.tools ?? [];
      if (
        typeof config.connection !== "string" ||
        !config.connection ||
        typeof config.path !== "string" ||
        !/^\/[^?#]*$/.test(config.path) ||
        !Array.isArray(tools) ||
        !tools.every(
          (tool) =>
            typeof tool === "object" &&
            tool !== null &&
            typeof (tool as Record<string, unknown>).name === "string" &&
            typeof (tool as Record<string, unknown>).description === "string" &&
            ((tool as Record<string, unknown>).access === "read" ||
              (tool as Record<string, unknown>).access === "write") &&
            ((tool as Record<string, unknown>).idempotent === undefined ||
              typeof (tool as Record<string, unknown>).idempotent === "boolean") &&
            typeof (tool as Record<string, unknown>).input === "object" &&
            (tool as Record<string, unknown>).input !== null,
        )
      ) {
        return null;
      }
      declarations.push({
        id: record.id,
        description: record.description,
        provider: {
          kind: "http",
          connection: config.connection,
          path: config.path,
          maxBytes,
          tools: tools as HttpToolDeclaration[],
        },
      });
      continue;
    }
    return null;
  }
  return declarations;
}

export function storeDeploymentMemory(
  sql: SqlStorage,
  deploymentId: string,
  declarations: MemoryDeclaration[],
): void {
  sql.exec("DELETE FROM deployment_memory WHERE deployment_id = ?", deploymentId);
  for (const declaration of declarations) {
    sql.exec(
      `INSERT INTO deployment_memory (deployment_id, resource, declaration_json)
       VALUES (?, ?, ?)`,
      deploymentId,
      declaration.id,
      JSON.stringify(declaration),
    );
  }
}

export function deploymentMemory(sql: SqlStorage, deploymentId: string): MemoryDeclaration[] {
  return sql
    .exec<{ declaration_json: string }>(
      "SELECT declaration_json FROM deployment_memory WHERE deployment_id = ? ORDER BY resource",
      deploymentId,
    )
    .toArray()
    .map((row) => JSON.parse(row.declaration_json) as MemoryDeclaration);
}

/**
 * The resource configuration a promotion applies: the union of the
 * declarations of every deployment that is active in the environment once
 * the promotion commits. Members must agree on a shared resource; a
 * disagreement fails the promotion before any alias is published.
 */
export function resourceConfigForDeployments(
  sql: SqlStorage,
  deploymentIds: string[],
): ResourceConfig[] {
  const merged = new Map<string, ResourceConfig & { deploymentId: string }>();
  for (const deploymentId of deploymentIds) {
    for (const declaration of deploymentMemory(sql, deploymentId)) {
      const config = {
        resource: declaration.id,
        provider: declaration.provider.kind,
        maxBytes: declaration.provider.maxBytes,
        deploymentId,
      };
      const existing = merged.get(declaration.id);
      if (
        existing &&
        (existing.provider !== config.provider || existing.maxBytes !== config.maxBytes)
      ) {
        throw new Error(
          `Memory resource ${declaration.id} is declared with different configuration by two agents active in the environment: ${existing.deploymentId} and ${deploymentId}`,
        );
      }
      merged.set(declaration.id, config);
    }
  }
  return [...merged.values()]
    .map(({ resource, provider, maxBytes }) => ({ resource, provider, maxBytes }))
    .sort((a, b) => (a.resource < b.resource ? -1 : 1));
}

/** The resource ids the environment's selected activation applied; empty before any promotion. */
export function selectedMemoryResources(
  sql: SqlStorage,
  projectId: string,
  environment: string,
): string[] {
  const row = sql
    .exec<{ resources_json: string }>(
      `SELECT a.resources_json FROM memory_activations a
       JOIN project_environments e
         ON e.project_id = a.project_id AND e.name = a.environment AND e.selected_activation_seq = a.seq
       WHERE a.project_id = ? AND a.environment = ?`,
      projectId,
      environment,
    )
    .toArray()[0];
  return row ? (JSON.parse(row.resources_json) as ResourceConfig[]).map((entry) => entry.resource) : [];
}

/** Allocates the next seq for the environment and records the intent; call inside the caller's transaction. */
export function allocateMemoryActivation(
  sql: SqlStorage,
  input: {
    accountId: string;
    projectId: string;
    environment: MemoryEnvironment;
    deploymentId: string;
    resources: ResourceConfig[];
    flip: MemoryActivationFlip;
  },
): number {
  const timestamp = new Date().toISOString();
  sql.exec(
    `UPDATE project_environments
     SET activation_seq = activation_seq + 1, updated_at = ?
     WHERE project_id = ? AND name = ?`,
    timestamp,
    input.projectId,
    input.environment,
  );
  const seq = sql
    .exec<{ activation_seq: number }>(
      "SELECT activation_seq FROM project_environments WHERE project_id = ? AND name = ?",
      input.projectId,
      input.environment,
    )
    .toArray()[0]?.activation_seq;
  if (!seq) throw new Error("Project environment not found");
  sql.exec(
    `INSERT INTO memory_activations (
       project_id, environment, seq, account_id, deployment_id, resources_json,
       flip_json, state, attempts, next_attempt_at, last_error, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'allocated', 0, ?, NULL, ?)`,
    input.projectId,
    input.environment,
    seq,
    input.accountId,
    input.deploymentId,
    JSON.stringify(input.resources),
    JSON.stringify(input.flip),
    attemptDeadline(),
    timestamp,
  );
  return seq;
}

export function readMemoryActivation(
  sql: SqlStorage,
  projectId: string,
  environment: string,
  seq: number,
): MemoryActivationRow | undefined {
  return sql
    .exec<MemoryActivationRow>(
      "SELECT * FROM memory_activations WHERE project_id = ? AND environment = ? AND seq = ?",
      projectId,
      environment,
      seq,
    )
    .toArray()[0];
}

export function dueMemoryActivations(sql: SqlStorage, now: string): MemoryActivationRow[] {
  return sql
    .exec<MemoryActivationRow>(
      `SELECT * FROM memory_activations
       WHERE state IN ('allocated', 'applied') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
       ORDER BY next_attempt_at LIMIT 20`,
      now,
    )
    .toArray();
}

export function nextMemoryActivationAttempt(sql: SqlStorage): string | undefined {
  return sql
    .exec<{ next_attempt_at: string }>(
      `SELECT next_attempt_at FROM memory_activations
       WHERE state IN ('allocated', 'applied') AND next_attempt_at IS NOT NULL
       ORDER BY next_attempt_at LIMIT 1`,
    )
    .toArray()[0]?.next_attempt_at;
}

function setState(
  sql: SqlStorage,
  row: MemoryActivationRow,
  state: MemoryActivationState,
  error?: string,
): void {
  sql.exec(
    `UPDATE memory_activations
     SET state = ?, next_attempt_at = NULL, last_error = ?, updated_at = ?
     WHERE project_id = ? AND environment = ? AND seq = ?`,
    state,
    error ?? null,
    new Date().toISOString(),
    row.project_id,
    row.environment,
    row.seq,
  );
}

function recordFailure(sql: SqlStorage, row: MemoryActivationRow, error: unknown): void {
  const attempts = row.attempts + 1;
  const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1]!;
  sql.exec(
    `UPDATE memory_activations
     SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE project_id = ? AND environment = ? AND seq = ?`,
    attempts,
    new Date(Date.now() + delay).toISOString(),
    error instanceof Error ? error.message : String(error),
    new Date().toISOString(),
    row.project_id,
    row.environment,
    row.seq,
  );
}

/**
 * Drives one recorded activation as far as it can go: apply, then commit.
 * Returns the final state. A transport failure records the next attempt
 * and rethrows so the caller can answer honestly; the alarm re-drives it.
 * `armed` runs after the row's next attempt is moved to the apply deadline
 * and before the apply call is issued; the caller sets its alarm there.
 */
export async function driveMemoryActivation(
  storage: DurableObjectStorage,
  env: MemoryActivationEnv,
  row: MemoryActivationRow,
  armed?: () => Promise<void>,
): Promise<MemoryActivationState> {
  const sql = storage.sql;
  if (row.state === "allocated") {
    if (!env.MEMORY) {
      throw new Error("Project memory is not configured");
    }
    const memory = env.MEMORY.getByName(
      memoryObjectName(row.account_id, row.project_id, row.environment as MemoryEnvironment),
    );
    sql.exec(
      `UPDATE memory_activations SET next_attempt_at = ?, updated_at = ?
       WHERE project_id = ? AND environment = ? AND seq = ?`,
      attemptDeadline(),
      new Date().toISOString(),
      row.project_id,
      row.environment,
      row.seq,
    );
    if (armed) await armed();
    let outcome: ApplyConfigOutcome;
    try {
      outcome = await memory.applyConfig(
        row.seq,
        row.deployment_id,
        JSON.parse(row.resources_json) as ResourceConfig[],
      );
    } catch (error) {
      recordFailure(sql, row, error);
      throw error;
    }
    if (outcome.kind === "rejected") {
      setState(sql, row, "rejected", `provider_kind:${outcome.resource}`);
      throw new MemoryConfigRejectedError(outcome.resource);
    }
    // `stale` with our own seq means an earlier attempt applied it and the
    // reply was lost; only a higher seq means someone newer owns it.
    if (outcome.kind === "stale" && outcome.seq !== row.seq) {
      setState(sql, row, "superseded");
      return "superseded";
    }
    setState(sql, row, "applied");
    row = { ...row, state: "applied" };
  }
  if (row.state === "applied") {
    return storage.transactionSync((): MemoryActivationState => {
      const latest = sql
        .exec<{ activation_seq: number }>(
          "SELECT activation_seq FROM project_environments WHERE project_id = ? AND name = ?",
          row.project_id,
          row.environment,
        )
        .toArray()[0]?.activation_seq;
      if (latest !== row.seq) {
        setState(sql, row, "superseded");
        return "superseded";
      }
      const flip = JSON.parse(row.flip_json) as MemoryActivationFlip;
      const timestamp = new Date().toISOString();
      for (const alias of flip.aliases) {
        sql.exec(
          `INSERT INTO deployment_aliases (agent_id, alias, deployment_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_id, alias) DO UPDATE SET
             deployment_id = excluded.deployment_id,
             updated_at = excluded.updated_at`,
          alias.agentId,
          row.environment,
          alias.deploymentId,
          timestamp,
        );
      }
      sql.exec(
        `UPDATE project_environments
         SET active_deployment_id = COALESCE(?, active_deployment_id), selected_activation_seq = ?, updated_at = ?
         WHERE project_id = ? AND name = ?`,
        flip.activeDeploymentId ?? null,
        row.seq,
        timestamp,
        row.project_id,
        row.environment,
      );
      setState(sql, row, "selected");
      return "selected";
    });
  }
  return row.state;
}
