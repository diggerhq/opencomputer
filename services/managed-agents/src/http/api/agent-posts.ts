// An agent's posts beyond its own session (spec 37.2): to its track's agent, and to a Slack thread.

import { slackOf, type ActorEnv } from "../../actors/addresses.js";
import type { OrgRpc } from "../../actors/org/contract.js";
import type { Principal } from "../../auth/principal.js";
import { refusalOf, type Reply } from "./reply.js";
import { oneString } from "./request-body.js";
import { timedDo } from "./request-facts.js";
import { entryId, sendEntry } from "./session-entry.js";

/** `POST /work/tell-track` (spec 37.2): an agent's message to its track's agent, as a turn there. */
export async function tellTrack(request: Request, env: ActorEnv, p: Principal, idem: string | undefined, trace: string | undefined, org: () => OrgRpc, out: Reply): Promise<Response> {
  if (p.kind !== "agent") return out.error(403, "forbidden", "Only a session's agent tells its track.", { reason: "agents_only" });
  const message = await oneString(request, "message", 100_000);
  if ("error" in message) return out.error(...message.error);
  const target = await timedDo(out.facts, org().trackAgent(p));
  if (!target) return out.error(404, "not_found", "This session's track has no agent.");
  const id = await entryId("tn", 12, idem ? ["tell", p.org, p.subject, idem] : undefined);
  const sent = await sendEntry(env, p, target, { id, kind: "turn", body: { input: message.value, ifBusy: "queue" } }, trace, out);
  if ("response" in sent) return sent.response;
  if ("waking" in sent) return out.send(202, { accepted: true, id });
  return out.send(200, sent.delivered);
}

const THREAD_KEY = /^[A-Za-z0-9:._-]{1,128}$/;

/** `POST /slack/threads/{key}/messages` (spec 37.2): an agent's `post_thread`, through the Slack actor. */
export async function slackPost(request: Request, env: ActorEnv, p: Principal, key: string, out: Reply): Promise<Response> {
  if (p.kind !== "agent") return out.error(403, "forbidden", "Only a session's agent posts to a Slack thread.", { reason: "agents_only" });
  const threadKey = decodeURIComponent(key);
  if (!THREAD_KEY.test(threadKey)) return out.error(404, "not_found", "No such Slack thread.");
  const text = await oneString(request, "text", 40_000);
  if ("error" in text) return out.error(...text.error);
  const r = await timedDo(out.facts, slackOf(env, p.org).post(p, threadKey, text.value));
  return r.ok ? out.send(200, { ts: r.ts }) : refusalOf(out, r);
}
