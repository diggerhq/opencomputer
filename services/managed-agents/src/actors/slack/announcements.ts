// A child session's brief at the top level of its parent's channel, and that thread recorded as the
// child's (spec 40.1), once. Org owes `Slack.announce` and retries it, so the post is recorded as begun
// (in `idem`, under the child's session id) before it is sent and carries the child's id in its
// metadata: a retry that finds it begun and no thread adopts the message Slack has instead of posting again.

import { idem } from "../../durable/idempotency.js";
import { type Sql } from "../../durable/sql.js";
import { parseSessionKey, sessionKey } from "../../host-protocol/session-key.js";
import { type SlackResult } from "../../slack-api/web-api.js";
import { MAX_POST_CHARS, neutralizeBroadcasts } from "../../slack-api/threads.js";
import { threads } from "./tables.js";

/** The posts' metadata type, which names the child session (Slack's message metadata). */
const EVENT_TYPE = "opencomputer_session_announced";
/** Longer than Org's retries of an owed call (about a day). */
const BEGUN_TTL_MS = 3 * 24 * 60 * 60_000;
/** Slack's clock and ours may differ: the history is read from this long before the post was begun. */
const CLOCK_SLACK_MS = 5 * 60_000;
const HISTORY_PAGES = 5;

type Slack = (method: string, body: Record<string, unknown>) => Promise<SlackResult>;
type History = SlackResult & {
  messages?: { ts?: string; metadata?: { event_type?: string; event_payload?: { session_id?: unknown } } }[];
  response_metadata?: { next_cursor?: string };
};

export async function announce(sql: Sql, slack: Slack, child: { sessionId: string; parent: string; brief: string }): Promise<{ threadKey: string }> {
  const known = threads.keyOf(sql, child.sessionId);
  if (known) return { threadKey: known };
  const parentKey = threads.keyOf(sql, child.parent);
  const parent = parentKey ? parseSessionKey(parentKey) : null;
  if (!parent) throw new Error("the parent session has no Slack thread");

  const begunKey = `slack:announce:${child.sessionId}`;
  const begun = idem.get(sql, begunKey, EVENT_TYPE);
  let ts: string | undefined;
  if (begun && "result" in begun) ts = await posted(slack, parent.channelId, child.sessionId, (begun.result as { since: number }).since);
  else idem.put(sql, begunKey, EVENT_TYPE, { since: Date.now() }, BEGUN_TTL_MS);
  if (!ts) {
    const sent = await slack("chat.postMessage", {
      channel: parent.channelId,
      text: neutralizeBroadcasts(child.brief).slice(0, MAX_POST_CHARS),
      metadata: { event_type: EVENT_TYPE, event_payload: { session_id: child.sessionId } },
    });
    if (!sent.ok || !sent.ts) throw new Error(`the brief was not posted: ${sent.error ?? "no ts"}`);
    ts = sent.ts;
  }
  const threadKey = sessionKey(parent.teamId, parent.channelId, ts);
  threads.put(sql, threadKey, child.sessionId);
  return { threadKey };
}

/** The ts of the brief an earlier try posted for the session, if Slack has it. Throws when the history could not be read. */
async function posted(slack: Slack, channel: string, sessionId: string, since: number): Promise<string | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const r = (await slack("conversations.history", {
      channel,
      oldest: ((since - CLOCK_SLACK_MS) / 1000).toFixed(6),
      include_all_metadata: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as History;
    if (!r.ok) throw new Error(`the channel's history was not read: ${r.error ?? "unknown"}`);
    const found = r.messages?.find((m) => m.metadata?.event_type === EVENT_TYPE && m.metadata.event_payload?.session_id === sessionId);
    if (found?.ts) return found.ts;
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor) return undefined;
  }
  return undefined;
}
