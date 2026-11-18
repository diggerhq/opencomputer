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
  onlyAdminDefaultText,
  onlyGrantorChangesText,
  parseAccessCommand,
} from "./access.js";
import { type AccessSubmission, accessView, decodeAccessId, readSubmission, statePost, submittedKey } from "./access-views.js";
import type { AccessFlow } from "./access-flow.js";
import type { AccessStore } from "./access-store.js";
import type { SlackResult } from "./slack.js";
import { LOOKUP_FAILED_TEXT } from "./threads.js";

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
    const u = await this.deps.flow.clicker(threadOf(where), where.userId, a.owner);
    const view = u && accessView(id.sessionKey, a, u);
    if (view && triggerId) await this.call("views.open", { trigger_id: triggerId, view });
    return {};
  }

  /**
   * The modal's `Save`: `errors` keep it open; `after` is the change, whose
   * refusal (someone not a member, too many) is an ephemeral in the session's
   * thread: its lookups are `setDrivers`' and do not fit Slack's 3 s.
   */
  async submit(view: AccessSubmission, userId: string): Promise<{ errors?: Record<string, string>; after?: After }> {
    const key = submittedKey(view);
    const a = key ? this.deps.flow.access(key) : undefined;
    if (!key || !a) return { errors: { who: noSessionText() } };
    let u;
    try {
      u = await this.deps.flow.actor(userId, a.owner);
    } catch {
      return { errors: { who: LOOKUP_FAILED_TEXT } };
    }
    const read = readSubmission(view, a, u);
    if (!read.ok) return { errors: read.errors };
    const by = this.deps.flow.by(a, u);
    return {
      after: async () => {
        const s = this.deps.flow.session(key);
        if (!s) return;
        let answer: string | undefined;
        try {
          const refused = await this.deps.flow.setDrivers(key, () => read.drivers, by);
          if (refused) answer = await this.deps.flow.refusalText(refused);
        } catch {
          answer = LOOKUP_FAILED_TEXT;
        }
        if (answer) await this.deps.flow.ephemeral(s, userId, answer);
      },
    };
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
      // An outsider cannot view, and is not answered (as `!access` self-hosted).
      if (!can(a, u, "view")) return;
      if (c.kind === "usage") return say(ACCESS_USAGE);
      const post = statePost(key, a, can(a, u, "grant"));
      return say(post.text, post.blocks);
    }
    if (!can(a, u, "grant")) return say(onlyGrantorChangesText(a.owner));
    const edit = c as Extract<AccessCommand, { kind: "set" | "add" | "remove" }>;
    const refused = await this.deps.flow.setDrivers(key, (current) => editDrivers(current, edit), this.deps.flow.by(a, u));
    if (refused) return say(await this.deps.flow.refusalText(refused));
    const after = this.deps.flow.access(key) ?? a;
    const post = statePost(key, after, true);
    return say(post.text, post.blocks);
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
