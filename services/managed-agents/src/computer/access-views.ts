// Session roles in Slack's Block Kit (work 112): the request to drive, the
// Access button, the access modal and its submission, the `!access` answer,
// and the `ac:` ids of their buttons. Plain JSON in, plain JSON out, shaped so
// Bolt's `KnownBlock`/`View` accept it (access.test.ts checks) and a raw Web
// API call can send it as is.
//
// Pure, and byte-identical in calvin (computer/src/access-views.ts) and in
// managed-agents (src/computer/access-views.ts), like access.ts. No Buffer:
// the managed-agents copy runs in a Worker.
//
// Button ids: ac:<base64url(sessionKey)>:<verb>[:<userId>]. `open` (the Access
// and Change… buttons) carries no user; `allow` and `deny` carry the requester.

import {
  type Access,
  type Actor,
  can,
  declinedText,
  normalize,
  onlyGrantorChangesText,
  overLimit,
  pickSomeoneText,
  requestText,
  stateText,
  tooManyPeopleText,
  type Drivers,
} from './access.js';

export type AccessVerb = 'open' | 'allow' | 'deny';

function toBase64url(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): string | undefined {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

export function encodeAccessId(sessionKey: string, verb: AccessVerb, userId?: string): string {
  return `ac:${toBase64url(sessionKey)}:${verb}${userId ? `:${userId}` : ''}`;
}

/** Undefined for anything that is not an `ac:` id: `open` without a user, `allow`/`deny` with one. */
export function decodeAccessId(actionId: string): { sessionKey: string; verb: AccessVerb; userId?: string } | undefined {
  const m = actionId.match(/^ac:([A-Za-z0-9_-]+):(?:(open)|(allow|deny):([A-Z0-9]+))$/);
  const sessionKey = m?.[1] && fromBase64url(m[1]);
  if (!m || !sessionKey) return undefined;
  if (m[2]) return { sessionKey, verb: 'open' };
  return { sessionKey, verb: m[3] as AccessVerb, userId: m[4] };
}

// ---------------------------------------------------------------- Block Kit shapes

export interface PlainText {
  type: 'plain_text';
  text: string;
}
export interface Mrkdwn {
  type: 'mrkdwn';
  text: string;
}
export interface Button {
  type: 'button';
  text: PlainText;
  action_id: string;
  value: string;
  style?: 'primary' | 'danger';
}
export interface Option {
  text: PlainText;
  value: string;
}
export interface SectionBlock {
  type: 'section';
  text: Mrkdwn;
}
export interface ActionsBlock {
  type: 'actions';
  elements: Button[];
}
export interface ContextBlock {
  type: 'context';
  elements: Mrkdwn[];
}
export interface RadioInputBlock {
  type: 'input';
  block_id: string;
  label: PlainText;
  element: { type: 'radio_buttons'; action_id: string; options: Option[]; initial_option?: Option };
}
export interface UsersInputBlock {
  type: 'input';
  block_id: string;
  optional: boolean;
  label: PlainText;
  hint: PlainText;
  element: { type: 'multi_users_select'; action_id: string; max_selected_items: number; initial_users?: string[] };
}
export type AccessBlock = SectionBlock | ActionsBlock | ContextBlock | RadioInputBlock | UsersInputBlock;
export interface AccessModal {
  type: 'modal';
  callback_id: string;
  private_metadata?: string;
  title: PlainText;
  submit?: PlainText;
  close: PlainText;
  blocks: AccessBlock[];
}
/** A message: `text` (also the notification) and its blocks. */
export interface AccessPost {
  text: string;
  blocks: AccessBlock[];
}

const plain = (text: string): PlainText => ({ type: 'plain_text', text });
const section = (text: string): SectionBlock => ({ type: 'section', text: { type: 'mrkdwn', text } });
const button = (text: string, action_id: string, value: string, style?: 'primary'): Button => ({
  type: 'button',
  text: plain(text),
  action_id,
  value,
  ...(style ? { style } : {}),
});

// ---------------------------------------------------------------- messages

/** S1 with `Allow` and `Not now`, posted in the thread. */
export function requestPost(sessionKey: string, owner: string, requester: string): AccessPost {
  const text = requestText(owner, requester);
  return {
    text,
    blocks: [
      section(text),
      {
        type: 'actions',
        elements: [
          button('Allow', encodeAccessId(sessionKey, 'allow', requester), 'allow', 'primary'),
          button('Not now', encodeAccessId(sessionKey, 'deny', requester), 'deny'),
        ],
      },
    ],
  };
}

/** The request message after `Not now`: one context block with S4. */
export function declinedPost(requester: string): AccessPost {
  const text = declinedText(requester);
  return { text, blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text }] }] };
}

/** The second block of a session's first reply (`SlackThread.intro()`). */
export function accessButtonBlock(sessionKey: string): ActionsBlock {
  return { type: 'actions', elements: [button('Access', encodeAccessId(sessionKey, 'open'), 'open')] };
}

/** `!access`: S10, with a `Change…` button for someone who can `grant`. */
export function statePost(sessionKey: string, a: Access, grant: boolean): AccessPost {
  const text = stateText(a);
  return {
    text,
    blocks: grant ? [section(text), { type: 'actions', elements: [button('Change…', encodeAccessId(sessionKey, 'open'), 'open')] }] : [section(text)],
  };
}

// ---------------------------------------------------------------- the modal

export const ACCESS_VIEW = 'access';
const TITLE = 'Session access';
type Who = 'open' | 'owner' | 'people';

/**
 * For someone who can `grant`. `adminNotOwner`: an admin who is not the owner
 * is shown `Only the owner` where the owner reads `Only me`.
 */
export function grantorView(sessionKey: string, a: Access, adminNotOwner: boolean): AccessModal {
  const options: Record<Who, Option> = {
    open: { text: plain('Everyone in this thread'), value: 'open' },
    owner: { text: plain(adminNotOwner ? 'Only the owner' : 'Only me'), value: 'owner' },
    people: { text: plain('Specific people'), value: 'people' },
  };
  const current: Who = a.drivers === '*' ? 'open' : a.drivers.length ? 'people' : 'owner';
  return {
    type: 'modal',
    callback_id: ACCESS_VIEW,
    private_metadata: JSON.stringify({ key: sessionKey }),
    title: plain(TITLE),
    submit: plain('Save'),
    close: plain('Cancel'),
    blocks: [
      section(`This session runs as <@${a.owner}>: their repositories, secrets and credentials.`),
      {
        type: 'input',
        block_id: 'who',
        label: plain('Who can drive'),
        element: { type: 'radio_buttons', action_id: 'v', options: [options.open, options.owner, options.people], initial_option: options[current] },
      },
      {
        type: 'input',
        block_id: 'people',
        optional: true,
        label: plain('People'),
        hint: plain('Used with “Specific people”. The owner can always drive.'),
        element: {
          type: 'multi_users_select',
          action_id: 'v',
          max_selected_items: 50,
          ...(a.drivers !== '*' && a.drivers.length ? { initial_users: [...a.drivers] } : {}),
        },
      },
    ],
  };
}

/** For someone who can `view` but not `grant`: the state line, nothing to submit. */
export function readOnlyView(a: Access): AccessModal {
  return { type: 'modal', callback_id: ACCESS_VIEW, title: plain(TITLE), close: plain('Close'), blocks: [section(stateText(a))] };
}

/** The view `u` gets on `ac:<k>:open`: undefined when they cannot `view`. */
export function accessView(sessionKey: string, a: Access, u: Actor): AccessModal | undefined {
  if (can(a, u, 'grant')) return grantorView(sessionKey, a, u.id !== a.owner);
  return can(a, u, 'view') ? readOnlyView(a) : undefined;
}

/** The fields of a submitted access modal this reads: `state.values[block][action]`. */
export interface AccessSubmission {
  private_metadata?: string;
  state?: { values?: Record<string, Record<string, { selected_option?: { value?: string } | null; selected_users?: string[] | null }>> };
}

/** The session key in a submission's metadata. */
export function submittedKey(view: AccessSubmission): string | undefined {
  try {
    const key: unknown = JSON.parse(view.private_metadata ?? '').key;
    return typeof key === 'string' ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A submission read against the session: the normalized `drivers` to set, or
 * the `response_action: 'errors'` to answer. Does not check membership: the
 * caller refuses a picked id that is not a full member with `notMemberText` on
 * `people` (`ids` lists the picked ones to check).
 */
export function readSubmission(
  view: AccessSubmission,
  a: Access,
  u: Actor,
): { ok: true; drivers: Drivers; ids: string[] } | { ok: false; errors: Record<string, string> } {
  if (!can(a, u, 'grant')) return { ok: false, errors: { who: onlyGrantorChangesText(a.owner) } };
  const values = view.state?.values ?? {};
  const who = values.who?.v?.selected_option?.value;
  if (who === 'open') return { ok: true, drivers: '*', ids: [] };
  if (who === 'owner') return { ok: true, drivers: [], ids: [] };
  const drivers = normalize(a.owner, values.people?.v?.selected_users ?? []);
  if (drivers === '*' || !drivers.length) return { ok: false, errors: { people: pickSomeoneText() } };
  if (overLimit(drivers)) return { ok: false, errors: { people: tooManyPeopleText() } };
  return { ok: true, drivers, ids: [...drivers] };
}
