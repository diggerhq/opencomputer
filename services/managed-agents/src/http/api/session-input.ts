// The bodies and queries of the session routes, checked before an actor is asked: `POST /sessions`,
// `GET /sessions` and the inbox writes.

import type { CreateSession, ListQuery } from "../../actors/org/contract.js";
import { checkSettings, PLAN_EXIT_MODES } from "../../api-objects/capabilities.js";
import { isId, isSessionId } from "../../ids/session-ids.js";
import { asObject, intParam } from "./request-body.js";
import type { Route } from "./route-table.js";

export type Params = { value: Record<string, unknown> } | { error: string; field: string; code?: string };

/** Attachments per message (work 126, section 8): the edge's constant; the SDK holds its own. */
export const ATTACHMENTS_PER_MESSAGE_MAX = 10;

/**
 * A turn's `attachments`: at most ATTACHMENTS_PER_MESSAGE_MAX distinct `at_` ids. Undefined when
 * absent (or empty: nothing to reserve); the error otherwise.
 */
export function checkAttachments(value: unknown): { error: string; field: string } | { ids: string[] } | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > ATTACHMENTS_PER_MESSAGE_MAX || value.some((id) => !isId("at", id))) {
    return { error: `attachments is at most ${ATTACHMENTS_PER_MESSAGE_MAX} attachment ids (at_ and 16 lowercase Crockford base32 characters).`, field: "attachments" };
  }
  if (new Set(value).size !== value.length) return { error: "attachments names an attachment twice.", field: "attachments" };
  return value.length ? { ids: value as string[] } : undefined;
}

/** A write's body as the method's params; unknown fields are refused (the writer decodes strictly too). */
export function writeParams(route: Route, body: Record<string, unknown>): Params {
  const allow = (...fields: string[]): Params => {
    const bad = Object.keys(body).find((k) => !fields.includes(k));
    return bad ? { error: `Unknown field ${bad}.`, field: bad } : { value: { ...body } };
  };
  switch (route.op) {
    case "turns.send": {
      const attachments = checkAttachments(body.attachments);
      if (attachments && "error" in attachments) return attachments;
      // With attachments the text may be empty (a file alone is a message, work 126).
      if (typeof body.input !== "string" || body.input.length < (attachments ? 0 : 1) || body.input.length > 100_000) {
        return { error: attachments ? "input must be a string of at most 100,000 characters." : "input must be a string of 1 to 100,000 characters.", field: "input" };
      }
      if (body.ifBusy !== undefined && body.ifBusy !== "queue" && body.ifBusy !== "steer" && body.ifBusy !== "interrupt") {
        return { error: "ifBusy is queue, steer or interrupt.", field: "ifBusy" };
      }
      // `turnId` is `id` under the name `POST /sessions` gives it; either way it becomes the turn's id.
      for (const field of ["id", "turnId"] as const) {
        if (body[field] !== undefined && !isId("tn", body[field])) return { error: `${field} must be tn_ and 12 lowercase Crockford base32 characters.`, field };
      }
      if (body.id !== undefined && body.turnId !== undefined && body.id !== body.turnId) return { error: "id and turnId name the same turn: send one.", field: "turnId" };
      const { turnId, ...rest } = body;
      const named = allow("id", "input", "ifBusy", "turnId", "attachments");
      return "error" in named || turnId === undefined ? named : { value: { ...rest, id: turnId } };
    }
    case "turns.cancel":
      return Object.keys(body).length ? { error: `Unknown field ${Object.keys(body)[0]}.`, field: Object.keys(body)[0]! } : { value: { turnId: route.sub } };
    case "sessions.interrupt":
      return allow("turnId");
    case "sessions.compact":
      return allow("instructions");
    case "sessions.suspend":
      return allow("ifIdle");
    case "sessions.resume":
      return allow();
    case "asks.answer": {
      // calvin's rule (asks.ts PLAN_EXIT_MODES): `mode` only with allow, one of the plan-exit modes.
      if (body.mode !== undefined) {
        if (body.decision !== "allow" || typeof body.mode !== "string" || !PLAN_EXIT_MODES.includes(body.mode)) {
          return { error: `mode is one of ${PLAN_EXIT_MODES.join(", ")}, sent only with decision allow.`, field: "mode", code: "invalid_answer" };
        }
      }
      return { value: { askId: route.sub, answer: body } };
    }
    case "asks.dismiss": {
      const r = allow("message");
      if ("value" in r && r.value.message !== undefined && (typeof r.value.message !== "string" || r.value.message.length > 2000)) {
        return { error: "message is at most 2,000 characters.", field: "message" };
      }
      return "value" in r ? { value: { askId: route.sub, ...r.value } } : r;
    }
    case "subagents.stop":
      return Object.keys(body).length ? { error: `Unknown field ${Object.keys(body)[0]}.`, field: Object.keys(body)[0]! } : { value: { subagentId: route.sub } };
    default:
      return { error: "Not a write.", field: "" };
  }
}

/** `POST /sessions`'s body. `parent`, `writers`, `slackThread`, `origin` and `harness` are the actors' own, never a request's. */
export function createInput(body: unknown): { value: CreateSession; attachments?: string[] } | { error: [number, string, string, Record<string, unknown>] } {
  const input = asObject(body);
  const bad = (field: string, message: string) => ({ error: [400, "invalid_request", message, { field }] as [number, string, string, Record<string, unknown>] });
  if (!input) return bad("", "The body must be a JSON object.");
  const fields = new Set(["id", "input", "turnId", "title", "model", "effort", "mode", "speed", "metadata", "trackId", "role", "access", "attachments"]);
  for (const field of Object.keys(input)) if (!fields.has(field)) return bad(field, `Unknown field ${field}.`);
  // The first turn's attachments (work 126): ids the route reserves before the create; with them `input` may be empty.
  const attachments = checkAttachments(input.attachments);
  if (attachments && "error" in attachments) return bad(attachments.field, attachments.error);
  if (attachments && typeof input.input !== "string") return bad("attachments", "attachments is sent with input.");
  const value: CreateSession = {};
  if (input.id !== undefined) {
    if (!isSessionId(input.id)) return bad("id", "id must be cs_ and 16 lowercase Crockford base32 characters.");
    value.id = input.id;
  }
  if (input.turnId !== undefined) {
    if (!isId("tn", input.turnId)) return bad("turnId", "turnId must be tn_ and 12 lowercase Crockford base32 characters.");
    if (input.input === undefined) return bad("turnId", "turnId is sent only with input.");
    value.turnId = input.turnId;
  }
  for (const [field, min, max] of [["input", attachments ? 0 : 1, 100_000], ["title", 0, 200], ["model", 1, 200], ["effort", 1, 50], ["mode", 1, 50]] as const) {
    const v = input[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length < min || v.length > max) return bad(field, `${field} must be a string of ${min} to ${max} characters.`);
    value[field] = v;
  }
  if (input.speed !== undefined) {
    if (input.speed !== "fast" && input.speed !== "standard") return bad("speed", "speed must be fast or standard.");
    value.speed = input.speed;
  }
  if (input.metadata !== undefined) {
    const m = asObject(input.metadata);
    const entries = m ? Object.entries(m) : [];
    if (!m || entries.length > 20 || entries.some(([k, v]) => k.length < 1 || k.length > 40 || typeof v !== "string" || v.length > 500)) {
      return bad("metadata", "metadata is at most 20 keys of 1 to 40 characters, with string values of at most 500.");
    }
    value.metadata = m as Record<string, string>;
  }
  if (input.trackId !== undefined) {
    if (!isId("trk", input.trackId)) return bad("trackId", "trackId must be trk_ and 16 lowercase Crockford base32 characters.");
    value.trackId = input.trackId;
  }
  if (input.role !== undefined) {
    if (input.role !== "start") return bad("role", "role is start.");
    value.role = "start";
  }
  // Org checks it (org/sessions.ts `parseAccess`).
  if (input.access !== undefined) value.access = input.access as CreateSession["access"];
  const settings = checkSettings({
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.effort !== undefined ? { effort: value.effort } : {}),
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
  });
  if (!settings.ok) return { error: [400, settings.code, settings.message, { field: settings.field }] };
  return { value, ...(attachments ? { attachments: attachments.ids } : {}) };
}

/** `GET /sessions`'s query; Org checks the rest. */
export function listQuery(query: URLSearchParams): ListQuery | { error: string; field: string } {
  const q: ListQuery = {};
  const csv = (name: string) => query.get(name)?.split(",").filter(Boolean);
  for (const name of ["owner", "q", "cursor", "slackThread"] as const) {
    const v = query.get(name);
    if (v !== null) q[name] = v;
  }
  const status = csv("status");
  if (status?.length) q.status = status;
  const origin = csv("origin");
  if (origin?.length) q.origin = origin;
  const archived = query.get("archived");
  if (archived !== null) {
    if (archived !== "true" && archived !== "false") return { error: "archived is true or false.", field: "archived" };
    q.archived = archived === "true";
  }
  const order = query.get("order");
  if (order !== null) {
    if (order !== "active" && order !== "created") return { error: "order is active or created.", field: "order" };
    q.order = order;
  }
  const limit = intParam(query, "limit", 1, 100);
  if (limit === null) return { error: "limit is 1 to 100.", field: "limit" };
  if (limit !== undefined) q.limit = limit;
  return q;
}
