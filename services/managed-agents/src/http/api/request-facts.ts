// What one request's `httpapi.request` reports (work 084 instrumentation, Q3/Q4): its route family and op,
// status, error code, the time awaiting actors, and the events an events read delivered. Never a path, query, body or key.

import type { RequestIdentity } from "../../edge/auth.js";
import { isSessionId } from "../../ids/session-ids.js";
import { gatewayTelemetry, type TelemetryEnv } from "../../telemetry/gateway.js";
import type { ComputerApiStub } from "./dispatch.js";
import type { Reply } from "./reply.js";

/** What one request's `httpapi.request` reports, filled on the way. */
export interface RequestFacts {
  op: string;
  via?: string;
  member?: string;
  sessionId?: string;
  /** Time awaiting the Computer DO / the SessionLog, ms. */
  doMs: number;
  logMs: number;
  /** events.list: events returned, and now − createdAt of the first and last. */
  events?: number;
  oldestAgeMs?: number;
  newestAgeMs?: number;
  replayed?: boolean;
  errorCode?: string;
}

/** The closed route families of `httpapi.request` and `edge.request` (the catalog's list). */
export function routeFamily(op: string): string {
  if (op === "list" || op === "create" || op === "get" || op === "patch" || op === "capabilities" || op.startsWith("aside.")) return "sessions";
  if (op.startsWith("sessions.")) return "control";
  if (op === "events.list") return "events";
  if (op.startsWith("turns.")) return "turns";
  if (op.startsWith("asks.")) return "asks";
  if (op.startsWith("subagents.")) return "subagents";
  if (op === "ticket") return "tickets";
  if (op === "secrets" || op.startsWith("secrets.")) return "secrets";
  if (op.startsWith("work.") || op === "mutate") return "work";
  if (op === "feed" || op === "occurrences" || op === "live") return "feed";
  return "other";
}

const OPS = new Set([
  "me", "ticket", "settings.get", "settings.patch", "secrets", "secrets.list", "secrets.events", "secrets.put", "secrets.delete", "secrets.session.put", "secrets.session.list", "secrets.session.delete", "list", "create", "get", "patch", "capabilities",
  "aside.set", "aside.clear",
  "sessions.interrupt", "sessions.compact", "sessions.suspend", "sessions.resume",
  "turns.send", "turns.list", "turns.get", "turns.cancel", "events.list",
  "asks.list", "asks.get", "asks.answer", "asks.dismiss", "subagents.list", "subagents.get", "subagents.stop",
  "work.repository.get", "work.repository.put", "work.repositories",
  "feed", "occurrences", "mutate", "work.threads", "work.thread", "work.overview", "work.doc", "work.doc.revisions", "work.review", "work.search",
]);

/** The request's one `httpapi.request`; never throws, never awaited. */
export function requestFact(env: TelemetryEnv, identity: RequestIdentity, method: string, out: Reply, status: number, waitUntil: ((p: Promise<unknown>) => void) | undefined): void {
  try {
    const f = out.facts;
    const ms = Math.round(performance.now() - out.started);
    const t = gatewayTelemetry(env, { base: { org_id: identity.accountId } });
    const op = OPS.has(f.op) ? f.op : "other";
    const code = f.errorCode && /^[a-z][a-z0-9_]{0,63}$/.test(f.errorCode) ? f.errorCode : f.errorCode ? "other" : undefined;
    t.emit("httpapi.request", {
      surface: f.via === "opc" ? "cli" : "api",
      ...(f.sessionId && isSessionId(f.sessionId) ? { session_key: f.sessionId } : {}),
      ...(f.member ? { person_id: f.member } : {}),
      duration_ms: ms,
      outcome: status < 400 ? "completed" : "failed",
      ...(code ? { error_type: "unknown" as const, error_code: code } : {}),
      data: {
        route: routeFamily(op),
        op,
        method: ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method) ? method : "other",
        status,
        do_ms: Math.round(f.doMs),
        log_ms: Math.round(f.logMs),
        ...(f.events !== undefined ? { events: f.events, empty: f.events === 0 } : {}),
        ...(f.oldestAgeMs !== undefined ? { oldest_age_ms: f.oldestAgeMs } : {}),
        ...(f.newestAgeMs !== undefined ? { newest_age_ms: f.newestAgeMs } : {}),
        ...(f.replayed ? { replayed: true } : {}),
      },
    });
    const done = t.done();
    if (waitUntil) waitUntil(done);
  } catch {
    // Telemetry never fails the request.
  }
}

/** The DO stub, timed into the request's facts. */
export function timedStub(computer: ComputerApiStub, facts: RequestFacts): ComputerApiStub {
  return {
    async computerApi(accountId, caller, op) {
      const began = performance.now();
      try {
        return await computer.computerApi(accountId, caller, op);
      } finally {
        facts.doMs += performance.now() - began;
      }
    },
  };
}

/** A SessionLog read, timed into the request's facts. */
export async function timedLog<T>(facts: RequestFacts, read: Promise<T>): Promise<T> {
  const began = performance.now();
  try {
    return await read;
  } finally {
    facts.logMs += performance.now() - began;
  }
}

/** events.list's delivered events and their age (now − createdAt), for `httpapi.request`. */
export function delivered(facts: RequestFacts, events: ReadonlyArray<{ createdAt: string }>): void {
  facts.events = events.length;
  if (!events.length) return;
  const now = Date.now();
  const age = (at: string) => {
    const t = Date.parse(at);
    return Number.isFinite(t) ? Math.max(0, Math.round(now - t)) : undefined;
  };
  const oldest = age(events[0]!.createdAt);
  const newest = age(events[events.length - 1]!.createdAt);
  if (oldest !== undefined) facts.oldestAgeMs = oldest;
  if (newest !== undefined) facts.newestAgeMs = newest;
}

/** Time awaiting an actor other than the SessionLog, into the request's facts. */
export async function timedDo<T>(facts: RequestFacts, call: Promise<T>): Promise<T> {
  const began = performance.now();
  try {
    return await call;
  } finally {
    facts.doMs += performance.now() - began;
  }
}
