// Session roles in the self-host gateway (work 112): what each Slack event
// does per role. A message in a session is delivered, refused or held as
// context; a participant's mention asks the owner to let them drive; `Allow`
// and `Not now` answer that; `setDrivers` is the one write of `drivers`; held
// context rides the next delivered message; a stop by someone else is named;
// a prompt's button is answered by whoever it may be.
//
// Who may do what is access.ts (`role`, `can`); the strings and Block Kit are
// access.ts and access-views.ts; SQL is access-store.ts. This file holds the
// order of the steps and the Slack calls. Delivery itself is routing.ts's
// `forward`, given as `deliver`, as secrets-ui.ts is given the hub.
//
// Member and admin here: a row in the people table, and that row's `admin`.
// Only people in that table get this far (routing.ts and access-ui.ts turn
// anyone else away at each entry point), so the one acting is never an
// `outsider` here; a person named as a driver may still not be a member.

import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import {
  ACCESS_USAGE,
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
  mention,
  normalize,
  notAskedText,
  notMemberText,
  onlyGrantorAnswersText,
  openedText,
  overLimit,
  ownerCommandText,
  ownerDecidesText,
  requestSentText,
  restricted,
  role,
  sameDrivers,
  stoppedText,
  tooManyPeopleText,
} from '../access.js';
import { declinedPost, requestPost } from '../access-views.js';
import { type Delivery, NOT_ASKED, type SlackSessionSpec } from '../protocol.js';
import type { Linked, LinkedMessage } from '../links.js';
import type { AccessRequest } from './access-store.js';
import type { Store } from './db.js';
import type { Hub, Reply } from './hosts.js';
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
  hub: Pick<Hub, 'stop' | 'action'>;
  /** Deliver as an ordinary message from `held.m.user` (routing.ts `forward`), with their role. */
  deliver(spec: SlackSessionSpec, held: HeldMessage, role: DeliveredRole, client: WebClient): Promise<void>;
  /** A person's name, for held context (links.ts's cached directory). */
  name(client: WebClient, id: string): Promise<string>;
}

/**
 * What `setDrivers` did: the change is written (`after` settles once Slack has
 * been told), or why not: `usage` the edit does not apply to the current value
 * (add or remove on an open session), `limit` more than MAX_DRIVERS, `member`
 * a newly named id that is not a full member.
 */
export type DriversChange = { ok: true; after: Promise<void> } | { refused: 'usage' | 'limit' } | { refused: 'member'; id: string };

/** A refusal as words; `name`: how to show a `member` refusal's id (a mention, or a plain name in a modal). */
export function refusedText(r: Extract<DriversChange, { refused: string }>, name = r.refused === 'member' ? mention(r.id) : ''): string {
  return r.refused === 'usage' ? ACCESS_USAGE : r.refused === 'limit' ? tooManyPeopleText() : notMemberText(name);
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

export function createAccessFlow({ store, hub, deliver, name }: AccessFlowDeps) {
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
   * A message in an existing session ("Messages" steps 2 to 4), from a person
   * in the people table: the role to deliver it with, or undefined when it was
   * refused or held here. Every command but `!access` passes here, gateway
   * commands (`!secret`, `!var`) too: they read as `instruct`.
   */
  async function message(spec: SlackSessionSpec, h: HeldMessage, client: WebClient): Promise<DeliveredRole | undefined> {
    const a = accessOf(store, spec);
    const u = actor(store, h.m.user!);
    // Never `outsider`: the sender is in the people table (see the header).
    const r = role(a, u) as DeliveredRole;
    const needs = commandAction(h.text);
    if (needs !== undefined) {
      // Commands never carry context.
      if (can(a, u, needs as AccessAction)) return r;
      const word = commandWord(h.text) ?? '';
      await ephemeral(client, spec, u.id, needs === 'settings' ? ownerCommandText(a.owner, word) : driversCommandText(word));
      return undefined;
    }
    if (can(a, u, 'instruct')) return r;
    store.access.hold(spec.key, u.id, h.m.ts, h.text, (h.m.files ?? []).map((f) => f.name ?? f.id));
    // In a code channel every message is for the bot.
    if (spec.kind === 'channel' || (h.mentioned && !h.inline)) await requestToDrive(spec, a.owner, h, client);
    return undefined;
  }

  /** "Request to drive": its row first (the guard against a second), then the visible request, then S2; S2b when there was one. */
  async function requestToDrive(spec: SlackSessionSpec, owner: string, h: HeldMessage, client: WebClient) {
    const requester = h.m.user!;
    if (!store.access.putRequest(spec.key, requester, JSON.stringify(h))) return ephemeral(client, spec, requester, ownerDecidesText(owner));
    const p = requestPost(spec.key, owner, requester);
    const posted = await post(client, spec, p.text, p.blocks);
    if (!posted?.ts) return store.access.dropRequest(spec.key, requester);
    store.access.requestPosted(spec.key, requester, posted.ts);
    await ephemeral(client, spec, requester, requestSentText(owner));
  }

  /** `Allow` or `Not now` on a request, clicked by `clicker` (a person). */
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
    const by = changedBy(spec, clicker);
    const r = setDrivers(spec, (d) => (d === '*' ? undefined : [...d, requester]), by, client);
    if (!('refused' in r)) return r.after;
    if (r.refused !== 'usage') return ephemeral(client, spec, clicker, refusedText(r));
    // Everyone already drives (it cannot normally happen): the request is answered, the held message stays context.
    store.access.closeRequest(key, requester);
    await update(client, spec, q.messageTs, grantedText(by, [requester], a.owner), []);
  }

  /**
   * "One transition": the only write of `drivers` after a session's first.
   * `edit` is applied to the value read here; reading, checking, writing and
   * closing the requests it answers happen with no await between them, so two
   * changes never interleave. Slack is told after, in `after`.
   */
  function setDrivers(spec: SlackSessionSpec, edit: (current: Drivers) => Drivers | undefined, by: ChangedBy, client: WebClient): DriversChange {
    const { owner, drivers: prev } = accessOf(store, spec);
    const want = edit(prev);
    if (want === undefined) return { refused: 'usage' };
    const next = normalize(owner, want);
    if (overLimit(next)) return { refused: 'limit' };
    const added = next === '*' ? [] : next.filter((id) => prev === '*' || !prev.includes(id));
    const stranger = added.find((id) => !actor(store, id).member);
    if (stranger) return { refused: 'member', id: stranger };
    if (sameDrivers(prev, next)) return { ok: true, after: Promise.resolve() };
    store.access.writeDrivers(spec.key, next);
    const after: Access = { owner, drivers: next };
    const granted = store.access.openRequests(spec.key).filter((q) => role(after, actor(store, q.userId)) === 'driver');
    for (const q of granted) {
      store.access.closeRequest(spec.key, q.userId);
      store.access.releaseTs(spec.key, (JSON.parse(q.held) as HeldMessage).m.ts);
    }
    log.info('access', spec.key, by.id, by.admin, encodeDrivers(prev), encodeDrivers(next));
    return { ok: true, after: tell(spec, prev, next, granted, by, client) };
  }

  /** What follows a change in Slack: the marker, the answered requests and their held messages, the announcement. */
  async function tell(spec: SlackSessionSpec, prev: Drivers, next: Drivers, granted: AccessRequest[], by: ChangedBy, client: WebClient) {
    const owner = spec.owner.slackUserId;
    if (restricted(prev) !== restricted(next)) await marker(spec, restricted(next), client);
    const deliveries: Promise<void>[] = [];
    for (const q of granted) {
      await update(client, spec, q.messageTs, grantedText(by, [q.userId], owner), []);
      // Started in request order (forward keeps a session's order); not awaited before the announcement.
      deliveries.push(deliver(spec, JSON.parse(q.held) as HeldMessage, 'driver', client).catch((e) => log.warn(`deliver held ${spec.key}:`, errorText(e))));
    }
    const g = gained(prev, next);
    if (g === 'opened') await post(client, spec, openedText(by, owner));
    else {
      const added = g.filter((id) => !granted.some((q) => q.userId === id));
      if (added.length) await post(client, spec, grantedText(by, added, owner));
    }
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
   * deletes every row up to the newest attached, those left out as skipped
   * too, so none arrives later out of order; anything else keeps them.
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
        if (accepted) store.access.release(spec.key, rows[rows.length - 1].seq);
      },
    };
  }

  /** Slack's stop button, clicked by `user` (a person) or by nobody Slack names ("Stop"): stop, then S9 when it was not the owner. */
  async function stop(spec: SlackSessionSpec, user: string | undefined, client: WebClient) {
    const r = await hub.stop(spec.key);
    if (!r.ok) return log.warn(`stop ${spec.key}: ${r.error}`);
    if (user && user !== spec.owner.slackUserId) await post(client, spec, stoppedText(user));
  }

  /** A prompt's button, clicked by `user` (a person): to the host with their role, or S6. The host's answer otherwise. */
  async function click(spec: SlackSessionSpec, promptId: string, value: string, user: string, client: WebClient): Promise<Reply | 'queued' | undefined> {
    const a = accessOf(store, spec);
    const u = actor(store, user);
    const notAsked = () => ephemeral(client, spec, user, notAskedText(a.owner));
    if (!can(a, u, 'answer')) return void (await notAsked());
    const r = await hub.action(spec.key, promptId, value, user, role(a, u) === 'owner' ? 'owner' : 'driver');
    if (r !== 'queued' && !r.ok && r.error === NOT_ASKED) return void (await notAsked());
    return r;
  }

  return { message, answer, setDrivers, begin, context, stop, click };
}

export type AccessFlow = ReturnType<typeof createAccessFlow>;
