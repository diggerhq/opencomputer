// Session roles in the self-host gateway (work 112): what each Slack event
// does per role. A message in a session is delivered, refused or held as
// context; a participant's mention asks the owner to let them drive; `Allow`
// and `Not now` answer that; `setDrivers` is the one write of `drivers`; held
// context rides the next delivered message; a stop by someone else is named.
//
// Who may do what is access.ts (`role`, `can`); the strings and Block Kit are
// access.ts and access-views.ts; SQL is access-store.ts. This file holds the
// order of the steps and the Slack calls. Delivery itself is routing.ts's
// `forward`, given as `deliver`, as secrets-ui.ts is given the hub.
//
// Member and admin here: a row in the people table, and that row's `admin`.

import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import {
  type Access,
  type AccessAction,
  type Actor,
  type ChangedBy,
  can,
  commandAction,
  commandWord,
  driversCommandText,
  type Drivers,
  encodeDrivers,
  gained,
  grantedText,
  normalize,
  notAskedText,
  onlyGrantorAnswersText,
  openedText,
  ownerCommandText,
  ownerDecidesText,
  requestSentText,
  restricted,
  type Role,
  role,
  sameDrivers,
  stoppedText,
} from '../access.js';
import { declinedPost, requestPost } from '../access-views.js';
import type { Delivery, SlackSessionSpec } from '../protocol.js';
import type { Linked, LinkedMessage } from '../links.js';
import type { Store } from './db.js';
import type { Msg } from './routing.js';
import { errorText, log } from '../log.js';

/** The role a delivered message carries (`participant` only on `stop` and `view` commands). */
export type DeliveredRole = NonNullable<Delivery['role']>;

/** A message as the gateway received it: what a request to drive keeps, to deliver it on `Allow`. */
export interface HeldMessage {
  m: Msg;
  /** Decoded, the bot's leading mention taken off. */
  text: string;
  /** As routing.ts reads it: mentioned, or in a DM or a code channel. */
  mentioned: boolean;
  /** The bot was mentioned only mid-message. */
  inline: boolean;
}

export interface AccessFlowDeps {
  store: Store;
  /** Deliver as an ordinary message from `held.m.user` (routing.ts `forward`), with their role. */
  deliver(spec: SlackSessionSpec, held: HeldMessage, role: DeliveredRole, client: WebClient): Promise<void>;
  /** A person's name, for held context (links.ts's cached directory). */
  name(client: WebClient, id: string): Promise<string>;
}

/** Whoever acts, as this gateway knows them. */
export function actor(store: Store, id: string): Actor {
  const p = store.person(id);
  return { id, member: p !== undefined, admin: p?.admin === true };
}

export function accessOf(store: Store, spec: SlackSessionSpec): Access {
  return { owner: spec.owner.slackUserId, drivers: store.access.drivers(spec.key) };
}

/** Who changed `drivers`: `admin` only when it is not the owner. */
export const changedBy = (spec: SlackSessionSpec, id: string): ChangedBy => ({ id, admin: id !== spec.owner.slackUserId });

const inThread = (spec: SlackSessionSpec) => (spec.kind === 'thread' && spec.threadTs ? { thread_ts: spec.threadTs } : {});

export function createAccessFlow({ store, deliver, name }: AccessFlowDeps) {
  // Held rows attached to a delivery the hub has not answered yet: the next message does not attach them again.
  const inFlight = new Set<number>();

  async function post(client: WebClient, spec: SlackSessionSpec, text: string, blocks?: unknown[]) {
    return client.chat
      .postMessage({ channel: spec.channel, ...inThread(spec), text, ...(blocks ? { blocks: blocks as KnownBlock[] } : {}) })
      .catch((e) => (log.warn('access post', spec.key, errorText(e)), undefined));
  }

  async function ephemeral(client: WebClient, spec: SlackSessionSpec, user: string, text: string) {
    await client.chat
      .postEphemeral({ channel: spec.channel, user, text, ...inThread(spec) })
      .catch((e) => log.warn('postEphemeral', e?.data?.error ?? e?.message));
  }

  async function update(client: WebClient, spec: SlackSessionSpec, ts: string, text: string, blocks: unknown[]) {
    await client.chat
      .update({ channel: spec.channel, ts, text, blocks: blocks as KnownBlock[] })
      .catch((e) => log.warn('access update', spec.key, errorText(e)));
  }

  /** The 🔒 reaction on a thread's first message: on when restricted. */
  async function marker(spec: SlackSessionSpec, on: boolean, client: WebClient) {
    if (spec.kind !== 'thread' || !spec.threadTs) return;
    const args = { channel: spec.channel, timestamp: spec.threadTs, name: 'lock' };
    await (on ? client.reactions.add(args) : client.reactions.remove(args)).catch((e) => {
      const code = e?.data?.error;
      if (code !== 'already_reacted' && code !== 'no_reaction') log.warn('access marker', spec.key, errorText(e));
    });
  }

  /**
   * A message in an existing session ("Messages" steps 2 to 4). The role to
   * deliver it with; `outsider` when it is dropped (routing.ts answers a
   * mention); undefined when it was answered or held here.
   */
  async function message(spec: SlackSessionSpec, h: HeldMessage, client: WebClient): Promise<Role | undefined> {
    const a = accessOf(store, spec);
    const u = actor(store, h.m.user!);
    const r = role(a, u);
    const needs = commandAction(h.text);
    if (needs !== undefined) {
      // `!access` never gets here (routing.ts); commands never carry context.
      if (can(a, u, needs as AccessAction)) return r;
      const word = commandWord(h.text) ?? '';
      if (needs === 'settings') await ephemeral(client, spec, u.id, ownerCommandText(a.owner, word));
      else if (needs === 'instruct') await ephemeral(client, spec, u.id, driversCommandText(word));
      return undefined;
    }
    if (can(a, u, 'instruct')) return r;
    if (r === 'outsider') return 'outsider';
    store.access.hold(spec.key, u.id, h.m.ts, h.text, (h.m.files ?? []).map((f) => f.name ?? f.id));
    // In a code channel every message is for the bot.
    if (!(spec.kind === 'channel' || (h.mentioned && !h.inline))) return undefined;
    if (store.access.request(spec.key, u.id)) return void (await ephemeral(client, spec, u.id, ownerDecidesText(a.owner)));
    await requestToDrive(spec, a, h, client);
    return undefined;
  }

  /** "Request to drive": the visible request, its row, and S2 to the requester. */
  async function requestToDrive(spec: SlackSessionSpec, a: Access, h: HeldMessage, client: WebClient) {
    const requester = h.m.user!;
    const p = requestPost(spec.key, a.owner, requester);
    const posted = await post(client, spec, p.text, p.blocks);
    if (!posted?.ts) return;
    store.access.putRequest(spec.key, requester, posted.ts, JSON.stringify(h));
    await ephemeral(client, spec, requester, requestSentText(a.owner));
  }

  /** `Allow` or `Not now` on a request, clicked by `clicker`. */
  async function answer(key: string, verb: 'allow' | 'deny', requester: string, clicker: string, client: WebClient) {
    const spec = store.session(key)?.spec;
    if (!spec) return log.warn('access answer for unknown session', key);
    const a = accessOf(store, spec);
    if (!can(a, actor(store, clicker), 'grant')) return ephemeral(client, spec, clicker, onlyGrantorAnswersText(a.owner));
    const q = store.access.request(key, requester);
    if (q?.state !== 'open') return;
    if (verb === 'deny') {
      store.access.closeRequest(key, requester);
      const p = declinedPost(requester);
      return update(client, spec, q.messageTs, p.text, p.blocks);
    }
    if (a.drivers !== '*') return setDrivers(spec, [...a.drivers, requester], changedBy(spec, clicker), client);
    // Everyone already drives (it cannot normally happen): the request is answered, the held message stays context.
    store.access.closeRequest(key, requester);
    await update(client, spec, q.messageTs, grantedText(changedBy(spec, clicker), [requester], a.owner), []);
  }

  /** "One transition": the only write of `drivers` after a session's first. */
  async function setDrivers(spec: SlackSessionSpec, want: Drivers, by: ChangedBy, client: WebClient) {
    const { owner, drivers: prev } = accessOf(store, spec);
    const next = normalize(owner, want);
    if (sameDrivers(prev, next)) return;
    store.access.writeDrivers(spec.key, next);
    if (restricted(prev) !== restricted(next)) await marker(spec, restricted(next), client);

    const after: Access = { owner, drivers: next };
    const handled: string[] = [];
    const deliveries: Promise<void>[] = [];
    for (const q of store.access.openRequests(spec.key)) {
      if (role(after, actor(store, q.userId)) !== 'driver') continue;
      store.access.closeRequest(spec.key, q.userId);
      await update(client, spec, q.messageTs, grantedText(by, [q.userId], owner), []);
      const held = JSON.parse(q.held) as HeldMessage;
      store.access.releaseTs(spec.key, held.m.ts);
      handled.push(q.userId);
      // Started in request order (forward keeps a session's order); not awaited before the announcement.
      deliveries.push(deliver(spec, held, 'driver', client).catch((e) => log.warn(`deliver held ${spec.key}:`, errorText(e))));
    }

    const g = gained(prev, next);
    if (g === 'opened') await post(client, spec, openedText(by, owner));
    else {
      const added = g.filter((id) => !handled.includes(id));
      if (added.length) await post(client, spec, grantedText(by, added, owner));
    }
    log.info('access', spec.key, by.id, by.admin, encodeDrivers(prev), encodeDrivers(next));
    await Promise.all(deliveries);
  }

  /** A new session's first `drivers` (the org default, or a spawning parent's), and its marker. */
  function begin(spec: SlackSessionSpec, drivers: Drivers, client: WebClient) {
    const d = normalize(spec.owner.slackUserId, drivers);
    store.access.writeDrivers(spec.key, d);
    if (restricted(d)) void marker(spec, true, client);
  }

  /**
   * The session's held context as one `Linked`, for a message about to be
   * delivered; `settle` once the hub answers: accepted (delivered or queued)
   * deletes the rows, anything else keeps them for the next message.
   */
  async function context(spec: SlackSessionSpec, client: WebClient): Promise<{ linked?: Linked; settle(accepted: boolean): void }> {
    const rows = store.access.held(spec.key).filter((r) => !inFlight.has(r.seq));
    if (!rows.length) return { settle() {} };
    for (const r of rows) inFlight.add(r.seq);
    const messages: LinkedMessage[] = [];
    // One at a time: the first lookup fills the directory's cache for the rest.
    for (const r of rows)
      messages.push({ name: await name(client, r.userId), ts: r.ts, text: r.text, ...(r.files ? { files: r.files } : {}), ...(r.skipped ? { skipped: r.skipped } : {}) });
    return {
      linked: { url: '', ok: true, where: '', context: true, messages },
      settle(accepted) {
        for (const r of rows) inFlight.delete(r.seq);
        if (accepted) store.access.release(rows.map((r) => r.seq));
      },
    };
  }

  /** A prompt button's clicker who may not answer it (S6), in the session's thread. */
  const notAsked = (spec: SlackSessionSpec, user: string, client: WebClient) => ephemeral(client, spec, user, notAskedText(spec.owner.slackUserId));

  /** S9: someone other than the owner stopped the turn with the native button. */
  const stopped = (spec: SlackSessionSpec, user: string, client: WebClient) => post(client, spec, stoppedText(user)).then(() => {});

  return { message, answer, setDrivers, begin, context, notAsked, stopped };
}

export type AccessFlow = ReturnType<typeof createAccessFlow>;
