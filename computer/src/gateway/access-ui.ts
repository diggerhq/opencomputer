// Session access in Slack (work 112): `!access` typed in a thread, the `ac:`
// buttons (Access, Change…, Allow, Not now) and the access modal's
// submission. Every answer is private (an ephemeral, a modal or a modal error)
// except what setDrivers posts when more people can drive.
//
//   !access                            the state line; `Change…` for someone who can grant
//   !access open | owner | @a @b       replace who drives, then the state line
//   !access add @a | remove @a         edit the list (not on an open session: the usage)
//   !access default open | owner       the org default for new sessions (admins)
//
// Views and strings are access-views.ts and access.ts; access-flow.ts's
// setDrivers checks and makes a change, and this file only says its refusals.
// Someone not in the people table gets nothing from a button or the modal
// (routing.ts turns them away before `!access`).

import type { WebClient } from '@slack/web-api';
import type { KnownBlock, View } from '@slack/types';
import {
  ACCESS_USAGE,
  accessCommandNeeds,
  can,
  defaultChangedText,
  editDrivers,
  noSessionText,
  onlyAdminDefaultText,
  onlyGrantorChangesText,
  parseAccessCommand,
  stateText,
} from '../access.js';
import { type AccessSubmission, accessView, decodeAccessId, readSubmission, statePost, submittedKey } from '../access-views.js';
import type { SlackSessionSpec } from '../protocol.js';
import type { Store } from './db.js';
import type { Msg } from './routing.js';
import type { ClickBody } from './secrets-ui.js';
import { type AccessFlow, accessOf, actor, changedBy, refusedText } from './access-flow.js';
import { errorText, log } from '../log.js';

export interface AccessUiDeps {
  store: Store;
  flow: AccessFlow;
  /** A person's name, for the modal's member error (plain text: a mention would not render). */
  name(client: WebClient, id: string): Promise<string>;
}

/** A modal answers within 3 s: a name not found by then is shown as the id. */
const NAME_WAIT_MS = 1_500;

export function createAccessUi({ store, flow, name }: AccessUiDeps) {
  /** `!access …` from `m.user`, in `spec`'s thread or where no session is. Never delivered. */
  async function command(text: string, m: Msg, spec: SlackSessionSpec | undefined, client: WebClient) {
    const say = (t: string, blocks?: unknown[]) =>
      client.chat
        .postEphemeral({ channel: m.channel, user: m.user!, text: t, ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}), ...(blocks ? { blocks: blocks as KnownBlock[] } : {}) })
        .then(() => {})
        .catch((e) => log.warn('postEphemeral', e?.data?.error ?? e?.message));
    const c = parseAccessCommand(text);
    const u = actor(store, m.user!);
    if (c.kind === 'default') {
      if (!(u.admin && u.member)) return say(onlyAdminDefaultText());
      store.access.setAccessDefault(c.value);
      log.info('access default', u.id, c.value);
      return say(defaultChangedText(c.value));
    }
    if (!spec) return say(noSessionText());
    const a = accessOf(store, spec);
    if (accessCommandNeeds(c) === 'view') {
      // Like `!help` from an outsider: no answer.
      if (!can(a, u, 'view')) return;
      if (c.kind === 'usage') return say(ACCESS_USAGE);
      const p = statePost(spec.key, a, can(a, u, 'grant'));
      return say(p.text, p.blocks);
    }
    if (c.kind === 'show' || c.kind === 'usage') return; // answered above; this narrows the type
    if (!can(a, u, 'grant')) return say(onlyGrantorChangesText(a.owner));
    const r = flow.setDrivers(spec, (d) => editDrivers(d, c), changedBy(spec, u.id), client);
    if ('refused' in r) return say(refusedText(r));
    await r.after;
    return say(stateText(accessOf(store, spec)));
  }

  /** An `ac:` button: Access or Change… opens the modal; Allow and Not now answer a request. */
  async function click(actionId: string, body: ClickBody, client: WebClient) {
    const id = decodeAccessId(actionId);
    const userId = body.user?.id;
    if (!id || !userId) return log.warn('unknown access action', actionId);
    if (!store.person(userId)) return;
    if (id.verb !== 'open') return flow.answer(id.sessionKey, id.verb, id.userId!, userId, client);
    const row = store.session(id.sessionKey);
    if (!row) {
      const channel = body.channel?.id ?? body.container?.channel_id;
      const thread = body.container?.thread_ts;
      if (channel)
        await client.chat
          .postEphemeral({ channel, user: userId, text: noSessionText(), ...(thread ? { thread_ts: thread } : {}) })
          .catch((e) => log.warn('postEphemeral', e?.data?.error ?? e?.message));
      return;
    }
    const view = accessView(id.sessionKey, accessOf(store, row.spec), actor(store, userId));
    if (!view) return;
    await client.views.open({ trigger_id: body.trigger_id ?? '', view: view as unknown as View }).catch((e) => log.warn('views.open', errorText(e)));
  }

  /** The modal's submission: errors to show in it, or the change, made, whose Slack follow-up `done` awaits after the ack. */
  async function submit(
    view: AccessSubmission,
    userId: string,
    client: WebClient,
  ): Promise<{ errors: Record<string, string> } | { done(): Promise<void> } | undefined> {
    const key = submittedKey(view);
    const spec = key ? store.session(key)?.spec : undefined;
    if (!spec || !store.person(userId)) return undefined;
    const s = readSubmission(view, accessOf(store, spec), actor(store, userId));
    if (!s.ok) return { errors: s.errors };
    // Made now, so a refusal goes back in the ack; Slack hears of it after (`done`).
    const r = flow.setDrivers(spec, () => s.drivers, changedBy(spec, userId), client);
    if (!('refused' in r)) return { done: () => r.after };
    if (r.refused !== 'member') return { errors: { people: refusedText(r) } };
    const { id } = r;
    const wait = new Promise<string>((ok) => setTimeout(() => ok(id), NAME_WAIT_MS).unref());
    return { errors: { people: refusedText(r, await Promise.race([name(client, id), wait])) } };
  }

  return { command, click, submit };
}

export type AccessUi = ReturnType<typeof createAccessUi>;
