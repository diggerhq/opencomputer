// The routes of spec 37 served by the actors of tracks and threads: the session directory is Org's, the
// writes go through the session's inbox, and the log's reads go straight to its SessionLog, all as the
// caller's principal (spec 34.3).

import { logOf, orgOf } from "../../actors/addresses.js";
import type { CreateSession, OrgSettings, SessionRow } from "../../actors/org/contract.js";
import type { LogSummary, TurnStatus } from "../../api-objects/objects.js";
import type { Principal } from "../../auth/principal.js";
import { cursor } from "../../durable/cursor.js";
import { firstTurnId, isSessionId, mintId } from "../../ids/session-ids.js";
import { slackPost, tellTrack } from "./agent-posts.js";
import { liveUpgrade } from "./live-upgrade.js";
import { logRefusalOf, refusalOf, strip, type LogRefused, type Reply } from "./reply.js";
import { asObject, bodyOf, intParam } from "./request-body.js";
import { delivered, timedDo, timedLog } from "./request-facts.js";
import { resultDiff, type ResultDiffEnv } from "./result-diff.js";
import { resultFile } from "./result-file.js";
import type { Route } from "./route-table.js";
import { entryId, sendEntry } from "./session-entry.js";
import { attachmentRoute, type AttachmentsEnv } from "./attachment-routes.js";
import { checkAttachments, createInput, listQuery, writeParams } from "./session-input.js";
import { patchSession } from "./session-patch.js";
import { orgRoute } from "./work-routes.js";

const ID = /^[a-z]{2,4}_[0-9a-z]{4,40}$/;
const ASK_STATUSES = new Set(["open", "answered", "dismissed", "declined", "interrupted", "all"]);

const TRACE = /^[\x21-\x7e]{1,64}$/;
const ENTRY_KINDS = {
  "turns.send": "turn", "asks.answer": "answer", "asks.dismiss": "dismiss", "sessions.interrupt": "interrupt",
  "sessions.compact": "compact", "sessions.suspend": "suspend", "sessions.resume": "resume", "turns.cancel": "cancel", "subagents.stop": "stop",
} as const;

/** The session row with the log's newer summary laid over it (`GET /sessions/{id}`). */
function withSummary(session: SessionRow, summary: LogSummary | null): SessionRow {
  if (!summary || summary.lastSeq < session.lastSeq) return session;
  return {
    ...session,
    ...(summary.status && session.status !== "suspended" ? { status: summary.status } : {}),
    ...(summary.settings ? { settings: summary.settings } : {}),
    activeTurnId: summary.activeTurnId,
    queued: summary.queued,
    asks: summary.asks,
    subagents: summary.subagents,
    lastTurn: summary.lastTurn,
    lastText: summary.lastText,
    context: summary.context,
    lastSeq: summary.lastSeq,
    ...(summary.lastActiveAt ? { lastActiveAt: summary.lastActiveAt } : {}),
    syncedAt: summary.syncedAt,
  };
}

/** A route of spec 37 served by the actors, as the principal; `routeApi` checked its scope and Idempotency-Key. */
export async function actorRoute(request: Request, env: ResultDiffEnv & AttachmentsEnv, p: Principal, person: CreateSession["person"], route: Route, idem: string | undefined, out: Reply): Promise<Response> {
  const rawTrace = request.headers.get("x-oc-trace");
  const trace = rawTrace && TRACE.test(rawTrace) ? rawTrace : undefined;
  const query = new URL(request.url).searchParams;
  const org = () => orgOf(env, p.org);
  /**
   * A turn's attachments (work 126): reserved in Org before the accept (`attached`), released when the
   * accept refuses. A failed release leaves them `attached` to a turn that never was: the sweep does
   * not touch those while the session exists, so a client sees `attachment_in_use` until it re-uploads.
   */
  const reserve = async (sessionId: string, turnId: string, messageId: string | null, ids: string[]) => timedDo(out.facts, org().attachmentReserve(p, sessionId, turnId, messageId, ids));
  const release = (sessionId: string, turnId: string, ids: string[]) => timedDo(out.facts, org().attachmentRelease(sessionId, turnId, ids)).catch(() => undefined);

  if (route.op === "list") {
    const q = listQuery(query);
    if ("error" in q) return out.error(400, "invalid_request", q.error, { field: q.field });
    const r = await timedDo(out.facts, org().listSessions(p, q));
    return r.ok ? out.send(200, strip(r)) : refusalOf(out, r);
  }

  if (route.op === "create") {
    const parsed = await bodyOf(request);
    if ("error" in parsed) return out.error(...parsed.error);
    const input = createInput(parsed.value);
    if ("error" in input) return out.error(...input.error);
    const create = input.value;
    if (create.role && p.kind !== "member") return out.error(403, "forbidden", "Only a member starts a session with a role.", { reason: "members_only" });
    // An Idempotency-Key without an id is hashed into the id, so a retry is the same create.
    // With attachments the id is made here: the reserve names the session and its first turn before Org holds them.
    const id = create.id ?? (idem ? await entryId("cs", 16, ["create", p.org, p.subject, idem]) : input.attachments ? mintId("cs") : undefined);
    const turnId = create.turnId ?? firstTurnId(id ?? "");
    let attachments: { id: string; name: string; mimetype: string; bytes: number }[] | undefined;
    if (input.attachments) {
      const reserved = await reserve(id!, turnId, null, input.attachments);
      if (!reserved.ok) return refusalOf(out, reserved);
      attachments = reserved.attachments;
    }
    const made = await timedDo(out.facts, org().createSession(p, {
      ...create,
      ...(id ? { id } : {}),
      ...(person ? { person } : {}),
      ...(trace ? { trace } : {}),
      ...(attachments ? { attachments } : {}),
      ...(p.kind === "agent" && p.session ? { parent: p.session } : {}),
    }));
    if (!made.ok) {
      if (input.attachments) await release(id!, turnId, input.attachments);
      return refusalOf(out, made);
    }
    const session = made.session;
    out.facts.sessionId = session.id;
    if (made.duplicate) out.facts.replayed = true;
    if (create.input === undefined) {
      return out.send(made.duplicate ? 200 : 201, { session, turn: null, delivery: null, duplicate: made.duplicate, seq: session.lastSeq });
    }
    // Org owed the first turn with the session; accepting it again (the same id and body, so a duplicate) waits for it.
    const sent = await sendEntry(env, p, session.id, { id: create.turnId ?? firstTurnId(session.id), kind: "turn", body: { input: create.input, ifBusy: "queue", ...(attachments ? { attachments } : {}) } }, trace, out);
    if ("response" in sent) {
      if (input.attachments) await release(session.id, turnId, input.attachments);
      return sent.response;
    }
    if ("waking" in sent) return out.send(202, { accepted: true, id: create.turnId ?? firstTurnId(session.id), session });
    const result = (asObject(sent.delivered) ?? {}) as { turn?: unknown; delivery?: unknown; seq?: number; duplicate?: boolean };
    const duplicate = made.duplicate && result.duplicate !== false;
    return out.send(duplicate ? 200 : 201, { session, turn: result.turn ?? null, delivery: result.delivery ?? null, duplicate, seq: result.seq ?? session.lastSeq });
  }

  switch (route.op) {
    case "live":
      return liveUpgrade(request, env, p, out);
    case "work.tell":
      return tellTrack(request, env, p, idem, trace, org, out);
    case "work.diff":
      return resultDiff(request, env, p, route.sub!, org, out);
    case "work.file":
      return resultFile(request, env, p, route.sub!, org, out);
    case "slack.post":
      return slackPost(request, env, p, route.sub!, out);
    case "settings.get":
      return out.send(200, { settings: await timedDo(out.facts, org().settings(p)) });
    case "settings.patch": {
      const parsed = await bodyOf(request);
      if ("error" in parsed) return out.error(...parsed.error);
      const r = await timedDo(out.facts, org().setSettings(p, parsed.value as Partial<OrgSettings>));
      return r.ok ? out.send(200, { settings: r.settings }) : refusalOf(out, r);
    }
  }
  if (!route.sessionId) return orgRoute(request, p, person, route, query, idem, trace, org, out);

  const sessionId = route.sessionId;
  if (!isSessionId(sessionId)) return out.error(404, "session_not_found", "No such session.");
  if (route.sub !== undefined && !ID.test(route.sub)) {
    const what = route.op.split(".")[0]!.replace(/s$/, "");
    return out.error(404, `${what}_not_found`, `No such ${what}.`);
  }
  const minSeq = intParam(query, "minSeq", 0, Number.MAX_SAFE_INTEGER);
  if (minSeq === null) return out.error(400, "invalid_request", "minSeq must be a non-negative integer.", { field: "minSeq" });

  if (route.op === "get") {
    const [got, summary] = await Promise.all([
      timedDo(out.facts, org().getSession(p, sessionId)),
      timedLog(out.facts, logOf(env, sessionId).summary(minSeq, p)).catch(() => null),
    ]);
    if (!got.ok) return refusalOf(out, got);
    // With minSeq the log has not reached: 503 with retryAfterMs, as every read (spec 37.1).
    if (summary && !summary.ok && summary.error === "unavailable") return logRefusalOf(out, summary);
    return out.send(200, { session: withSummary(got.session, summary?.ok ? summary.summary : null) });
  }

  if (route.op === "patch") return patchSession(request, env, p, sessionId, idem, trace, org, out);
  if (route.op === "aside.set" || route.op === "aside.clear") {
    let aside: string | null = null;
    if (route.op === "aside.set") {
      const parsed = await bodyOf(request);
      if ("error" in parsed) return out.error(...parsed.error);
      const ref = asObject(parsed.value)?.ref;
      if (typeof ref !== "string" || !/^[\x21-\x7e]{1,255}$/.test(ref)) return out.error(400, "invalid_request", "ref is the id of what is set aside: 1 to 255 printable characters.", { field: "ref" });
      aside = ref;
    }
    const r = await timedDo(out.facts, org().patchSession(p, sessionId, { aside }));
    return r.ok ? out.send(200, { session: r.session }) : refusalOf(out, r);
  }

  // Attachments (work 126): Org's rows and the object store.
  if (route.op.startsWith("attachments.")) return attachmentRoute(request, env, p, route, org, out);

  // Every write, through the session's inbox (spec 37.2, 40.2).
  if (route.op in ENTRY_KINDS) {
    const op = route.op as keyof typeof ENTRY_KINDS;
    const parsed = await bodyOf(request);
    if ("error" in parsed) return out.error(...parsed.error);
    const input = asObject(parsed.value);
    if (!input) return out.error(400, "invalid_request", "The body must be a JSON object.", { field: "" });
    const params = writeParams(route, input);
    if ("error" in params) return out.error(400, params.code ?? "invalid_request", params.error, { field: params.field });
    const { id: askedId, attachments: askedAttachments, ...body } = params.value;
    const kind = ENTRY_KINDS[op];
    const [prefix, length] = kind === "turn" ? ["tn", 12] as const : ["ie", 16] as const;
    const id = typeof askedId === "string" ? askedId : await entryId(prefix, length, idem ? [kind, p.org, p.subject, sessionId, idem] : undefined);
    // A turn's attachments: reserved (`attached` to this turn) before the accept; what it carries replaces the ids.
    // A steer's message is its own (doc 126: `attachedTo` names the turn and the message): the entry's id names it.
    const ids = kind === "turn" ? checkAttachments(askedAttachments) : undefined;
    if (ids && "ids" in ids) {
      const reserved = await reserve(sessionId, id, body.ifBusy === "steer" ? id : null, ids.ids);
      if (!reserved.ok) return refusalOf(out, reserved);
      body.attachments = reserved.attachments;
    }
    const sent = await sendEntry(env, p, sessionId, { id, kind, body }, trace, out);
    if ("response" in sent) {
      if (ids && "ids" in ids) await release(sessionId, id, ids.ids);
      return sent.response;
    }
    if ("waking" in sent) return out.send(202, { accepted: true, id });
    return out.send(200, sent.delivered);
  }

  // The session's reads: straight to its SessionLog as the principal, which checks access.
  const log = logOf(env, sessionId);
  const limit = (max: number) => intParam(query, "limit", 1, max);
  const pageCursor = query.get("cursor") ?? undefined;
  const answer = (r: { ok: true; [field: string]: unknown } | LogRefused, pick?: string) => (r.ok ? out.send(200, pick ? { [pick]: r[pick] } : strip(r)) : logRefusalOf(out, r));
  switch (route.op) {
    case "events.list": {
      const after = query.get("after") ?? undefined;
      // A cursor the module cannot read (a bare seq of the old API included) is reset with no cursor.
      if (after !== undefined && !cursor.read("e", after)) return out.error(409, "reset", "after is not a cursor of this session's events.", { cursor: null });
      const lim = limit(500);
      const tailTurns = intParam(query, "tailTurns", 1, 50);
      for (const [name, v] of [["limit", lim], ["tailTurns", tailTurns]] as const) {
        if (v === null) return out.error(400, "invalid_request", `${name} is out of range.`, { field: name });
      }
      if (tailTurns !== undefined && after !== undefined) return out.error(400, "invalid_request", "tailTurns cannot be sent with after.", { field: "tailTurns" });
      const types = query.get("types")?.split(",").filter(Boolean);
      const turnId = query.get("turnId") ?? undefined;
      const q = {
        ...(after !== undefined ? { after } : {}),
        ...(typeof lim === "number" ? { limit: lim } : {}),
        ...(typeof tailTurns === "number" ? { tailTurns } : {}),
        ...(types?.length ? { types } : {}),
        ...(turnId ? { turnId } : {}),
        ...(minSeq !== undefined ? { minSeq } : {}),
      };
      const r = await timedLog(out.facts, log.events(q, p));
      if (r.ok) delivered(out.facts, r.events);
      return answer(r);
    }
    case "turns.list": {
      const lim = limit(100);
      if (lim === null) return out.error(400, "invalid_request", "limit is 1 to 100.", { field: "limit" });
      const status = query.get("status")?.split(",").filter(Boolean);
      return answer(await timedLog(out.facts, log.turns({ ...(lim !== undefined ? { limit: lim } : {}), ...(pageCursor ? { cursor: pageCursor } : {}), ...(status ? { status: status as TurnStatus[] } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }, p)));
    }
    case "turns.get":
      return answer(await timedLog(out.facts, log.turn(route.sub!, { ...(minSeq !== undefined ? { minSeq } : {}) }, p)), "turn");
    case "asks.list": {
      const lim = limit(100);
      if (lim === null) return out.error(400, "invalid_request", "limit is 1 to 100.", { field: "limit" });
      const status = query.get("status") ?? "open";
      if (!ASK_STATUSES.has(status)) return out.error(400, "invalid_request", "status is open, answered, dismissed, declined, interrupted or all.", { field: "status" });
      return answer(await timedLog(out.facts, log.asks({ status, ...(lim !== undefined ? { limit: lim } : {}), ...(pageCursor ? { cursor: pageCursor } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }, p)));
    }
    case "asks.get":
      return answer(await timedLog(out.facts, log.ask(route.sub!, minSeq, p)), "ask");
    case "subagents.list": {
      const lim = limit(100);
      if (lim === null) return out.error(400, "invalid_request", "limit is 1 to 100.", { field: "limit" });
      const status = query.get("status") ?? "running";
      if (status !== "running" && status !== "all") return out.error(400, "invalid_request", "status is running or all.", { field: "status" });
      return answer(await timedLog(out.facts, log.subagents({ status, ...(lim !== undefined ? { limit: lim } : {}), ...(pageCursor ? { cursor: pageCursor } : {}), ...(minSeq !== undefined ? { minSeq } : {}) }, p)));
    }
    case "subagents.get":
      return answer(await timedLog(out.facts, log.subagent(route.sub!, minSeq, p)), "subagent");
    default:
      return out.error(404, "not_found", "No such route.");
  }
}
