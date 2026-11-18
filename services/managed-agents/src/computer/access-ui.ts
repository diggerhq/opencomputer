// Session roles' controls in the computer's gateway (work 112, "Controls"):
// the `Access` button's modal and its submission, the request buttons, and
// `!access`. Views and strings are access-views.ts and access.ts; every
// change of `drivers` goes through `AccessFlow.setDrivers`.

import {
  type AccessCommand,
  ACCESS_USAGE,
  accessCommandNeeds,
  can,
  defaultChangedText,
  editDrivers,
  noSessionText,
  normalize,
  notMemberText,
  onlyAdminDefaultText,
  onlyGrantorChangesText,
  overLimit,
  parseAccessCommand,
  tooManyPeopleText,
} from "./access.js";
import { type AccessSubmission, accessView, decodeAccessId, readSubmission, statePost, submittedKey } from "./access-views.js";
import type { AccessFlow } from "./access-flow.js";
import type { AccessStore } from "./access-store.js";
import { type SlackResult, isWorkspaceMember } from "./slack.js";

/** Where an answer goes: the person, and the channel and thread they acted in. */
export interface AccessWhere {
  userId: string;
  channelId: string;
  threadTs?: string;
}

export interface AccessUiDeps {
  flow: AccessFlow;
  store: AccessStore;
  slack(method: string, body: Record<string, unknown>): Promise<SlackResult>;
  teamId(): string;
  /** A person's display name (cached), or their id. */
  name(slackUserId: string): Promise<string>;
}

/** Follow-up work the Durable Object runs after it answered Slack (`waitUntil`). */
export type After = () => Promise<void>;

export class AccessUi {
  constructor(private readonly deps: AccessUiDeps) {}

  /**
   * A click on an `ac:` button: `open` shows the modal now (its `trigger_id`
   * lasts 3 s); `allow` and `deny` are returned as `after`, for Slack's 3 s ack.
   */
  async action(actionId: string, triggerId: string | undefined, where: AccessWhere): Promise<{ after?: After }> {
    const id = decodeAccessId(actionId);
    if (!id) return {};
    if (id.verb !== "open") {
      const verb = id.verb;
      const requester = id.userId ?? "";
      return { after: () => this.deps.flow.answerRequest(id.sessionKey, verb, requester, where.userId) };
    }
    const a = this.deps.flow.access(id.sessionKey);
    if (!a) {
      await this.deps.flow.ephemeral(threadOf(where), where.userId, noSessionText());
      return {};
    }
    const view = accessView(id.sessionKey, a, await this.deps.flow.actor(where.userId, a.owner));
    if (view && triggerId) await this.call("views.open", { trigger_id: triggerId, view });
    return {};
  }

  /** The modal's `Save`: `errors` keep it open; `after` is the change. */
  async submit(view: AccessSubmission, userId: string): Promise<{ errors?: Record<string, string>; after?: After }> {
    const key = submittedKey(view);
    const a = key ? this.deps.flow.access(key) : undefined;
    if (!key || !a) return { errors: { who: noSessionText() } };
    const u = await this.deps.flow.actor(userId, a.owner);
    const read = readSubmission(view, a, u);
    if (!read.ok) return { errors: read.errors };
    for (const id of read.ids) {
      if (!(await this.member(id))) return { errors: { people: notMemberText(await this.deps.name(id)) } };
    }
    return { after: () => this.deps.flow.setDrivers(key, read.drivers, this.deps.flow.by(a, u)) };
  }

  /** `!access …`, never delivered. All answers are ephemerals to the typer, in the thread. */
  async command(text: string, ctx: AccessWhere & { session?: { key: string } }): Promise<void> {
    const c = parseAccessCommand(text);
    const where = threadOf(ctx);
    const say = (answer: string, blocks?: unknown[]) => this.deps.flow.ephemeral(where, ctx.userId, answer, blocks);
    if (c.kind === "default") {
      const u = await this.deps.flow.actor(ctx.userId);
      if (!u.admin || !u.member) return say(onlyAdminDefaultText());
      this.deps.store.setAccessDefault(c.value);
      return say(defaultChangedText(c.value));
    }
    const key = ctx.session?.key;
    const a = key ? this.deps.flow.access(key) : undefined;
    if (!key || !a) return say(noSessionText());
    const u = await this.deps.flow.actor(ctx.userId, a.owner);
    if (accessCommandNeeds(c) === "view") {
      if (!can(a, u, "view")) return say(onlyGrantorChangesText(a.owner));
      if (c.kind === "usage") return say(ACCESS_USAGE);
      const post = statePost(key, a, can(a, u, "grant"));
      return say(post.text, post.blocks);
    }
    if (!can(a, u, "grant")) return say(onlyGrantorChangesText(a.owner));
    const edit = c as Extract<AccessCommand, { kind: "set" | "add" | "remove" }>;
    const next = normalize(a.owner, editDrivers(a.drivers, edit));
    if (overLimit(next)) return say(tooManyPeopleText());
    // Only people this adds are checked: someone already named stays until removed.
    const before = a.drivers === "*" ? [] : a.drivers;
    for (const id of next === "*" ? [] : next.filter((id) => !before.includes(id))) {
      if (!(await this.member(id))) return say(notMemberText(await this.deps.name(id)));
    }
    await this.deps.flow.setDrivers(key, next, this.deps.flow.by(a, u));
    const after = this.deps.flow.access(key) ?? a;
    const post = statePost(key, after, true);
    return say(post.text, post.blocks);
  }

  private member(userId: string): Promise<boolean> {
    return isWorkspaceMember((method, body) => this.deps.slack(method, body), this.deps.teamId(), userId);
  }

  private async call(method: string, body: Record<string, unknown>): Promise<void> {
    try {
      const r = await this.deps.slack(method, body);
      if (!r.ok) console.warn(JSON.stringify({ level: "warn", event: "computer.access_slack_failed", message: `${method}: ${r.error ?? "unknown_error"}` }));
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.access_slack_failed", message: error instanceof Error ? error.message : String(error) }));
    }
  }
}

/** An ephemeral's place: the thread, or the channel's top level when there is none. */
function threadOf(where: AccessWhere): { channelId: string; threadTs?: string } {
  return { channelId: where.channelId, ...(where.threadTs ? { threadTs: where.threadTs } : {}) };
}
