import { DurableObject } from "cloudflare:workers";

import type { AgentDeployment, WorkerdSessionLease } from "../protocol.js";

const FILL_LEASE_MS = 2 * 60_000;
const MODEL_GATEWAY_CAPABILITY_MS = 15 * 60_000;

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sameHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export interface WarmRuntimeLease {
  microvmId: string;
  endpoint: string;
  claimToken: string;
  createdAt: string;
}

interface PoolRow {
  [key: string]: SqlStorageValue;
  status: "empty" | "filling" | "ready";
  microvm_id: string | null;
  endpoint: string | null;
  claim_token: string | null;
  created_at: string | null;
  fill_started_at: number | null;
}

export function workerdModelConfiguration(
  deployment: Pick<AgentDeployment, "models" | "defaultModel">,
): string {
  return JSON.stringify({
    models: [...(deployment.models ?? [])].sort((left, right) =>
      left.provider === right.provider
        ? left.model.localeCompare(right.model)
        : left.provider.localeCompare(right.provider),
    ),
    defaultModel: deployment.defaultModel ?? null,
  });
}

export class DeploymentPoolDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS deployment_pool (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          status TEXT NOT NULL CHECK (status IN ('empty', 'filling', 'ready')),
          microvm_id TEXT,
          endpoint TEXT,
          claim_token TEXT,
          created_at TEXT,
          fill_started_at INTEGER
        );
        INSERT OR IGNORE INTO deployment_pool (slot, status)
        VALUES (1, 'empty');
        CREATE TABLE IF NOT EXISTS workerd_pool (
          slot_id TEXT PRIMARY KEY,
          model_configuration TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('filling', 'ready')),
          runtime_session_id TEXT,
          opencode_session_id TEXT,
          runtime_boot_id TEXT,
          runtime_activation INTEGER,
          runtime_init_ms REAL,
          created_at TEXT,
          fill_started_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workerd_model_gateway_capabilities (
          id TEXT PRIMARY KEY,
          slot_id TEXT NOT NULL UNIQUE,
          token_hash TEXT NOT NULL,
          session_id TEXT,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      const workerdPoolColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(workerd_pool)")
        .toArray();
      if (!workerdPoolColumns.some((column) => column.name === "model_configuration")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE workerd_pool ADD COLUMN model_configuration TEXT NOT NULL DEFAULT ''",
        );
      }
    });
  }

  beginFill(now = Date.now()): boolean {
    const row = this.row();
    if (row.status === "ready") return false;
    if (
      row.status === "filling" &&
      row.fill_started_at !== null &&
      now - row.fill_started_at < FILL_LEASE_MS
    ) {
      return false;
    }
    this.ctx.storage.sql.exec(
      `UPDATE deployment_pool
       SET status = 'filling', microvm_id = NULL, endpoint = NULL,
           claim_token = NULL, created_at = NULL, fill_started_at = ?
       WHERE slot = 1`,
      now,
    );
    return true;
  }

  completeFill(runtime: WarmRuntimeLease): boolean {
    const changed = this.ctx.storage.sql.exec(
      `UPDATE deployment_pool
       SET status = 'ready', microvm_id = ?, endpoint = ?, claim_token = ?,
           created_at = ?, fill_started_at = NULL
       WHERE slot = 1 AND status = 'filling'`,
      runtime.microvmId,
      runtime.endpoint,
      runtime.claimToken,
      runtime.createdAt,
    ).rowsWritten;
    return changed === 1;
  }

  failFill(): void {
    this.ctx.storage.sql.exec(
      `UPDATE deployment_pool
       SET status = 'empty', microvm_id = NULL, endpoint = NULL,
           claim_token = NULL, created_at = NULL, fill_started_at = NULL
       WHERE slot = 1 AND status = 'filling'`,
    );
  }

  claim(): WarmRuntimeLease | null {
    const row = this.row();
    if (
      row.status !== "ready" ||
      !row.microvm_id ||
      !row.endpoint ||
      !row.claim_token ||
      !row.created_at
    ) {
      return null;
    }
    const changed = this.ctx.storage.sql.exec(
      `UPDATE deployment_pool
       SET status = 'empty', microvm_id = NULL, endpoint = NULL,
           claim_token = NULL, created_at = NULL, fill_started_at = NULL
       WHERE slot = 1 AND status = 'ready' AND microvm_id = ?`,
      row.microvm_id,
    ).rowsWritten;
    if (changed !== 1) return null;
    return {
      microvmId: row.microvm_id,
      endpoint: row.endpoint,
      claimToken: row.claim_token,
      createdAt: row.created_at,
    };
  }

  inspect(): { status: PoolRow["status"]; runtime: WarmRuntimeLease | null } {
    const row = this.row();
    return {
      status: row.status,
      runtime:
        row.status === "ready" &&
        row.microvm_id &&
        row.endpoint &&
        row.claim_token &&
        row.created_at
          ? {
              microvmId: row.microvm_id,
              endpoint: row.endpoint,
              claimToken: row.claim_token,
              createdAt: row.created_at,
            }
          : null,
    };
  }

  beginWorkerdFill(
    target: number,
    modelConfiguration: string,
    now = Date.now(),
  ): string[] {
    this.ctx.storage.sql.exec(
      `DELETE FROM workerd_pool
       WHERE slot_id IN (
         SELECT slot_id FROM workerd_model_gateway_capabilities
         WHERE expires_at <= ? AND session_id IS NULL
       )`,
      now,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM workerd_model_gateway_capabilities WHERE expires_at <= ? AND session_id IS NULL",
      now,
    );
    const boundedTarget = Math.max(0, Math.min(20, Math.floor(target)));
    this.ctx.storage.sql.exec(
      "DELETE FROM workerd_pool WHERE status = 'filling' AND fill_started_at < ?",
      now - FILL_LEASE_MS,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM workerd_pool WHERE model_configuration <> ?",
      modelConfiguration,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM workerd_model_gateway_capabilities
       WHERE session_id IS NULL
         AND slot_id NOT IN (SELECT slot_id FROM workerd_pool)`,
    );
    const existing = Number(
      this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM workerd_pool")
        .one().count,
    );
    const slots = Array.from(
      { length: Math.max(0, boundedTarget - existing) },
      () => crypto.randomUUID(),
    );
    for (const slot of slots) {
      this.ctx.storage.sql.exec(
        `INSERT INTO workerd_pool
           (slot_id, model_configuration, status, fill_started_at)
         VALUES (?, ?, 'filling', ?)`,
        slot,
        modelConfiguration,
        now,
      );
    }
    return slots;
  }

  async createWorkerdModelGatewayCapability(
    slot: string,
    now = Date.now(),
  ): Promise<{ id: string; token: string }> {
    const filling = this.ctx.storage.sql
      .exec<{ slot_id: string }>(
        "SELECT slot_id FROM workerd_pool WHERE slot_id = ? AND status = 'filling'",
        slot,
      )
      .toArray()[0];
    if (!filling) throw new Error("Workerd pool slot is not filling");
    const id = crypto.randomUUID();
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    this.ctx.storage.sql.exec(
      `INSERT INTO workerd_model_gateway_capabilities
         (id, slot_id, token_hash, session_id, expires_at, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
      id,
      slot,
      await sha256(token),
      now + MODEL_GATEWAY_CAPABILITY_MS,
      now,
    );
    return { id, token };
  }

  completeWorkerdFill(slot: string, lease: WorkerdSessionLease): boolean {
    return (
      this.ctx.storage.sql.exec(
        `UPDATE workerd_pool
         SET status = 'ready', runtime_session_id = ?, opencode_session_id = ?,
             runtime_boot_id = ?, runtime_activation = ?, runtime_init_ms = ?,
             created_at = ?
         WHERE slot_id = ? AND status = 'filling'
           AND EXISTS (
             SELECT 1 FROM workerd_model_gateway_capabilities
             WHERE slot_id = ? AND id = ? AND session_id IS NULL
           )`,
        lease.runtimeSessionId,
        lease.opencodeSessionId,
        lease.runtimeBootId,
        lease.runtimeActivation,
        lease.runtimeInitMs,
        lease.createdAt,
        slot,
        slot,
        lease.modelGatewayCapabilityId,
      ).rowsWritten === 1
    );
  }

  failWorkerdFill(slot: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM workerd_model_gateway_capabilities WHERE slot_id = ? AND session_id IS NULL",
      slot,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM workerd_pool WHERE slot_id = ? AND status = 'filling'",
      slot,
    );
  }

  claimWorkerd(
    sessionId: string,
    modelConfiguration: string,
    now = Date.now(),
  ): WorkerdSessionLease | null {
    const row = this.ctx.storage.sql
      .exec<{
        slot_id: string;
        runtime_session_id: string;
        opencode_session_id: string;
        runtime_boot_id: string;
        runtime_activation: number;
        runtime_init_ms: number;
        created_at: string;
        capability_id: string;
        expires_at: number;
      }>(
        `SELECT pool.slot_id, pool.runtime_session_id, pool.opencode_session_id,
                pool.runtime_boot_id, pool.runtime_activation, pool.runtime_init_ms,
                pool.created_at, capability.id AS capability_id,
                capability.expires_at AS expires_at
         FROM workerd_pool AS pool
         JOIN workerd_model_gateway_capabilities AS capability
           ON capability.slot_id = pool.slot_id
         WHERE pool.status = 'ready' AND pool.model_configuration = ?
           AND capability.session_id IS NULL
           AND capability.expires_at > ?
         ORDER BY pool.created_at, pool.slot_id
         LIMIT 1`,
        modelConfiguration,
        now,
      )
      .toArray()[0];
    if (!row) return null;
    let claimed = false;
    this.ctx.storage.transactionSync(() => {
      const bound = this.ctx.storage.sql.exec(
        `UPDATE workerd_model_gateway_capabilities SET session_id = ?
         WHERE id = ? AND session_id IS NULL AND expires_at > ?`,
        sessionId,
        row.capability_id,
        now,
      ).rowsWritten;
      const removed = this.ctx.storage.sql.exec(
        "DELETE FROM workerd_pool WHERE slot_id = ? AND status = 'ready'",
        row.slot_id,
      ).rowsWritten;
      if (bound !== 1 || removed !== 1) throw new Error("Workerd pool claim raced");
      claimed = true;
    });
    if (!claimed) return null;
    return {
      runtimeSessionId: row.runtime_session_id,
      opencodeSessionId: row.opencode_session_id,
      modelGatewayCapabilityId: row.capability_id,
      runtimeBootId: row.runtime_boot_id,
      runtimeActivation: Number(row.runtime_activation),
      runtimeInitMs: Number(row.runtime_init_ms),
      createdAt: row.created_at,
    };
  }

  /**
   * A lease claimed for a session that another request admitted first. The
   * runtime session was never configured, so the slot returns to the pool
   * as ready and its capability is unbound. False when the capability has
   * expired meanwhile: the runtime is retired with it by the next fill's
   * sweep, as any expired standby is.
   */
  releaseWorkerd(
    lease: WorkerdSessionLease,
    modelConfiguration: string,
    now = Date.now(),
  ): boolean {
    let released = false;
    this.ctx.storage.transactionSync(() => {
      const capability = this.ctx.storage.sql
        .exec<{ slot_id: string; expires_at: number }>(
          "SELECT slot_id, expires_at FROM workerd_model_gateway_capabilities WHERE id = ?",
          lease.modelGatewayCapabilityId,
        )
        .toArray()[0];
      if (!capability) return;
      this.ctx.storage.sql.exec(
        "UPDATE workerd_model_gateway_capabilities SET session_id = NULL WHERE id = ?",
        lease.modelGatewayCapabilityId,
      );
      if (capability.expires_at <= now) return;
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO workerd_pool
           (slot_id, model_configuration, status, runtime_session_id, opencode_session_id,
            runtime_boot_id, runtime_activation, runtime_init_ms, created_at, fill_started_at)
         VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)`,
        capability.slot_id,
        modelConfiguration,
        lease.runtimeSessionId,
        lease.opencodeSessionId,
        lease.runtimeBootId,
        lease.runtimeActivation,
        lease.runtimeInitMs,
        lease.createdAt,
        now,
      );
      released = true;
    });
    return released;
  }

  async authenticateWorkerdModelGateway(
    capabilityId: string,
    token: string,
  ): Promise<{ sessionId: string } | null> {
    const row = this.ctx.storage.sql
      .exec<{ token_hash: string; session_id: string; expires_at: number }>(
        `SELECT token_hash, session_id, expires_at
         FROM workerd_model_gateway_capabilities
         WHERE id = ? AND session_id IS NOT NULL`,
        capabilityId,
      )
      .toArray()[0];
    if (!row || !sameHash(row.token_hash, await sha256(token))) return null;
    return { sessionId: row.session_id };
  }

  inspectWorkerd(): { filling: number; ready: number } {
    const counts = this.ctx.storage.sql
      .exec<{ status: "filling" | "ready"; count: number }>(
        "SELECT status, COUNT(*) AS count FROM workerd_pool GROUP BY status",
      )
      .toArray();
    return {
      filling: Number(counts.find((row) => row.status === "filling")?.count ?? 0),
      ready: Number(counts.find((row) => row.status === "ready")?.count ?? 0),
    };
  }

  private row(): PoolRow {
    return this.ctx.storage.sql
      .exec<PoolRow>(
        `SELECT status, microvm_id, endpoint, claim_token, created_at,
                fill_started_at
         FROM deployment_pool WHERE slot = 1`,
      )
      .one();
  }
}
