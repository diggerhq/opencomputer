// Session roles in the computer's gateway (work 112, "One transition",
// "Messages", "Request to drive", "Prompts", "Stop"): who is acting, the one
// write of `drivers`, the context held from people who cannot instruct a
// session and its attachment to the next message that is delivered, requests
// to drive, prompt clicks and the stop line. The rules are access.ts's; this
// applies them with the store, Slack and the Durable Object's delivery, which
// it gets as dependencies (like secrets-store.ts). The modal and `!access`
// are access-ui.ts.
//
// Member: a full member of the linked workspace (`isWorkspaceMember`). Admin:
// a Slack user linked to a dashboard member the dashboard last saw as an
// owner or admin (`apiAdmins`, sessions-api.ts). Both fail closed.

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
} from "./access.js";
import { declinedPost, requestPost } from "./access-views.js";
import type { AccessStore } from "./access-store.js";
import { type CalvinSlackFile, type CalvinTraceContext, NOT_ASKED } from "./protocol.js";
import { type SlackMessageJob, type SlackResult, isWorkspaceMember } from "./slack.js";
import { type Linked, forwardedLinked } from "./threads.js";

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

export interface AccessFlowDeps {
  store: AccessStore;
  slack(method: string, body: Record<string, unknown>): Promise<SlackResult>;
  /** The linked Slack workspace. */
  teamId(): string;
  /** A session with an owner, by runner key. */
  session(key: string): RoleSession | undefined;
  /** The dashboard member a Slack user linked to (`!link`), if any. */
  linkOfSlack(slackUserId: string): string | undefined;
  /** Whether a dashboard member is an owner or admin of the organization. */
  isAdmin(member: string): boolean;
  /** A person's display name (cached), or their id. */
  name(slackUserId: string): Promise<string>;
  /** Whether the organization may run a turn now (the credit gate); tells the thread when not. */
  admit(channelId: string, threadTs: string): Promise<boolean>;
  /** Queue a delivery for the host; resolves once it is accepted (sent, or kept for an offline host). */
  deliver(dispatch: AccessDispatch): Promise<void>;
  /** `access.changed`. */
  changed(key: string, by: ChangedBy, from: string, to: string): void;
  waitUntil(work: Promise<unknown>): void;
}

export class AccessFlow {
  /** Prompt clicks sent to the host with a `role`, by frame id: whom to tell when the runner answers `not-asked`. */
  private readonly answers = new Map<string, { key: string; userId: string }>();

  constructor(private readonly deps: AccessFlowDeps) {}

  access(key: string): Access | undefined {
    const s = this.deps.session(key);
    const drivers = s && this.deps.store.drivers(key);
    return s && drivers !== undefined ? { owner: s.ownerId, drivers } : undefined;
  }

  /**
   * Who is acting. The owner's membership is not looked up: `role` puts the
   * owner first, so it decides nothing for them.
   */
  async actor(userId: string, owner?: string): Promise<Actor> {
    const link = this.deps.linkOfSlack(userId);
    const admin = !!link && this.deps.isAdmin(link);
    const member = userId === owner || (await isWorkspaceMember((method, body) => this.deps.slack(method, body), this.deps.teamId(), userId));
    return { id: userId, member, admin };
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

  /** The only write of `drivers` ("One transition", steps 1–6). */
  async setDrivers(key: string, next: Drivers, by: ChangedBy): Promise<void> {
    const s = this.deps.session(key);
    const prev = s && this.deps.store.drivers(key);
    if (!s || prev === undefined) return;
    // 1–2.
    next = normalize(s.ownerId, next);
    if (sameDrivers(prev, next)) return;
    this.deps.store.writeDrivers(key, next);
    // 3. The marker, when restricted changed.
    if (restricted(prev) !== restricted(next)) await this.marker(s, restricted(next));
    // 4. Requests whose requester now drives: answered, and the message that asked runs.
    const handled: string[] = [];
    for (const r of this.deps.store.openRequests(key)) {
      if (next !== "*" && !next.includes(r.userId)) continue;
      if (!this.deps.store.closeRequest(key, r.userId)) continue;
      handled.push(r.userId);
      await this.call("chat.update", { channel: s.channelId, ts: r.messageTs, text: grantedText(by, [r.userId], s.ownerId), blocks: [] });
      const job = JSON.parse(r.held) as SlackMessageJob;
      this.deps.store.forgetMessage(key, job.messageTs);
      try {
        await this.deliverHeld(s, job);
      } catch (error) {
        warn("computer.access_held_failed", error);
      }
    }
    // 5. Announce when more people can drive than before.
    const more = gained(prev, next);
    const added = more === "opened" ? [] : more.filter((id) => !handled.includes(id));
    if (more === "opened") await this.post(s, openedText(by, s.ownerId));
    else if (added.length) await this.post(s, grantedText(by, added, s.ownerId));
    // 6.
    this.deps.changed(key, by, encodeDrivers(prev), encodeDrivers(next));
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
   * A message in an existing session ("Messages" steps 2–4), after the
   * gateway's own commands and `!access`: whether it is delivered, and as
   * whom. A participant's message is held as context, and a mention of the
   * app at its start asks the owner to let them drive.
   */
  async message(job: SlackMessageJob, text: string, s: RoleSession): Promise<MessageGate> {
    const a: Access = { owner: s.ownerId, drivers: this.deps.store.drivers(s.key) ?? "*" };
    const u = await this.actor(job.userId, s.ownerId);
    const r = role(a, u);
    const command = commandAction(text);
    if (command !== undefined && command !== "access") {
      if (can(a, u, command)) return { deliver: true, role: r === "outsider" ? "participant" : r, context: false };
      const word = commandWord(text) ?? "";
      if (command === "settings") await this.ephemeral(s, job.userId, ownerCommandText(s.ownerId, word));
      else if (command === "instruct") await this.ephemeral(s, job.userId, driversCommandText(word));
      return { deliver: false, reason: "command_refused" };
    }
    if (r === "owner" || r === "driver") return { deliver: true, role: r, context: true };
    const mentioned = job.mentioned || job.channelType === "im";
    if (r === "outsider") {
      if (mentioned) await this.ephemeral(s, job.userId, onlyMembersText());
      return { deliver: false, reason: "outsider" };
    }
    this.deps.store.hold(s.key, {
      userId: job.userId,
      ts: job.messageTs,
      text: job.text,
      files: (job.files ?? []).map((f) => f.name ?? f.title ?? f.id),
    });
    if (mentioned) {
      if (this.deps.store.request(s.key, job.userId)) await this.ephemeral(s, job.userId, ownerDecidesText(s.ownerId));
      else await this.requestToDrive(s, job);
    }
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

  /** An allowed request's message, as its sender's own: through the credit gate, with the held context. */
  private async deliverHeld(s: RoleSession, job: SlackMessageJob): Promise<void> {
    if (!(await this.deps.admit(s.channelId, s.threadTs))) return;
    const forwarded = forwardedLinked(job.forwarded);
    await this.deliver(
      s.key,
      {
        channelId: s.channelId,
        threadTs: s.threadTs,
        messageTs: job.messageTs,
        userId: job.userId,
        text: job.text,
        ...(job.files?.length ? { files: job.files } : {}),
        mentioned: job.mentioned || job.channelType === "im",
        ...(forwarded.length ? { linked: forwarded } : {}),
        role: "driver" as const,
      },
      (d) => this.deps.deliver(d),
    );
  }

  // ---------------------------------------------------------------- request to drive

  /** S1 with its buttons in the thread, the request row, and S2 to the requester. */
  private async requestToDrive(s: RoleSession, job: SlackMessageJob): Promise<void> {
    const post = requestPost(s.key, s.ownerId, job.userId);
    const posted = await this.call("chat.postMessage", { channel: s.channelId, thread_ts: s.threadTs, ...post });
    if (!posted?.ok || !posted.ts) return;
    this.deps.store.addRequest(s.key, job.userId, posted.ts, JSON.stringify(job));
    await this.ephemeral(s, job.userId, requestSentText(s.ownerId));
  }

  /** `Allow` or `Not now` on a request (`ac:<k>:allow|deny:<requester>`), clicked by `userId`. */
  async answerRequest(key: string, verb: "allow" | "deny", requester: string, userId: string): Promise<void> {
    const s = this.deps.session(key);
    const a = this.access(key);
    if (!s || !a) return;
    const u = await this.actor(userId, a.owner);
    if (!can(a, u, "grant")) return this.ephemeral(s, userId, onlyGrantorAnswersText(a.owner));
    const request = this.deps.store.request(key, requester);
    if (request?.state !== "open") return;
    const by = this.by(a, u);
    if (verb === "deny") {
      if (this.deps.store.closeRequest(key, requester)) await this.call("chat.update", { channel: s.channelId, ts: request.messageTs, ...declinedPost(requester) });
      return;
    }
    // Everyone drives already: nothing to grant, only the request to answer.
    if (a.drivers === "*") {
      if (this.deps.store.closeRequest(key, requester)) {
        await this.call("chat.update", { channel: s.channelId, ts: request.messageTs, text: grantedText(by, [requester], a.owner), blocks: [] });
      }
      return;
    }
    await this.setDrivers(key, [...a.drivers, requester], by);
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
    const u = await this.actor(userId, a.owner);
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
      if (!can(a, await this.actor(userId, s.ownerId), "stop")) return false;
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
