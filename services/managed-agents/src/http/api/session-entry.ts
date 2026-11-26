// One inbox entry sent as spec 40.2 (`SessionLog.accept` with `wait`), and the ids entries are given.

import { logOf, type ActorEnv } from "../../actors/addresses.js";
import type { InboxKind } from "../../actors/session-log/contract.js";
import type { Principal } from "../../auth/principal.js";
import { base64url } from "../../encoding/base64url.js";
import { hashOf } from "../../encoding/canonical-json.js";
import { crockfordId } from "../../ids/crockford.js";
import { hostErrorOf, refusalOf, type Reply } from "./reply.js";
import { timedLog } from "./request-facts.js";

/** `<prefix>_` and `length` Crockford characters: of the hash of `seed` when given (a retry lands on the same id), else random. */
export async function entryId(prefix: string, length: number, seed?: unknown): Promise<string> {
  return crockfordId(prefix, length, seed === undefined ? undefined : base64url.decode(await hashOf(seed))!);
}

type Sent = { delivered: unknown } | { waking: true } | { response: Response };

/**
 * One inbox entry, as spec 40.2: `SessionLog.accept` with `wait`, the one path to the machine (the log's
 * own drain delivers it). Delivered: the host's result (or its refusal); still waiting: waking.
 */
export async function sendEntry(env: ActorEnv, p: Principal, sessionId: string, entry: { id: string; kind: InboxKind; body: unknown }, trace: string | undefined, out: Reply): Promise<Sent> {
  const accepted = await timedLog(out.facts, logOf(env, sessionId).accept(p, { ...entry, ...(trace ? { trace } : {}) }, { wait: true }));
  if (!accepted.ok) {
    const code = accepted.code === "forbidden" || accepted.code === "not_found" ? "session_not_found" : accepted.code;
    return { response: refusalOf(out, { ok: false, code, message: code === "session_not_found" ? "No such session." : `Refused: ${code}.` }) };
  }
  if (accepted.duplicate) out.facts.replayed = true;
  const { outcome } = accepted;
  if (outcome.state === "delivered") return { delivered: outcome.result ?? null };
  if (outcome.state === "refused") return { response: hostErrorOf(out, outcome.error) };
  return { waking: true };
}
