import type { IssueGrantsOutcome, MemoryBinding, MemoryNamespace } from "./memory-contract.js";
import type { MemoryAdmissionState, SessionMemoryBinding } from "../protocol.js";

/**
 * The Session DO's side of the grants protocol (product note, "Grants and
 * session closure"): two pending-operation rows, `memory_admission` and
 * `memory_closure`, written in the same transaction as the local state they
 * accompany and driven to acknowledgment by the create or end request that
 * wrote them, by a retried create or end, or by the session alarm after an
 * eviction. Sessions without bindings have neither row.
 *
 * A Memory DO call that does not answer within `RPC_TIMEOUT_MS` is an
 * uncertain outcome: the row stays pending with a next attempt, and the
 * caller says so instead of claiming success.
 *
 * Recovery is armed before the RPC leaves, not after it fails: every
 * attempt first moves the row's next attempt to `ATTEMPT_DEADLINE_MS` from
 * now and the caller sets the session alarm to it, so an object that dies
 * with the call in flight (before any catch could run) is still woken. The
 * Memory DO is idempotent for both calls, so a re-drive after a remote
 * commit whose reply was lost just reads the committed state.
 */

export interface MemoryAdmissionRow {
  [key: string]: SqlStorageValue;
  bindings_json: string;
  memory_do_key: string;
  state: "pending" | "issued" | "rejected";
  reason: string | null;
  resource: string | null;
  document_id: string | null;
  attempts: number;
  next_attempt_at_ms: number | null;
  last_error: string | null;
  updated_at: string;
}

export interface MemoryClosureRow {
  [key: string]: SqlStorageValue;
  state: "pending" | "acknowledged";
  attempts: number;
  next_attempt_at_ms: number | null;
  last_error: string | null;
  updated_at: string;
}

export interface MemorySessionEnv {
  MEMORY?: MemoryNamespace;
}

export const MEMORY_ADMISSION_PENDING = "memory_admission_pending";
export const MEMORY_ADMISSION_REJECTED = "memory_admission_rejected";

const RPC_TIMEOUT_MS = 10_000;
/** When the alarm re-drives an attempt whose object never came back to record its outcome. */
export const ATTEMPT_DEADLINE_MS = RPC_TIMEOUT_MS + 1_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

/** Runs between arming the pending row and issuing its RPC; the caller sets its alarm here. */
export type ArmedHook = () => Promise<void>;

export function ensureMemorySessionSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS memory_admission (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      bindings_json TEXT NOT NULL,
      memory_do_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'issued', 'rejected')),
      reason TEXT,
      resource TEXT,
      document_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at_ms INTEGER,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_closure (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at_ms INTEGER,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

export function readMemoryAdmission(sql: SqlStorage): MemoryAdmissionRow | undefined {
  return sql
    .exec<MemoryAdmissionRow>("SELECT * FROM memory_admission WHERE slot = 1")
    .toArray()[0];
}

export function readMemoryClosure(sql: SqlStorage): MemoryClosureRow | undefined {
  return sql
    .exec<MemoryClosureRow>("SELECT * FROM memory_closure WHERE slot = 1")
    .toArray()[0];
}

export function memoryBindings(sql: SqlStorage): MemoryBinding[] {
  const row = readMemoryAdmission(sql);
  return row ? (JSON.parse(row.bindings_json) as MemoryBinding[]) : [];
}

/**
 * What the Workerd host receives on `/session` and `/turn` (work 026, C5):
 * the Memory DO name it cannot derive itself, the managed session id it
 * presents to that object, and the admitted bindings.
 */
export interface WorkerdMemoryPayload {
  objectName: string;
  sessionId: string;
  bindings: MemoryBinding[];
}

export function workerdMemoryPayload(sql: SqlStorage, sessionId: string): WorkerdMemoryPayload | undefined {
  const row = readMemoryAdmission(sql);
  if (!row) return undefined;
  return {
    objectName: row.memory_do_key,
    sessionId,
    bindings: JSON.parse(row.bindings_json) as MemoryBinding[],
  };
}

/**
 * Call inside the transaction that inserts the session row. The row is
 * born armed: its next attempt is the deadline of the RPC the caller is
 * about to issue, so the alarm set from it wakes a dead object.
 */
export function recordMemoryAdmission(
  sql: SqlStorage,
  bindings: MemoryBinding[],
  memoryObject: string,
  timestamp: string,
): void {
  sql.exec(
    `INSERT INTO memory_admission (
       slot, bindings_json, memory_do_key, state, attempts, next_attempt_at_ms, updated_at
     ) VALUES (1, ?, ?, 'pending', 0, ?, ?)`,
    JSON.stringify(bindings),
    memoryObject,
    Date.now() + ATTEMPT_DEADLINE_MS,
    timestamp,
  );
}

/** Call inside the transaction that marks the session ended; born armed like the admission row. */
export function recordMemoryClosure(sql: SqlStorage, timestamp: string): void {
  sql.exec(
    `INSERT INTO memory_closure (slot, state, attempts, next_attempt_at_ms, updated_at)
     VALUES (1, 'pending', 0, ?, ?)
     ON CONFLICT(slot) DO NOTHING`,
    Date.now() + ATTEMPT_DEADLINE_MS,
    timestamp,
  );
}

export function closureState(sql: SqlStorage): "pending" | "acknowledged" | undefined {
  return readMemoryClosure(sql)?.state;
}

export function admissionState(row: MemoryAdmissionRow | undefined): MemoryAdmissionState | undefined {
  if (!row) return undefined;
  if (row.state === "issued") return { state: "issued" };
  if (row.state === "rejected") {
    return {
      state: "rejected",
      reason: row.reason ?? "rejected",
      ...(row.resource ? { resource: row.resource } : {}),
      ...(row.document_id ? { id: row.document_id } : {}),
    };
  }
  return { state: "pending", ...(row.last_error ? { error: row.last_error } : {}) };
}

/**
 * Bindings as inspection reports them from local state alone: writable
 * needs read-write access, issued grants and a session that has not ended.
 * The document's own write policy is only known to the Memory DO; see
 * `liveMemoryBindings`.
 */
export function localMemoryBindings(sql: SqlStorage, ended: boolean): SessionMemoryBinding[] | undefined {
  const row = readMemoryAdmission(sql);
  if (!row) return undefined;
  const bindings = JSON.parse(row.bindings_json) as MemoryBinding[];
  return bindings.map((binding) => ({
    ...binding,
    writable: binding.access === "read-write" && row.state === "issued" && !ended,
  }));
}

/** Bindings with `writable` as the Memory DO sees it right now (policy, closure and grant). */
export async function liveMemoryBindings(
  sql: SqlStorage,
  env: MemorySessionEnv,
  sessionId: string,
  ended: boolean,
): Promise<SessionMemoryBinding[] | undefined> {
  const local = localMemoryBindings(sql, ended);
  const row = readMemoryAdmission(sql);
  if (!local || !row || row.state !== "issued" || ended || !env.MEMORY) return local;
  const states = await withTimeout(
    env.MEMORY.getByName(row.memory_do_key).grantStates(sessionId),
    "grantStates",
  ).catch(() => null);
  if (!states) return local;
  const writable = new Map(states.map((state) => [state.resource, state.writable]));
  return local.map((binding) => ({
    ...binding,
    writable: binding.writable && (writable.get(binding.resource) ?? false),
  }));
}

function delayFor(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1]!;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Memory DO ${label} did not answer within ${String(RPC_TIMEOUT_MS)} ms`)),
          RPC_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drives a pending admission to `issued` or `rejected`. Never throws: a
 * transport failure or timeout leaves it pending with a next attempt.
 * `armed` runs after the row's next attempt is moved to the RPC deadline
 * and before the RPC is issued.
 */
export async function driveMemoryAdmission(
  storage: DurableObjectStorage,
  env: MemorySessionEnv,
  sessionId: string,
  armed?: ArmedHook,
): Promise<MemoryAdmissionState | undefined> {
  const sql = storage.sql;
  const row = readMemoryAdmission(sql);
  if (!row || row.state !== "pending") return admissionState(row);
  const bindings = JSON.parse(row.bindings_json) as MemoryBinding[];
  const timestamp = new Date().toISOString();
  if (!env.MEMORY) {
    sql.exec(
      `UPDATE memory_admission SET attempts = attempts + 1, next_attempt_at_ms = ?, last_error = ?, updated_at = ? WHERE slot = 1`,
      Date.now() + delayFor(row.attempts + 1),
      "Project memory is not configured",
      timestamp,
    );
    return admissionState(readMemoryAdmission(sql));
  }
  sql.exec(
    "UPDATE memory_admission SET next_attempt_at_ms = ?, updated_at = ? WHERE slot = 1",
    Date.now() + ATTEMPT_DEADLINE_MS,
    timestamp,
  );
  if (armed) await armed();
  try {
    const outcome = await withTimeout<IssueGrantsOutcome>(
      env.MEMORY.getByName(row.memory_do_key).issueGrants(sessionId, bindings),
      "issueGrants",
    );
    if (outcome.kind === "issued") {
      sql.exec(
        `UPDATE memory_admission SET state = 'issued', next_attempt_at_ms = NULL, last_error = NULL, updated_at = ? WHERE slot = 1`,
        timestamp,
      );
    } else {
      // conflict: the Memory DO holds a different set for this session id;
      // closed: it was ended before this create reached it; rejected: an
      // undeclared resource or a missing document. None can be retried.
      const reason =
        outcome.kind === "rejected" ? outcome.reason : outcome.kind === "closed" ? "session_closed" : "conflict";
      sql.exec(
        `UPDATE memory_admission
         SET state = 'rejected', reason = ?, resource = ?, document_id = ?,
             next_attempt_at_ms = NULL, last_error = NULL, updated_at = ?
         WHERE slot = 1`,
        reason,
        outcome.kind === "rejected" ? outcome.resource : null,
        outcome.kind === "rejected" ? (outcome.id ?? null) : null,
        timestamp,
      );
    }
  } catch (error) {
    sql.exec(
      `UPDATE memory_admission SET attempts = attempts + 1, next_attempt_at_ms = ?, last_error = ?, updated_at = ? WHERE slot = 1`,
      Date.now() + delayFor(row.attempts + 1),
      error instanceof Error ? error.message : String(error),
      timestamp,
    );
  }
  return admissionState(readMemoryAdmission(sql));
}

/**
 * Drives a pending closure to `acknowledged`. Returns whether it is
 * acknowledged; a transport failure or timeout leaves it pending with a
 * next attempt and the caller must answer "uncertain", never success.
 */
export async function driveMemoryClosure(
  storage: DurableObjectStorage,
  env: MemorySessionEnv,
  sessionId: string,
  armed?: ArmedHook,
): Promise<"acknowledged" | "pending" | "none"> {
  const sql = storage.sql;
  const row = readMemoryClosure(sql);
  if (!row) return "none";
  if (row.state === "acknowledged") return "acknowledged";
  const admission = readMemoryAdmission(sql);
  const timestamp = new Date().toISOString();
  const fail = (message: string): "pending" => {
    sql.exec(
      `UPDATE memory_closure SET attempts = attempts + 1, next_attempt_at_ms = ?, last_error = ?, updated_at = ? WHERE slot = 1`,
      Date.now() + delayFor(row.attempts + 1),
      message,
      timestamp,
    );
    return "pending";
  };
  if (!admission) {
    // Nothing was ever admitted against a Memory DO; nothing to revoke.
    sql.exec(
      `UPDATE memory_closure SET state = 'acknowledged', next_attempt_at_ms = NULL, last_error = NULL, updated_at = ? WHERE slot = 1`,
      timestamp,
    );
    return "acknowledged";
  }
  if (!env.MEMORY) return fail("Project memory is not configured");
  sql.exec(
    "UPDATE memory_closure SET next_attempt_at_ms = ?, updated_at = ? WHERE slot = 1",
    Date.now() + ATTEMPT_DEADLINE_MS,
    timestamp,
  );
  if (armed) await armed();
  try {
    await withTimeout(
      env.MEMORY.getByName(admission.memory_do_key).closeSession(sessionId),
      "closeSession",
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  sql.exec(
    `UPDATE memory_closure SET state = 'acknowledged', next_attempt_at_ms = NULL, last_error = NULL, updated_at = ? WHERE slot = 1`,
    timestamp,
  );
  return "acknowledged";
}

/** The earliest pending memory attempt, for the shared session alarm. */
export function nextMemoryAttemptMs(sql: SqlStorage): number | undefined {
  const admission = readMemoryAdmission(sql);
  const closure = readMemoryClosure(sql);
  const candidates = [
    admission?.state === "pending" ? admission.next_attempt_at_ms : null,
    closure?.state === "pending" ? closure.next_attempt_at_ms : null,
  ].filter((value): value is number => typeof value === "number");
  return candidates.length ? Math.min(...candidates) : undefined;
}

/** Re-drives whatever is due; called from the session alarm. */
export async function redriveMemory(
  storage: DurableObjectStorage,
  env: MemorySessionEnv,
  sessionId: string,
  nowMs: number,
  armed?: ArmedHook,
): Promise<void> {
  const admission = readMemoryAdmission(storage.sql);
  if (
    admission?.state === "pending" &&
    admission.next_attempt_at_ms !== null &&
    admission.next_attempt_at_ms <= nowMs
  ) {
    await driveMemoryAdmission(storage, env, sessionId, armed);
  }
  const closure = readMemoryClosure(storage.sql);
  if (
    closure?.state === "pending" &&
    closure.next_attempt_at_ms !== null &&
    closure.next_attempt_at_ms <= nowMs
  ) {
    await driveMemoryClosure(storage, env, sessionId, armed);
  }
}
