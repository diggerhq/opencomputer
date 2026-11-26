import { DurableObject } from "cloudflare:workers";

import {
  capabilityFor,
  executeDeterministicOperation,
  type CapabilityFault,
  type SpikeExecutionSnapshot,
  type SpikeOperation,
  type SpikeValue,
} from "./protocol.js";

interface SpikeEnv {}

interface SessionRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  deployment_id: string;
  plan_json: string;
  mode: SpikeExecutionSnapshot["mode"];
  continuation: number;
  escalation_epoch: number;
  runtime_starts: number;
  fault_json: string | null;
}

interface ResultRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  executor: "edge" | "sandbox";
  value_json: string;
}

function sameValue(left: SpikeValue, right: SpikeValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class DoFirstSessionDurableObject extends DurableObject<SpikeEnv> {
  constructor(ctx: DurableObjectState, env: SpikeEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS spike_session (
          session_id TEXT PRIMARY KEY,
          deployment_id TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          mode TEXT NOT NULL,
          continuation INTEGER NOT NULL,
          escalation_epoch INTEGER NOT NULL,
          runtime_starts INTEGER NOT NULL,
          fault_json TEXT
        );
        CREATE TABLE IF NOT EXISTS spike_results (
          operation_index INTEGER PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          executor TEXT NOT NULL,
          value_json TEXT NOT NULL
        );
      `);
    });
  }

  initialize(input: {
    sessionId: string;
    deploymentId: string;
    plan: SpikeOperation[];
  }): SpikeExecutionSnapshot {
    if (!input.sessionId || !input.deploymentId || input.plan.length === 0) {
      throw new Error("Session, deployment, and a non-empty plan are required");
    }
    if (new Set(input.plan.map((operation) => operation.id)).size !== input.plan.length) {
      throw new Error("Operation IDs must be unique");
    }
    const existing = this.sessionOrNull();
    if (existing) {
      if (
        existing.session_id !== input.sessionId ||
        existing.deployment_id !== input.deploymentId ||
        existing.plan_json !== JSON.stringify(input.plan)
      ) {
        throw new Error("Session is already initialized with another plan");
      }
      return this.snapshotFrom(existing);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO spike_session (
         session_id, deployment_id, plan_json, mode, continuation,
         escalation_epoch, runtime_starts, fault_json
       ) VALUES (?, ?, ?, 'running_edge', 0, 0, 0, NULL)`,
      input.sessionId,
      input.deploymentId,
      JSON.stringify(input.plan),
    );
    return this.snapshot();
  }

  runEdge(): SpikeExecutionSnapshot {
    this.ctx.storage.transactionSync(() => {
      const session = this.session();
      if (session.mode !== "running_edge") return;
      const plan = JSON.parse(session.plan_json) as SpikeOperation[];
      let continuation = session.continuation;
      while (continuation < plan.length) {
        const operation = plan[continuation];
        if (!operation) throw new Error("Execution plan is corrupt");
        const capability = capabilityFor(operation);
        if (capability) {
          const escalationEpoch = session.escalation_epoch + 1;
          const fault: CapabilityFault = {
            type: "capability.fault",
            sessionId: session.session_id,
            deploymentId: session.deployment_id,
            operationId: operation.id,
            operationIndex: continuation,
            capability,
            escalationEpoch,
          };
          this.ctx.storage.sql.exec(
            `UPDATE spike_session
             SET mode = 'awaiting_runtime', escalation_epoch = ?,
                 runtime_starts = runtime_starts + 1, fault_json = ?`,
            escalationEpoch,
            JSON.stringify(fault),
          );
          return;
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO spike_results (
             operation_index, operation_id, executor, value_json
           ) VALUES (?, ?, 'edge', ?)`,
          continuation,
          operation.id,
          JSON.stringify(executeDeterministicOperation(operation)),
        );
        continuation += 1;
        this.ctx.storage.sql.exec(
          "UPDATE spike_session SET continuation = ?",
          continuation,
        );
      }
      this.ctx.storage.sql.exec(
        "UPDATE spike_session SET mode = 'completed', fault_json = NULL",
      );
    });
    return this.snapshot();
  }

  acknowledgeRuntime(escalationEpoch: number): SpikeExecutionSnapshot {
    const session = this.session();
    if (
      session.mode === "running_sandbox" &&
      session.escalation_epoch === escalationEpoch
    ) {
      return this.snapshotFrom(session);
    }
    if (
      session.mode !== "awaiting_runtime" ||
      session.escalation_epoch !== escalationEpoch
    ) {
      throw new Error("Capability fault is no longer active");
    }
    this.ctx.storage.sql.exec(
      "UPDATE spike_session SET mode = 'running_sandbox'",
    );
    return this.snapshot();
  }

  commitRuntimeResult(input: {
    escalationEpoch: number;
    operationId: string;
    value: SpikeValue;
  }): SpikeExecutionSnapshot {
    const committed = this.ctx.storage.sql
      .exec<ResultRow>(
        `SELECT operation_id, executor, value_json
         FROM spike_results WHERE operation_id = ?`,
        input.operationId,
      )
      .toArray()[0];
    if (committed) {
      const value = JSON.parse(committed.value_json) as SpikeValue;
      if (committed.executor !== "sandbox" || !sameValue(value, input.value)) {
        throw new Error("Operation result conflicts with committed result");
      }
      return this.snapshot();
    }

    this.ctx.storage.transactionSync(() => {
      const session = this.session();
      if (
        session.mode !== "running_sandbox" ||
        session.escalation_epoch !== input.escalationEpoch
      ) {
        throw new Error("Runtime does not own the active escalation");
      }
      const plan = JSON.parse(session.plan_json) as SpikeOperation[];
      const operation = plan[session.continuation];
      if (!operation || operation.id !== input.operationId) {
        throw new Error("Runtime result is not for the current continuation");
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO spike_results (
           operation_index, operation_id, executor, value_json
         ) VALUES (?, ?, 'sandbox', ?)`,
        session.continuation,
        operation.id,
        JSON.stringify(input.value),
      );
      const continuation = session.continuation + 1;
      this.ctx.storage.sql.exec(
        `UPDATE spike_session
         SET continuation = ?, mode = ?, fault_json = NULL`,
        continuation,
        continuation === plan.length ? "completed" : "running_sandbox",
      );
    });
    return this.snapshot();
  }

  snapshot(): SpikeExecutionSnapshot {
    return this.snapshotFrom(this.session());
  }

  private sessionOrNull(): SessionRow | null {
    return (
      this.ctx.storage.sql
        .exec<SessionRow>(
          `SELECT session_id, deployment_id, plan_json, mode, continuation,
                  escalation_epoch, runtime_starts, fault_json
           FROM spike_session LIMIT 1`,
        )
        .toArray()[0] ?? null
    );
  }

  private session(): SessionRow {
    const session = this.sessionOrNull();
    if (!session) throw new Error("Session is not initialized");
    return session;
  }

  private snapshotFrom(session: SessionRow): SpikeExecutionSnapshot {
    const results = this.ctx.storage.sql
      .exec<ResultRow>(
        `SELECT operation_id, executor, value_json
         FROM spike_results ORDER BY operation_index`,
      )
      .toArray()
      .map((row) => ({
        operationId: row.operation_id,
        executor: row.executor,
        value: JSON.parse(row.value_json) as SpikeValue,
      }));
    return {
      sessionId: session.session_id,
      deploymentId: session.deployment_id,
      mode: session.mode,
      continuation: session.continuation,
      escalationEpoch: session.escalation_epoch,
      ...(session.fault_json
        ? { fault: JSON.parse(session.fault_json) as CapabilityFault }
        : {}),
      results,
      metrics: {
        runtimeStarts: session.runtime_starts,
        edgeOperations: results.filter((result) => result.executor === "edge")
          .length,
        sandboxOperations: results.filter(
          (result) => result.executor === "sandbox",
        ).length,
      },
    };
  }
}
