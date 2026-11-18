// Session roles in the computer's gateway (work 112, "One transition",
// "Messages", "Request to drive", "Prompts", "Stop"): who is acting, the one
// write of `drivers`, the context held from people who cannot instruct a
// session and its attachment to the next message that is delivered, requests
// to drive, prompt clicks and the stop line. The rules are access.ts's; this
// applies them with the store, Slack and the Durable Object's delivery, which
// it gets as dependencies (like secrets-store.ts). The modal and `!access`
// are access-ui.ts.
//
// Member: a full member of the linked workspace (`ThreadAccess.member`, the
// Durable Object's one cached lookup of a person). A failed lookup throws:
// a queued message is retried, a click or a modal answers "try again".
// Admin: a Slack user linked to a dashboard member the dashboard last saw as
// an owner or admin (`apiAdmins`, sessions-api.ts); fails closed.

import {
  type Access,
  type Actor,
  type ChangedBy,
  type Drivers,
  can,
  commandAction,
  commandWord,
  driversCommandText,
  encodeDrivers,
  gained,
  grantedText,
  initialDrivers,
  normalize,
  notAskedText,
  notMemberText,
  noSessionText,
  overLimit,
  onlyGrantorAnswersText,
  onlyMembersText,
  openedText,
  ownerCommandText,
  ownerDecidesText,
  requestSentText,
  restricted,
  role,
  sameDrivers,
  stoppedText,
  tooManyPeopleText,
  ACCESS_USAGE,
} from "./access.js";
import { declinedPost, requestPost } from "./access-views.js";
import type { AccessRequest, AccessStore } from "./access-store.js";
import { type CalvinSlackFile, type CalvinTraceContext, NOT_ASKED } from "./protocol.js";
import type { SlackMessageJob, SlackResult } from "./slack.js";
import { type Linked, LOOKUP_FAILED_TEXT } from "./threads.js";

/** Pending prompt clicks remembered for a `not-asked` reply; the oldest go first past this. */
const MAX_PENDING_ANSWERS = 200;

/** The session an event is about: its runner key, owner and thread. */
export interface RoleSession {
  key: string;
  ownerId: string;
  channelId: string;
  threadTs: string;
}

/** A delivery as the Durable Object queues it (its `Dispatch`), as far as roles need it. */
export interface AccessDispatch {
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  files?: CalvinSlackFile[];
  mentioned?: boolean;
  trace?: CalvinTraceContext;
  linked?: Linked[];
  role?: "owner" | "driver" | "participant";
}

/** What `message` decided: deliver with `role` (and the held context unless it is a command), or not at all. */
export type MessageGate =
  | { deliver: true; role: "owner" | "driver" | "participant"; context: boolean }
  | { deliver: false; reason: "outsider" | "held" | "command_refused" };

/** Why `setDrivers` changed nothing: the caller only turns it into words (`refusalText`). */
export type DriversRefusal = { refused: "gone" | "usage" | "limit" } | { refused: "member"; id: string };

export interface AccessFlowDeps {
  store: AccessStore;
  slack(method: string, body: Record<string, unknown>): Promise<SlackResult>;
  /** Whether a person is a full member of the linked workspace (cached); throws when Slack could not be asked. */
  member(slackUserId: string): Promise<boolean>;
  /** A session with an owner, by runner key. */
  session(key: string): RoleSession | undefined;
  /** The dashboard member a Slack user linked to (`!link`), if any. */
  linkOfSlack(slackUserId: string): string | undefined;
  /** Whether a dashboard member is an owner or admin of the organization. */
  isAdmin(member: string): boolean;
  /** A person's display name (cached), or their id. */
  name(slackUserId: string): Promise<string>;
  /**
   * Put a message back on the Slack queue, synchronously: an allowed
   * request's message goes through the queue as its sender's, like any other.
   */
  requeue(job: SlackMessageJob): void;
  /** `access.changed`. */
  changed(key: string, by: ChangedBy, from: string, to: string): void;
  waitUntil(work: Promise<unknown>): void;
}

export class AccessFlow {
  /** Prompt clicks sent to the host with a `role`, by frame id: whom to tell when the runner answers `not-asked`. */
  private readonly answers = new Map<string, { key: string; userId: string }>();

  constructor(private readonly deps: AccessFlowDeps) {}

  /** The session a runner key names, with an owner. */
  session(key: string): RoleSession | undefined {
    return this.deps.session(key);
  }

  access(key: string): Access | undefined {
    const s = this.deps.session(key);
    const drivers = s && this.deps.store.drivers(key);
    return s && drivers !== undefined ? { owner: s.ownerId, drivers } : undefined;
  }

  /**
   * Who is acting. The owner's membership is not looked up: `role` puts the
   * owner first, so it decides nothing for them. Throws when Slack could not
   * be asked.
   */
  async actor(userId: string, owner?: string): Promise<Actor> {
    const link = this.deps.linkOfSlack(userId);
    const admin = !!link && this.deps.isAdmin(link);
    const member = userId === owner || (await this.deps.member(userId));
    return { id: userId, member, admin };
  }

  /** `actor` for a click: when Slack could not be asked, the clicker is told to try again and it is undefined. */
  async clicker(s: { channelId: string; threadTs?: string }, userId: string, owner: string): Promise<Actor | undefined> {
    try {
      return await this.actor(userId, owner);
    } catch {
      await this.ephemeral(s, userId, LOOKUP_FAILED_TEXT);
      return undefined;
    }
  }

  /** Whether `userId` may write to or wake the session (`can(instruct)`); anyone, for a session without an owner. Throws as `actor`. */
  async instructs(key: string, userId: string): Promise<boolean> {
    const a = this.access(key);
    return !a || can(a, await this.actor(userId, a.owner), "instruct");
  }

  /** `ChangedBy` for an actor: `admin` only when an admin who is not the owner made the change. */
  by(a: Access, u: Actor): ChangedBy {
    return { id: u.id, admin: u.admin && u.id !== a.owner };
  }

  // ---------------------------------------------------------------- new sessions

  /**
   * A new session's `drivers`: its parent's for a spawned one (`from`), else
   * the organization's default. A restricted one gets the marker, off the
   * caller's path (session creation is synchronous).
   */
  start(key: string, from?: string): void {
    const s = this.deps.session(key);
    if (!s) return;
    const parent = from ? this.deps.store.drivers(from) : undefined;
    const drivers = normalize(s.ownerId, parent ?? initialDrivers(this.deps.store.accessDefault()));
    this.deps.store.writeDrivers(key, drivers);
    if (restricted(drivers)) this.deps.waitUntil(this.marker(s, true));
  }

  // ---------------------------------------------------------------- one transition

  /**
   * The only write of `drivers` ("One transition"): `edit` turns the current
   * value into the next (undefined: it does not apply to it). The people it
   * adds are looked up first, together; then the current value is read,
   * edited, checked and written with nothing awaited in between, so an edit
   * made meanwhile is never lost. Undefined when done (also when nothing
   * changed); otherwise why not, for the caller to word.
   */
  async setDrivers(key: string, edit: (current: Drivers) => Drivers | undefined, by: ChangedBy): Promise<DriversRefusal | undefined> {
    const members = new Map<string, boolean>();
    for (;;) {
      // 1–2: read, edit, normalize, check.
      const s = this.deps.session(key);
      const prev = s && this.deps.store.drivers(key);
      if (!s || prev === undefined) return { refused: "gone" };
      const edited = edit(prev);
      if (edited === undefined) return { refused: "usage" };
      const next = normalize(s.ownerId, edited);
      if (overLimit(next)) return { refused: "limit" };
      // Only the people this names: someone already named stays until removed.
      const named = next === "*" ? [] : next.filter((id) => prev === "*" || !prev.includes(id));
      const unknown = named.filter((id) => !members.has(id));
      if (unknown.length) {
        // Looked up together; then read again, as the lookups let other edits in.
        const found = await Promise.all(unknown.map((id) => this.deps.member(id)));
        unknown.forEach((id, n) => members.set(id, found[n]!));
        continue;
      }
      const outsider = named.find((id) => !members.get(id));
      if (outsider) return { refused: "member", id: outsider };
      const granted = this.write(s, next);
      // 3. The marker, when restricted changed.
      if (restricted(prev) !== restricted(next)) await this.marker(s, restricted(next));
      for (const r of granted) await this.call("chat.update", { channel: s.channelId, ts: r.messageTs, text: grantedText(by, [r.userId], s.ownerId), blocks: [] });
      // 5. Announce when more people can drive than before.
      const more = gained(prev, next);
      const added = more === "opened" ? [] : more.filter((id) => !granted.some((r) => r.userId === id));
      if (more === "opened") await this.post(s, openedText(by, s.ownerId));
      else if (added.length) await this.post(s, grantedText(by, added, s.ownerId));
      // 6.
      if (!sameDrivers(prev, next)) this.deps.changed(key, by, encodeDrivers(prev), encodeDrivers(next));
      return undefined;
    }
  }

  /**
   * The write, and step 4 in the same synchronous block: requests whose
   * requester now may instruct are closed, and the message that asked goes
   * back on the queue as theirs, where `message` gates it again (a requester
   * was a member when they asked; the queue looks again). The closed requests.
   */
  private write(s: RoleSession, next: Drivers): AccessRequest[] {
    this.deps.store.writeDrivers(s.key, next);
    const a: Access = { owner: s.ownerId, drivers: next };
    const granted: AccessRequest[] = [];
    for (const r of this.deps.store.openRequests(s.key)) {
      if (!can(a, { id: r.userId, member: true, admin: false }, "instruct")) continue;
      if (!this.deps.store.closeRequest(s.key, r.userId)) continue;
      const job = JSON.parse(r.held) as SlackMessageJob;
      this.deps.store.forgetMessage(s.key, job.messageTs);
      this.deps.requeue(job);
      granted.push(r);
    }
    return granted;
  }

  /** A refusal from `setDrivers`, in words. */
  async refusalText(r: DriversRefusal): Promise<string> {
    switch (r.refused) {
      case "gone":
        return noSessionText();
      case "usage":
        return ACCESS_USAGE;
      case "limit":
        return tooManyPeopleText();
      case "member":
        return notMemberText(await this.deps.name(r.id));
    }
  }

  /** 🔒 on the thread's first message; `already_reacted` and `no_reaction` are success. Never throws. */
  private async marker(s: RoleSession, on: boolean): Promise<void> {
    try {
      const r = await this.deps.slack(on ? "reactions.add" : "reactions.remove", { channel: s.channelId, timestamp: s.threadTs, name: "lock" });
      if (!r.ok && r.error !== "already_reacted" && r.error !== "no_reaction") warn("computer.access_marker_failed", r.error);
    } catch (error) {
      warn("computer.access_marker_failed", error);
    }
  }

  // ---------------------------------------------------------------- messages

  /**
   * A message in an existing session ("Messages" steps 2–4), after `!access`
   * and before every other command, the gateway's own (`!secret`, `!var`, ...)
   * too: they read as `instruct`. Whether it is delivered (or, for a gateway
   * command, handled), and as whom. A participant's message is held as
   * context, and a mention of the app at its start asks the owner to let them
   * drive. Throws when Slack could not be asked who sent it: the queue retries.
   */
  async message(job: SlackMessageJob, text: string, s: RoleSession): Promise<MessageGate> {
    const a: Access = { owner: s.ownerId, drivers: this.deps.store.drivers(s.key) ?? "*" };
    const u = await this.actor(job.userId, s.ownerId);
    const r = role(a, u);
    const command = commandAction(text);
    if (command !== undefined && command !== "access") {
      // An outsider can do nothing: `can` is false for them.
      if (can(a, u, command)) return { deliver: true, role: r as "owner" | "driver" | "participant", context: false };
      const word = commandWord(text) ?? "";
      if (command === "settings") await this.ephemeral(s, job.userId, ownerCommandText(s.ownerId, word));
      else if (command === "instruct") await this.ephemeral(s, job.userId, driversCommandText(word));
      return { deliver: false, reason: "command_refused" };
    }
    if (r === "owner" || r === "driver") return { deliver: true, role: r, context: true };
    if (r === "outsider") {
      if (job.mentioned || job.channelType === "im") await this.ephemeral(s, job.userId, onlyMembersText());
      return { deliver: false, reason: "outsider" };
    }
    const held = this.deps.store.hold(s.key, {
      userId: job.userId,
      ts: job.messageTs,
      text: job.text,
      files: (job.files ?? []).map((f) => f.name ?? f.title ?? f.id),
    });
    // The row is the guard: a message held already (a retried job) asks nothing again.
    // Only a mention of the app at the message's start asks, as self-hosted.
    if (held && ((job.mentioned && !job.mentionedInline) || job.channelType === "im")) await this.requestToDrive(s, job);
    return { deliver: false, reason: "held" };
  }

  /**
   * "Messages" step 5: `dispatch` with the session's held context attached,
   * through `send` (the queue's own delivery by default). The attached rows go
   * once it is accepted; a failure keeps them for the next message.
   */
  async deliver<D extends AccessDispatch>(key: string, dispatch: D, send: (d: D) => Promise<void>): Promise<void> {
    const held = this.deps.store.held(key);
    if (!held.length) return send(dispatch);
    const messages = await Promise.all(
      held.map(async (h) => ({
        name: await this.deps.name(h.userId),
        ts: h.ts,
        text: h.text,
        ...(h.files.length ? { files: h.files } : {}),
        ...(h.skipped ? { skipped: h.skipped } : {}),
      })),
    );
    const context: Linked = { url: "", ok: true, where: "", context: true, messages };
    await send({ ...dispatch, linked: [...(dispatch.linked ?? []), context] });
    this.deps.store.forget(held.map((h) => h.seq));
  }

  // ---------------------------------------------------------------- request to drive

  /**
   * The request row first, the guard against a second (S2b when there was
   * one); then S1 with its buttons in the thread, whose ts the row gets, and
   * S2 to the requester. A post that fails takes the row with it.
   */
  private async requestToDrive(s: RoleSession, job: SlackMessageJob): Promise<void> {
    if (!this.deps.store.addRequest(s.key, job.userId, JSON.stringify(job))) return this.ephemeral(s, job.userId, ownerDecidesText(s.ownerId));
    const posted = await this.call("chat.postMessage", { channel: s.channelId, thread_ts: s.threadTs, ...requestPost(s.key, s.ownerId, job.userId) });
    if (!posted?.ok || !posted.ts) return this.deps.store.deleteRequest(s.key, job.userId);
    this.deps.store.postedRequest(s.key, job.userId, posted.ts);
    await this.ephemeral(s, job.userId, requestSentText(s.ownerId));
  }

  /** `Allow` or `Not now` on a request (`ac:<k>:allow|deny:<requester>`), clicked by `userId`. */
  async answerRequest(key: string, verb: "allow" | "deny", requester: string, userId: string): Promise<void> {
    const s = this.deps.session(key);
    const a = this.access(key);
    if (!s || !a) return;
    const u = await this.clicker(s, userId, a.owner);
    if (!u) return;
    if (!can(a, u, "grant")) return this.ephemeral(s, userId, onlyGrantorAnswersText(a.owner));
    const request = this.deps.store.request(key, requester);
    if (request?.state !== "open") return;
    const by = this.by(a, u);
    if (verb === "deny") {
      if (this.deps.store.closeRequest(key, requester)) await this.call("chat.update", { channel: s.channelId, ts: request.messageTs, ...declinedPost(requester) });
      return;
    }
    // Under '*' the requester drives already: nothing is added, and `setDrivers` still answers the request.
    let refused: DriversRefusal | undefined;
    try {
      refused = await this.setDrivers(key, (d) => (d === "*" ? d : [...d, requester]), by);
    } catch {
      return this.ephemeral(s, userId, LOOKUP_FAILED_TEXT);
    }
    if (refused) await this.ephemeral(s, userId, await this.refusalText(refused));
  }

  // ---------------------------------------------------------------- prompts

  /**
   * A click on a prompt's button. Without `can(answer)` the clicker is told
   * S6 and nothing is sent; otherwise `send` sends the `action` frame with
   * their role and returns its id, remembered for a `not-asked` reply. A
   * session with no owner sends as before, without a role.
   */
  async answer(key: string, userId: string, send: (role?: "owner" | "driver") => string): Promise<void> {
    const s = this.deps.session(key);
    const a = this.access(key);
    if (!s || !a) {
      send();
      return;
    }
    const u = await this.clicker(s, userId, a.owner);
    if (!u) return;
    if (!can(a, u, "answer")) return this.ephemeral(s, userId, notAskedText(a.owner));
    const id = send(role(a, u) === "owner" ? "owner" : "driver");
    this.answers.set(id, { key, userId });
    if (this.answers.size > MAX_PENDING_ANSWERS) this.answers.delete(this.answers.keys().next().value!);
  }

  /** The host's reply to an `action` frame: a `not-asked` error is S6 to whoever clicked. */
  async answered(id: string, error: string | undefined): Promise<void> {
    const pending = this.answers.get(id);
    this.answers.delete(id);
    const s = pending && error === NOT_ASKED ? this.deps.session(pending.key) : undefined;
    if (s && pending) await this.ephemeral(s, pending.userId, notAskedText(s.ownerId));
  }

  // ---------------------------------------------------------------- stop

  /**
   * Slack's stop button. An outsider's is ignored; without a user it stops as
   * before. Once the hub took it, someone other than the owner is named (S9).
   */
  async stop(s: RoleSession, userId: string | undefined, send: () => boolean): Promise<boolean> {
    if (userId) {
      const a: Access = { owner: s.ownerId, drivers: this.deps.store.drivers(s.key) ?? "*" };
      const u = await this.clicker(s, userId, s.ownerId);
      if (!u || !can(a, u, "stop")) return false;
    }
    const delivered = send();
    if (delivered && userId && userId !== s.ownerId) await this.post(s, stoppedText(userId));
    return delivered;
  }

  // ---------------------------------------------------------------- Slack

  /** An ephemeral to `userId` in the thread (at the top level without one). Never throws. */
  async ephemeral(s: { channelId: string; threadTs?: string }, userId: string, text: string, blocks?: unknown[]): Promise<void> {
    await this.call("chat.postEphemeral", { channel: s.channelId, user: userId, ...(s.threadTs ? { thread_ts: s.threadTs } : {}), text, ...(blocks ? { blocks } : {}) });
  }

  private async post(s: RoleSession, text: string): Promise<void> {
    await this.call("chat.postMessage", { channel: s.channelId, thread_ts: s.threadTs, text });
  }

  /** A Slack call whose failure is logged, never thrown: each is a courtesy or is retried by the person. */
  private async call(method: string, body: Record<string, unknown>): Promise<SlackResult | undefined> {
    try {
      const r = await this.deps.slack(method, body);
      if (!r.ok) warn("computer.access_slack_failed", `${method}: ${r.error ?? "unknown_error"}`);
      return r;
    } catch (error) {
      warn("computer.access_slack_failed", error);
      return undefined;
    }
  }
}

function warn(event: string, error: unknown): void {
  console.warn(JSON.stringify({ level: "warn", event, message: error instanceof Error ? error.message : String(error ?? "") }));
}
