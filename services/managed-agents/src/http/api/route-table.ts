// The API's routes (work 084, spec 37): `METHOD /suffix` to a route, the scope each needs, and which the actors serve.

import { matchMutation } from "../../actors/org/contract.js";
import type { ApiScope } from "../../api-objects/objects.js";
import { isId, isSessionId } from "../../ids/session-ids.js";

export interface Route {
  op: string;
  sessionId?: string;
  sub?: string;
  /** `mutate`: the mutation (spec 39) and its arguments from the path. */
  name?: string;
  args?: Record<string, string>;
}

/** The work routes of tracks and threads (spec 37.1, 37.3): a mutation's, from the table, or a read. */
function workRoute(method: string, s: string[]): Route | null {
  const mutation = matchMutation(method, `/work/${s.join("/")}`);
  // A merge and its revert are GitHub's first: the edge's, not Org's alone (result-merge.ts).
  if (mutation?.name === "result.merge" || mutation?.name === "result.revert") return { op: mutation.name === "result.merge" ? "work.merge" : "work.revert", sub: mutation.args.resultId! };
  if (mutation) return { op: "mutate", ...mutation };
  const [a, b, c, d] = s;
  const n = s.length;
  const is = (verb: string, length: number) => method === verb && n === length;
  switch (a) {
    case "threads":
      if (is("GET", 1)) return { op: "work.threads" };
      if (is("GET", 2)) return { op: "work.thread", args: { sid: b! } };
      return null;
    case "tracks":
      if (is("GET", 3) && c === "doc") return { op: "work.doc", sub: b! };
      if (method === "GET" && c === "doc" && d === "revisions" && (n === 4 || n === 5)) return { op: "work.doc.revisions", sub: b!, ...(n === 5 ? { args: { rev: s[4]! } } : {}) };
      return null;
    case "tell-track":
      return is("POST", 1) ? { op: "work.tell" } : null;
    case "results":
      if (is("GET", 3) && c === "diff") return { op: "work.diff", sub: b! };
      if (is("GET", 3) && c === "review") return { op: "work.review", sub: b! };
      if (is("GET", 3) && c === "file") return { op: "work.file", sub: b! };
      return null;
    case "overview":
      return is("GET", 1) ? { op: "work.overview" } : null;
    case "search":
      return is("GET", 1) ? { op: "work.search" } : null;
    default:
      return null;
  }
}

/** A path id's shape, by its argument's name: a malformed one is `not_found`. */
export const PATH_ID: Record<string, (value: string) => boolean> = {
  sid: isSessionId,
  tid: (v) => isId("trk", v),
  resultId: (v) => isId("res", v),
  proposalId: (v) => isId("prp", v),
  opId: (v) => isId("op", v),
  key: (v) => /^[A-Za-z0-9_.:-]{1,64}$/.test(v),
  rev: (v) => /^(0|[1-9]\d{0,8})$/.test(v),
};

/** `METHOD /suffix` → the route; null when it is not one of the API's. */
export function matchApiRoute(method: string, suffix: string): Route | null {
  const p = suffix.split("/").filter(Boolean);
  const is = (m: string, n: number) => method === m && p.length === n;
  if (is("GET", 1) && p[0] === "me") return { op: "me" };
  // The organization's settings for sessions (sessions.mdx#organization-default): Org's.
  if (p[0] === "settings" && p.length === 1 && (method === "GET" || method === "PATCH")) return { op: method === "GET" ? "settings.get" : "settings.patch" };
  if (is("POST", 1) && p[0] === "tickets") return { op: "ticket" };
  // Secret writes: organization and session layers; personal secrets remain unavailable over HTTP.
  if (is("GET", 1) && p[0] === "secrets") return { op: "secrets.list" };
  if (is("GET", 3) && p[0] === "secrets" && p[2] === "events") return { op: "secrets.events", sub: p[1] };
  if (p[0] === "organization" && p[1] === "secrets" && p.length === 3 && (method === "PUT" || method === "DELETE")) {
    return { op: method === "PUT" ? "secrets.put" : "secrets.delete", sub: p[2] };
  }
  if (p[0] === "me" && p[1] === "secrets" && p.length === 3 && (method === "PUT" || method === "DELETE")) return { op: "secrets" };
  // The same for every session, so the new-session screen can read it before there is one.
  if (is("GET", 1) && p[0] === "capabilities") return { op: "capabilities" };
  if (is("GET", 1) && p[0] === "feed") return { op: "feed" };
  if (is("GET", 1) && p[0] === "occurrences") return { op: "occurrences" };
  if (is("GET", 1) && p[0] === "live") return { op: "live" };
  if (is("POST", 4) && p[0] === "slack" && p[1] === "threads" && p[3] === "messages") return { op: "slack.post", sub: p[2] };
  // The Work API (spec 37): tracks and threads, and the knowledge repository setting, all Org's.
  if (p[0] === "work") {
    const tracked = workRoute(method, p.slice(1));
    if (tracked) return tracked;
    if (p[1] === "repository" && p.length === 2) return method === "GET" ? { op: "work.repository.get" } : method === "PUT" ? { op: "work.repository.put" } : null;
    if (p[1] === "repositories") return is("GET", 2) ? { op: "work.repositories" } : null;
    return null;
  }
  if (p[0] !== "sessions") return null;
  if (p.length === 1) return method === "GET" ? { op: "list" } : method === "POST" ? { op: "create" } : null;
  const sessionId = p[1]!;
  if (is("GET", 2)) return { op: "get", sessionId };
  if (is("PATCH", 2)) return { op: "patch", sessionId };
  const r = p[2];
  if (is("GET", 3) && r === "capabilities") return { op: "capabilities", sessionId };
  // Set aside (work-tracking 3.8): the Computer DO's own column, never the writer.
  if (is("PUT", 3) && r === "aside") return { op: "aside.set", sessionId };
  if (is("DELETE", 3) && r === "aside") return { op: "aside.clear", sessionId };
  if (is("POST", 3) && (r === "interrupt" || r === "compact" || r === "suspend" || r === "resume")) return { op: `sessions.${r}`, sessionId };
  if (r === "turns") {
    if (is("POST", 3)) return { op: "turns.send", sessionId };
    if (is("GET", 3)) return { op: "turns.list", sessionId };
    if (is("GET", 4)) return { op: "turns.get", sessionId, sub: p[3] };
    if (is("POST", 5) && p[4] === "cancel") return { op: "turns.cancel", sessionId, sub: p[3] };
  }
  if (is("GET", 3) && r === "events") return { op: "events.list", sessionId };
  if (r === "asks") {
    if (is("GET", 3)) return { op: "asks.list", sessionId };
    if (is("GET", 4)) return { op: "asks.get", sessionId, sub: p[3] };
    if (is("POST", 5) && (p[4] === "answer" || p[4] === "dismiss")) return { op: `asks.${p[4]}`, sessionId, sub: p[3] };
  }
  if (r === "subagents") {
    if (is("GET", 3)) return { op: "subagents.list", sessionId };
    if (is("GET", 4)) return { op: "subagents.get", sessionId, sub: p[3] };
    if (is("POST", 5) && p[4] === "stop") return { op: "subagents.stop", sessionId, sub: p[3] };
  }
  if (r === "secrets" && is("GET", 3)) return { op: "secrets.session.list", sessionId };
  if (r === "secrets" && is("PUT", 4)) return { op: "secrets.session.put", sessionId, sub: p[3] };
  if (r === "secrets" && is("DELETE", 4)) return { op: "secrets.session.delete", sessionId, sub: p[3] };
  return null;
}

/** The scope a route needs. */
export function scopeOf(op: string): ApiScope | null {
  if (op === "me" || op === "ticket" || op === "settings.get") return null;
  if (op === "asks.answer" || op === "asks.dismiss") return "asks:answer";
  if (op === "secrets" || op === "secrets.put" || op === "secrets.delete" || op === "secrets.session.put" || op === "secrets.session.delete") return "secrets:write";
  if (op === "secrets.events" || op === "secrets.session.list") return "sessions:read";
  if (op === "work.repository.put" || op === "mutate" || op === "work.tell" || op === "work.merge" || op === "work.revert") return "work:write";
  if (op === "live") return "sessions:read";
  if (op === "feed" || op === "occurrences") return "sessions:read";
  if (op.startsWith("work.")) return "work:read";
  if (op === "list" || op === "get" || op === "capabilities" || op.endsWith(".list") || op.endsWith(".get")) return "sessions:read";
  return "sessions:write";
}

/** The routes served by the actors of tracks and threads, not the Computer object. */
export const ACTOR_OPS = new Set([
  "list", "create", "get", "patch", "aside.set", "aside.clear",
  "turns.send", "asks.answer", "asks.dismiss", "sessions.interrupt",
  "sessions.compact", "sessions.suspend", "sessions.resume", "turns.cancel", "subagents.stop",
  "events.list", "turns.list", "turns.get", "asks.list", "asks.get", "subagents.list", "subagents.get",
  "feed", "occurrences", "mutate",
  "work.threads", "work.thread", "work.overview", "work.doc", "work.doc.revisions", "work.review", "work.search", "work.repository.get", "work.repository.put", "work.repositories",
  "live", "work.tell", "work.diff", "work.merge", "work.revert", "work.file", "slack.post", "settings.get", "settings.patch",
]);
