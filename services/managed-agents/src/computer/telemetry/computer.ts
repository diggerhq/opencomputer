// The computer's gateway events (work 054, "Gateway" in the event catalog),
// mapped onto ComputerDurableObject's seams. dash-cal#17 split them between
// its WorkspaceDO (queue, process, acknowledge) and MachineDO (dispatches,
// host socket); here one object does both, and this class keeps the event
// shapes out of durable-object.ts, which only calls one-line hooks.
//
//   Slack queue   queue.started / .retried / .failed, message.deduped /
//                 .ignored, command.handled (`!secret`), ack.done (K1)
//   dispatches    dispatch.created / .sent / .resent / .parked / .replied
//   host socket   host.connected / .disconnected; the telemetry credential in `welcome`
//   subscriptions subscription.* (work 082), from ModelSubscriptions through `subscription`
//   billing       billing.vm_terminated (work 086), from the idle check
//
// Invariants: no hook throws or awaits anything a turn waits for; batches
// leave through `waitUntil`. With telemetry off (gateway.ts) every hook still
// runs and validates, and nothing is sent.

import type { ComputerEdgeEnv } from "../config.js";
import { isPoolId } from "../names.js";
import { type CalvinTraceContext, sessionKey } from "../protocol.js";
import type { SlackMessageJob } from "../slack.js";
import type { SubscriptionEventName } from "./catalog.js";
import { credentialId, issueTelemetryCredential } from "./credential.js";
import type { EventFields } from "./emitter.js";
import type { Dimensions } from "./envelope.js";
import {
  type GatewayTelemetry,
  type TraceSource,
  gatewayTelemetry,
  mintTrace,
  traceFields,
  traceTelemetry,
} from "./gateway.js";

/** What a host socket carries across hibernation (durable-object.ts `hello` writes it). */
export interface HostAttachment {
  hostId?: string;
  version?: string;
  /** When its hello arrived (work 054: a connection's lifetime). */
  connectedAt?: number;
  /** The hello's `protocol` and `features` (work 077: 2, `model-proxy`). */
  protocol?: number;
  features?: string[];
  /** Work 084: false from the hello until its `welcome` is sent; absent on attachments written before the flag (already welcomed). */
  welcomed?: boolean;
}

export interface ComputerTelemetryDeps {
  env: ComputerEdgeEnv;
  sql: SqlStorage;
  waitUntil(promise: Promise<unknown>): void;
  /** The organization this object is bound to, if any. */
  accountId(): string | undefined;
  /** The connected host's socket, if any. */
  socket(): WebSocket | undefined;
}

/** What `acknowledge` reports: which indicator Slack confirmed, and how long its calls took. */
export interface Acknowledgement {
  indicator: "status" | "reaction";
  ok: boolean;
  callMs: number;
}

/** The parts of a queued delivery its events use (durable-object.ts `Dispatch`). */
interface TracedDispatch {
  trace?: CalvinTraceContext;
}

/** The dispatch row columns `flush` reads. */
interface DispatchRow {
  id: string;
  key: string;
  attempts: number;
  createdAt: number;
}

export class ComputerTelemetry {
  constructor(private readonly deps: ComputerTelemetryDeps) {}

  /** A new trace for a message that did not come through `message.received` (a secret submission's). */
  trace(source: TraceSource): CalvinTraceContext {
    return mintTrace(this.deps.env, source);
  }

  /** An emitter for one Slack job's work: its trace, session and organization on every event. */
  job(job: Pick<SlackMessageJob, "teamId" | "channelId" | "threadTs" | "trace">): GatewayTelemetry {
    return traceTelemetry(this.deps.env, job.trace, { ...this.org(), session_key: sessionKey(job.teamId, job.channelId, job.threadTs) });
  }

  /** An emitter for work on no single trace (a socket message, an RPC, a lifecycle step). */
  invocation(): GatewayTelemetry {
    return gatewayTelemetry(this.deps.env, { base: { ...this.org(), ...this.host() } });
  }

  /** Send an emitter's batch after the invocation; never delays or fails it. */
  send(t: GatewayTelemetry): void {
    this.deps.waitUntil(t.done());
  }

  /** Run `work` on the caller's emitter, or on one of its own that is sent when the work settles. */
  async within<T>(t: GatewayTelemetry | undefined, work: (t: GatewayTelemetry) => Promise<T>): Promise<T> {
    if (t) return work(t);
    const own = this.invocation();
    try {
      return await work(own);
    } finally {
      this.send(own);
    }
  }

  // ---------------------------------------------------------------- Slack queue

  /** A job that was not queued (`acceptSlackEvent`): `message.deduped` (the key that matched) or `message.ignored`. */
  refused(job: SlackMessageJob, why: { deduped: string } | { ignored: string }): void {
    const t = this.job(job);
    if ("deduped" in why) t.emit("message.deduped", { data: { dedupe_key: why.deduped } });
    else t.emit("message.ignored", { data: { reason: why.ignored } });
    this.send(t);
  }

  /**
   * The alarm took a queued job (`queue.started`): the emitter for its work,
   * and `failed` for `queue.retried` (backing off) or `queue.failed` (given
   * up), each timed since the gateway received it. Reads the stored payload
   * itself and never throws, so a bad payload fails where it did before.
   * `inline`: taken by the drain an accept started, not the alarm's;
   * `parallel`: thread chains running then, this one included (work 068 §3f).
   */
  dequeued(payload: string, attempt: number, how: { inline: boolean; parallel: number }): { t: GatewayTelemetry; failed(final: boolean): void } {
    let job: SlackMessageJob | undefined;
    try {
      job = JSON.parse(payload) as SlackMessageJob;
    } catch {
      job = undefined;
    }
    const t = job?.teamId ? this.job(job) : this.invocation();
    const since = () => (typeof job?.receivedAt === "number" ? { duration_ms: Date.now() - job.receivedAt } : {});
    t.emit("queue.started", { ...since(), data: { attempt, inline: how.inline, parallel: how.parallel } });
    return {
      t,
      failed: (final) =>
        t.emit(final ? "queue.failed" : "queue.retried", { ...since(), outcome: "failed", error_type: "unknown", data: { attempt } }),
    };
  }

  /** `command.handled`: a gateway command (`!secret`), timed until it settles; its result or error passes through. */
  async command<T>(t: GatewayTelemetry, command: string, work: Promise<T>): Promise<T> {
    const span = t.start("command.handled", { data: { command } });
    try {
      const result = await work;
      span.end({ outcome: "completed" });
      return result;
    } catch (error) {
      span.end({ outcome: "failed", error_type: "unknown" });
      throw error;
    }
  }

  /**
   * `ack.done` (K1: Slack's time for the message → the indicator confirmed)
   * once the acknowledgement settles; the job's batch waits for it. Never rejects.
   */
  acked(t: GatewayTelemetry, job: SlackMessageJob, ack: Promise<Acknowledgement>): Promise<void> {
    const done = ack
      .then((result) =>
        t.emit("ack.done", {
          ...(job.trace ? { duration_ms: Date.now() - job.trace.sentAt } : {}),
          outcome: result.ok ? "completed" : "failed",
          ...(result.ok ? {} : { error_type: "surface_error" as const }),
          data: { indicator: result.indicator, call_ms: result.callMs },
        }),
      )
      .catch(() => {});
    t.wait(done);
    return done;
  }

  // ---------------------------------------------------------------- model subscriptions

  /** One model-subscription event (work 082: connect, refresh, 401 verdicts, refusals, the alarm), in its own batch. */
  subscription<N extends SubscriptionEventName>(name: N, fields: EventFields<N>): void {
    const t = this.invocation();
    t.emit(name, fields);
    this.send(t);
  }

  // ---------------------------------------------------------------- billing

  /** `billing.vm_terminated` (work 086): an unpaid computer's VM went, its disks kept. */
  vmTerminated(daysUnpaid: number): void {
    const t = this.invocation();
    t.emit("billing.vm_terminated", { data: { days_unpaid: daysUnpaid } });
    this.send(t);
  }

  // ---------------------------------------------------------------- dispatches

  /** The trace to send with a delivery: stamped with this send's time (the stored payload keeps the original). */
  sentTrace(dispatch: TracedDispatch): { trace?: CalvinTraceContext } {
    return dispatch.trace ? { trace: { ...dispatch.trace, dispatchedAt: Date.now() } } : {};
  }

  /** `dispatch.created`: a delivery was queued for the host; timed since the gateway received its message. */
  created(t: GatewayTelemetry, id: string, key: string, dispatch: TracedDispatch, at: number): void {
    t.emit("dispatch.created", { ...this.dispatchFields(id, key, dispatch), ...(dispatch.trace ? { duration_ms: at - dispatch.trace.receivedAt } : {}) });
  }

  /** `dispatch.parked`: no host could take it now. */
  parked(t: GatewayTelemetry, id: string, key: string, dispatch: TracedDispatch): void {
    t.emit("dispatch.parked", this.dispatchFields(id, key, dispatch));
  }

  /** `dispatch.sent`, or `.resent` after a reconnect; timed since it was queued (`wait_ms` too, work 068 §3f). */
  sent(t: GatewayTelemetry, row: DispatchRow, dispatch: TracedDispatch): void {
    const waited = Date.now() - row.createdAt;
    t.emit(row.attempts > 0 ? "dispatch.resent" : "dispatch.sent", {
      ...this.dispatchFields(row.id, row.key, dispatch),
      duration_ms: waited,
      data: row.attempts > 0 ? { attempt: row.attempts + 1 } : { attempt: 1, wait_ms: waited },
    });
  }

  /** `dispatch.replied`: the host took (or refused) a delivery; timed since it was last sent. Its own batch. */
  replied(id: string, ok: boolean, error: string | undefined): void {
    const row = [...this.deps.sql.exec<{ key: string; payload: string; updatedAt: number }>(
      "SELECT runner_key AS key, payload, updated_at AS updatedAt FROM dispatches WHERE id = ?",
      id,
    )][0];
    if (!row) return;
    let dispatch: TracedDispatch;
    try {
      dispatch = JSON.parse(row.payload) as TracedDispatch;
    } catch {
      return;
    }
    const t = this.invocation();
    t.emit("dispatch.replied", {
      ...this.dispatchFields(id, row.key, dispatch),
      duration_ms: Date.now() - row.updatedAt,
      outcome: ok ? "completed" : "failed",
      ...(ok ? {} : { error_type: error === "timeout" ? ("timeout" as const) : ("unknown" as const) }),
    });
    this.send(t);
  }

  // ---------------------------------------------------------------- host socket

  /** How long the host's previous socket (about to be replaced by `ws`) was connected, if there was one. */
  previousConnection(ws: WebSocket, sockets: WebSocket[]): number | undefined {
    let lifetime: number | undefined;
    for (const socket of sockets) {
      if (socket === ws) continue;
      const at = attachment(socket)?.connectedAt;
      if (at) lifetime = Date.now() - at;
    }
    return lifetime;
  }

  /** `host.connected` (after `hello`), with the previous connection's lifetime. */
  connected(version: string, previous: number | undefined): void {
    const t = this.invocation();
    t.emit("host.connected", { ...(previous !== undefined ? { duration_ms: previous } : {}), data: { host_version: version } });
    this.send(t);
  }

  /** `host.disconnected`: a host socket closed, with how long it was connected. */
  disconnected(ws: WebSocket, code: number): void {
    const host = attachment(ws);
    if (!host?.hostId) return;
    const t = gatewayTelemetry(this.deps.env, { base: { ...this.org(), host_id: host.hostId } });
    t.emit("host.disconnected", {
      ...(host.connectedAt ? { duration_ms: Date.now() - host.connectedAt } : {}),
      data: { ...(host.version ? { host_version: host.version } : {}), close_code: code },
    });
    this.send(t);
  }

  /**
   * The `welcome` field carrying a fresh signed telemetry credential for this
   * host (decision 13), valid 90 days, renewed on every hello. Its
   * organization is the one the host's token is bound to (this object's
   * accountId); pool computers and a gateway without TELEMETRY_SIGNING_KEY
   * get none. Never throws.
   */
  async credential(hostId: string): Promise<{ telemetryCredential?: string; telemetryUrl?: string }> {
    const orgId = this.org().org_id;
    const key = this.deps.env.TELEMETRY_SIGNING_KEY?.trim();
    if (!key || !orgId || !credentialId(orgId) || !credentialId(hostId)) return {};
    try {
      const url = this.deps.env.TELEMETRY_COLLECTOR_URL?.trim();
      return { telemetryCredential: await issueTelemetryCredential(key, { orgId, hostId }), ...(url ? { telemetryUrl: url } : {}) };
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "computer.telemetry_credential_failed", message: error instanceof Error ? error.message : "unknown" }));
      return {};
    }
  }

  // ---------------------------------------------------------------- fields

  /** The organization, for an object bound to one (pool computers are not organizations). */
  private org(): Dimensions {
    const accountId = this.deps.accountId();
    return accountId && !isPoolId(accountId) ? { org_id: accountId } : {};
  }

  private host(): Dimensions {
    const socket = this.deps.socket();
    const hostId = socket ? attachment(socket)?.hostId : undefined;
    return hostId ? { host_id: hostId } : {};
  }

  /** One dispatch's fields, per event: one invocation's batch can carry several dispatches. */
  private dispatchFields(id: string, key: string, dispatch: TracedDispatch): Dimensions & { synthetic?: boolean } {
    return {
      ...traceFields(dispatch.trace),
      session_key: key,
      dispatch_id: id,
      ...this.host(),
      ...(dispatch.trace?.synthetic ? { synthetic: true } : {}),
    };
  }
}

function attachment(socket: WebSocket): HostAttachment | null {
  try {
    return socket.deserializeAttachment() as HostAttachment | null;
  } catch {
    return null;
  }
}
