// Slack thread access for computer sessions (Calvin work 049 L3): a session
// reads a thread linked in a message it is delivered, reads one on demand
// (`read_thread`), and posts into one when asked (`post_thread`). Decision D6
// governs all three: the thread must be in a public channel of this
// workspace, the app must be in that channel, and the person the session runs
// for (and whoever posted the link) must be able to see it: a full member, or
// a guest who is in the channel. Private channels, DMs and group DMs are
// always refused, and content never reaches a conversation shared with
// another organization.
//
// Refusals are one line that names no private channel and no person. Nothing
// here logs or stores message text: the result goes straight into a delivery
// or a reply to the host. Calvin's runner frames it (src/links.ts
// `linkedBlock`) in a delimited block marked as other people's data.

import type { SlackResult } from "./slack.js";
import { decodeSlack } from "./slack.js";

export interface LinkedMessage {
  /** Author's display name (or bot name). */
  name: string;
  ts: string;
  text: string;
  files?: string[];
  /** The message the link points at, when it is a reply in a thread. */
  linked?: boolean;
  /** Replies left out just before this one (a trailing entry with only this set ends the list). */
  skipped?: number;
}

/**
 * One thread: its content, or why it isn't shared (calvin src/links.ts `Linked`).
 * `here`: the replies above a mention that started a session mid-thread, not a link.
 */
export type Linked =
  | { url: string; ok: true; where: string; messages: LinkedMessage[]; omitted?: number; unread?: boolean; here?: boolean; forwarded?: boolean }
  | { url: string; ok: false; reason: string; here?: boolean };

/** A message forwarded into Slack ("Forward message"): Slack attaches its copy instead of putting it in `text`. */
export interface ForwardedMessage {
  url: string;
  author: string;
  channel?: string;
  ts?: string;
  text: string;
  files?: string[];
}

/**
 * Forwarded messages as linked ones. The copy is already in the thread,
 * visible to everyone who reads it, so no D6 check applies, unlike a link.
 */
export function forwardedLinked(forwarded: ForwardedMessage[] | undefined): Linked[] {
  return (forwarded ?? []).map((f) => ({
    url: f.url,
    ok: true as const,
    forwarded: true,
    where: f.channel ? `#${f.channel}` : "Slack",
    messages: [{ name: f.author, ts: f.ts ?? "", text: cap(decodeSlack(f.text)), ...(f.files?.length ? { files: f.files } : {}) }],
  }));
}

export interface ThreadRef {
  url: string;
  /** `<workspace>.slack.com`, from an archives link. */
  host?: string;
  /** From an app.slack.com link. */
  teamId?: string;
  channel: string;
  ts: string;
  threadTs?: string;
}

/** Who the content is for: the session's owner, who posted (when not the owner), and where it lands. */
export interface ThreadAudience {
  owner: string;
  poster?: string;
  /** The session's channel. */
  destination: string;
  /** Past this (ms since the epoch) paging stops and the read is refused as too slow. */
  deadline?: number;
}

export interface PostedReply {
  ts: string;
  url: string;
}

type Slack = (method: string, body: Record<string, unknown>) => Promise<SlackResult>;

export const MAX_LINKS = 3;
export const LINK_TIMEOUT_MS = 10_000;
export const MAX_POST_CHARS = 4_000;
const MAX_REPLIES = 40;
const MAX_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_MEMBERS = 5_000;
const MAX_READ = 2_000;
const MAX_NAME_LOOKUPS = 25;
const USERS_TTL_MS = 10 * 60_000;

const ARCHIVES = /https:\/\/([a-z0-9-]+(?:\.enterprise)?\.slack\.com)\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})(\?[^\s<>|)]*)?/gi;
const CLIENT = /https:\/\/app\.slack\.com\/client\/(T[A-Z0-9]+)\/([CDG][A-Z0-9]+)\/thread\/([CDG][A-Z0-9]+)-(\d{10}\.\d{6})/gi;

/** Slack thread links in text (both forms), de-duplicated, at most `MAX_LINKS`, in order. */
export function findThreadLinks(text: string): ThreadRef[] {
  const found: Array<ThreadRef & { at: number }> = [];
  for (const m of text.matchAll(ARCHIVES)) {
    const threadTs = new URLSearchParams(m[5] ?? "").get("thread_ts") ?? undefined;
    found.push({
      at: m.index,
      url: m[0],
      host: m[1]!.toLowerCase(),
      channel: m[2]!.toUpperCase(),
      ts: `${m[3]}.${m[4]}`,
      ...(threadTs && /^\d+\.\d+$/.test(threadTs) ? { threadTs } : {}),
    });
  }
  for (const m of text.matchAll(CLIENT)) {
    if (m[2]!.toUpperCase() !== m[3]!.toUpperCase()) continue;
    found.push({ at: m.index, url: m[0], teamId: m[1]!.toUpperCase(), channel: m[2]!.toUpperCase(), ts: m[4]! });
  }
  const out: ThreadRef[] = [];
  for (const { at, ...link } of found.sort((a, b) => a.at - b.at)) {
    void at;
    if (out.some((l) => l.host === link.host && l.teamId === link.teamId && l.channel === link.channel && l.ts === link.ts)) continue;
    out.push(link);
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

/** What a tool asks for: a link, or a channel and a message ts. Null when neither is usable. */
export function threadRefFor(req: { url?: unknown; channel?: unknown; ts?: unknown } | undefined): ThreadRef | null {
  if (typeof req?.url === "string" && req.url.trim()) return findThreadLinks(req.url.trim())[0] ?? null;
  const channel = typeof req?.channel === "string" ? req.channel.trim().toUpperCase() : "";
  const ts = typeof req?.ts === "string" ? req.ts.trim() : "";
  if (!/^[CDG][A-Z0-9]+$/.test(channel) || !/^\d+\.\d+$/.test(ts)) return null;
  return { url: "", channel, ts };
}

/**
 * Agent text → a Slack post that cannot notify a whole channel or group:
 * `<!channel>`, `<!here>`, `<!everyone>` and `<!subteam^…>` become plain
 * text, which Slack does not turn into mentions (`link_names` stays off).
 * Mentions of people stay; the person may have asked for them. Rewriting
 * runs until nothing changes, since one pass can assemble a new token out
 * of its neighbours (`<<!x|!channel>>`, `<!channel|<!here>>`), and any `<!`
 * still standing is escaped.
 */
export function neutralizeBroadcasts(text: string): string {
  const token = /<!(?!date\^)([^<>|]*)(?:\|([^<>]*))?>/g;
  let out = text;
  for (let i = 0; i < 10; i++) {
    const next = out.replace(token, (_, target: string, label?: string) => label || `@${target.split("^")[0]}`);
    if (next === out) break;
    out = next;
  }
  return out.replace(/<!(?!date\^)/g, "&lt;!");
}

/** The body may not carry its own "Posted for" line: the real one is appended after it. */
export function stripAttribution(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*_?Posted for <@/i.test(line))
    .join("\n");
}

class Refused extends Error {}

interface User {
  at: number;
  name: string;
  /** Deleted, or the lookup failed: never passes the check. */
  unknown: boolean;
  guest: boolean;
}

interface Channel {
  id: string;
  name?: string;
  isPublic: boolean;
  isMember: boolean;
  extShared: boolean;
}

/**
 * One per Durable Object. Caches the workspace's own host and team
 * (auth.test) and people (users.info, ten minutes); never a channel's
 * state (a channel can go private, or lose the app, at any moment) and
 * never message text.
 */
export class ThreadAccess {
  private own?: { host: string; teamId: string };
  private readonly users = new Map<string, User>();

  constructor(private readonly slack: Slack) {}

  /** Every thread link in a message, read or refused. Never throws. */
  async resolve(text: string, audience: ThreadAudience): Promise<Linked[]> {
    return Promise.all(findThreadLinks(text).map((ref) => this.read(ref, audience)));
  }

  /** One thread, read or refused; with `before`, only its messages older than that ts. Never throws. */
  async read(ref: ThreadRef, audience: ThreadAudience, before?: string): Promise<Linked> {
    try {
      const { url, channel } = await this.check(ref, audience);
      return { url, ok: true, where: `#${channel.name ?? channel.id}`, ...(await this.thread(ref, audience.deadline, before)) };
    } catch (error) {
      return { url: ref.url || `${ref.channel}/${ref.ts}`, ok: false, reason: reasonFor(error) };
    }
  }

  /**
   * A reply in the thread, under the same check, with the person it was
   * posted for and a link back to the session's thread on its own line.
   * Throws the refusal or Slack's error.
   */
  async post(ref: ThreadRef, audience: ThreadAudience, input: { text: string; sessionUrl: string | null }): Promise<PostedReply> {
    const body = stripAttribution(input.text).trim();
    if (!body) throw new Error("the text is empty");
    if (body.length > MAX_POST_CHARS) throw new Error(`the text is longer than ${MAX_POST_CHARS} characters`);
    try {
      await this.check(ref, audience);
    } catch (error) {
      throw new Error(`not posted: ${reasonFor(error)}`);
    }
    // The thread's root, as Slack has it: the link may point at a reply, and a
    // link's own thread_ts is whatever the writer put there.
    const found = await this.slack("conversations.replies", { channel: ref.channel, ts: ref.ts, limit: 1 });
    const first = (found as Replies).messages?.[0];
    if (!found.ok || !first) throw new Error(`not posted: ${reasonFor(slackError(found.error, "that message was not found"))}`);
    const root = first.thread_ts ?? first.ts ?? ref.ts;
    const back = input.sessionUrl ? ` from <${input.sessionUrl}|this thread>` : "";
    const posted = await this.slack("chat.postMessage", {
      channel: ref.channel,
      thread_ts: root,
      text: `${neutralizeBroadcasts(body)}\n_Posted for <@${audience.owner}>${back}._`,
      unfurl_links: false,
      unfurl_media: false,
      link_names: false,
    });
    if (!posted.ok || !posted.ts) throw new Error(`Slack post failed: ${posted.error ?? "unknown_error"}`);
    const { host } = await this.workspace();
    return { ts: posted.ts, url: `https://${host}/archives/${ref.channel}/p${posted.ts.replace(".", "")}?thread_ts=${root}&cid=${ref.channel}` };
  }

  /** D6, in order. Throws `Refused` (or Slack's error) unless the thread may be read here. */
  private async check(ref: ThreadRef, audience: ThreadAudience): Promise<{ url: string; channel: Channel }> {
    // 1. This workspace.
    const own = await this.workspace();
    if (ref.host && ref.host !== own.host) throw new Refused("it is in another Slack workspace; only this workspace's threads can be read");
    if (ref.teamId && ref.teamId !== own.teamId) throw new Refused("it is in another Slack workspace; only this workspace's threads can be read");
    // 2. A public channel the app is in.
    const channel = await this.channel(ref.channel, "that channel was not found, or it is not a public channel");
    if (!channel.isPublic) throw new Refused("it is not in a public channel; only public channels can be read");
    if (!channel.isMember) throw new Refused("the app is not in that channel; someone can invite it there");
    // 3. The people it is for.
    let members: Set<string> | undefined;
    for (const id of new Set([audience.owner, audience.poster].filter((p): p is string => !!p))) {
      const person = await this.user(id);
      if (person.unknown) throw new Refused("could not confirm who asked can see that channel");
      if (person.guest && !(members ??= await this.members(ref.channel, audience.deadline)).has(id)) throw new Refused("a guest who asked is not in that channel");
    }
    // 4. Not into a conversation shared with another organization.
    if (audience.destination !== ref.channel) {
      const destination = await this.channel(audience.destination, "this conversation could not be checked");
      if (destination.extShared) throw new Refused("this conversation is shared with another organization");
    }
    const url = ref.url || `https://${own.host}/archives/${ref.channel}/p${ref.ts.replace(".", "")}`;
    return { url, channel };
  }

  private async workspace(): Promise<{ host: string; teamId: string }> {
    if (this.own) return this.own;
    const r = (await this.slack("auth.test", {})) as SlackResult & { url?: string; team_id?: string };
    if (!r.ok || !r.url || !r.team_id) throw new Error(r.error ?? "auth.test gave no workspace");
    this.own = { host: new URL(r.url).hostname.toLowerCase(), teamId: r.team_id };
    return this.own;
  }

  /** conversations.info, asked every time: what it says decides the check. */
  private async channel(id: string, notThere: string): Promise<Channel> {
    const r = (await this.slack("conversations.info", { channel: id })) as SlackResult & { channel?: ConversationInfo };
    if (!r.ok || !r.channel) throw slackError(r.error, notThere);
    const c = r.channel;
    return {
      id,
      ...(c.name ? { name: c.name } : {}),
      isPublic: c.is_channel === true && !c.is_private && !c.is_im && !c.is_mpim && !c.is_group,
      isMember: c.is_member === true,
      extShared: !!c.is_ext_shared,
    };
  }

  /** users.info, cached. A failed lookup is not cached and counts as unknown: the check fails closed. */
  private async user(id: string): Promise<User> {
    const cached = this.users.get(id);
    if (cached && Date.now() - cached.at < USERS_TTL_MS) return cached;
    const r = await this.slack("users.info", { user: id });
    const u = r.ok ? r.user : undefined;
    if (!u) return { at: Date.now(), name: id, unknown: true, guest: true };
    const user: User = {
      at: Date.now(),
      name: u.profile?.display_name || u.real_name || u.profile?.real_name || u.name || id,
      unknown: !!u.deleted,
      guest: !!(u.is_restricted || u.is_ultra_restricted || u.is_stranger),
    };
    this.users.set(id, user);
    return user;
  }

  private async members(channel: string, deadline?: number): Promise<Set<string>> {
    const out = new Set<string>();
    let cursor: string | undefined;
    do {
      past(deadline);
      const r = (await this.slack("conversations.members", { channel, limit: 1000, ...(cursor ? { cursor } : {}) })) as SlackResult & Paged & { members?: string[] };
      if (!r.ok) throw slackError(r.error, "that channel's members could not be checked");
      for (const id of r.members ?? []) out.add(id);
      if (out.size > MAX_MEMBERS) throw new Refused("that channel has too many members to check");
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  /** The root, the linked reply, and as many of the latest replies as fit (D5); with `before`, only those older than it. */
  private async thread(ref: ThreadRef, deadline?: number, before?: string, followed = false): Promise<{ messages: LinkedMessage[]; omitted?: number; unread?: boolean }> {
    const all: SlackMessage[] = [];
    let cursor: string | undefined;
    // Past `before` nothing more is needed: anything not fetched comes after it.
    let reached = false;
    do {
      past(deadline);
      const r = (await this.slack("conversations.replies", {
        channel: ref.channel,
        ts: ref.threadTs ?? ref.ts,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      })) as Replies;
      if (!r.ok) throw slackError(r.error, "that message was not found");
      all.push(...(r.messages ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
      reached = !!before && all.some((m) => Number(m.ts) >= Number(before));
    } while (cursor && !reached && all.length < MAX_READ);
    if (!all.length) throw new Refused("that message was not found");
    // Asked with a reply's ts (no thread_ts, or one that is itself a reply), Slack gives that
    // reply alone, which names its thread: read the whole thread once, the reply marked.
    const first = all[0]!;
    if (!followed && first.thread_ts && first.thread_ts !== first.ts) return this.thread({ ...ref, threadTs: first.thread_ts }, deadline, before, true);
    if (before) for (let i = all.length - 1; i >= 0; i--) if (Number(all[i]!.ts) >= Number(before)) all.splice(i, 1);

    // Names for authors and mentions: at most MAX_NAME_LOOKUPS asked, the rest shown as ids.
    const ids = new Set<string>();
    for (const m of all) {
      if (m.user) ids.add(m.user);
      for (const [, id] of String(m.text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(id!);
    }
    const names = new Map<string, string>();
    await Promise.all(
      [...ids].slice(0, MAX_NAME_LOOKUPS).map(async (id) => {
        const user = await this.user(id).catch(() => undefined);
        if (user && !user.unknown) names.set(id, user.name);
      }),
    );
    const name = (m: SlackMessage) => (m.user ? (names.get(m.user) ?? m.user) : (m.bot_profile?.name ?? m.username ?? "a bot"));
    // A reply link's own ts, unless it is the root.
    const linkedTs = ref.ts !== first.ts ? ref.ts : undefined;
    const toMessage = (m: SlackMessage): LinkedMessage => ({
      name: name(m),
      ts: m.ts ?? "",
      text: cap(decodeSlack(String(m.text ?? "").replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (_, id: string) => `@${names.get(id) ?? id}`))),
      ...(m.files?.length ? { files: m.files.map((f) => f.name ?? f.id ?? "file") } : {}),
      ...(linkedTs && m.ts === linkedTs ? { linked: true } : {}),
    });

    const [root, ...replies] = all.map(toMessage) as [LinkedMessage, ...LinkedMessage[]];
    const recent = replies.length - MAX_REPLIES;
    let chars = root.text.length;
    const keep = new Set<number>();
    for (let i = replies.length - 1; i >= 0; i--) {
      const m = replies[i]!;
      if (!m.linked && (i < recent || chars + m.text.length > MAX_CHARS)) continue;
      chars += m.text.length;
      keep.add(i);
    }
    const messages = [root];
    let skipped = 0;
    for (const [i, m] of replies.entries()) {
      if (!keep.has(i)) {
        skipped++;
        continue;
      }
      messages.push(skipped ? { ...m, skipped } : m);
      skipped = 0;
    }
    if (skipped) messages.push({ name: "", ts: "", text: "", skipped });
    // Past MAX_READ the newest replies were never fetched: say so rather than pass older ones off as the end.
    const unread = !!cursor && !reached;
    // The root's reply_count counts replies after `before` too.
    const omitted = (before ? replies.length : Math.max(replies.length, Number(all[0]!.reply_count) || 0)) - keep.size;
    return { messages, ...(omitted > 0 ? { omitted } : {}), ...(unread ? { unread } : {}) };
  }
}

interface ConversationInfo {
  name?: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_group?: boolean;
  is_member?: boolean;
  is_ext_shared?: boolean;
}

interface Paged {
  response_metadata?: { next_cursor?: string };
}

interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  reply_count?: number;
  files?: Array<{ id?: string; name?: string }>;
}

type Replies = SlackResult & Paged & { messages?: SlackMessage[] };

const cap = (s: string) => (s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)} …[cut]` : s);

/** Refuses once the caller's deadline has passed, so a long page walk stops instead of running on after the answer. */
function past(deadline: number | undefined): void {
  if (deadline !== undefined && Date.now() > deadline) throw new Refused("reading it took too long; ask again to retry");
}

/** Slack's "not in it / not found" errors read as a refusal; anything else stays an error. */
function slackError(code: string | undefined, notThere: string): Error {
  if (["channel_not_found", "not_in_channel", "thread_not_found", "message_not_found"].includes(code ?? "")) return new Refused(notThere);
  return new Error(code ?? "unknown_error");
}

function reasonFor(error: unknown): string {
  if (error instanceof Refused) return error.message;
  return `could not check it (${error instanceof Error ? error.message : String(error)})`;
}
