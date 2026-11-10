// Secrets in Slack (work 046): how people give sessions secrets without ever
// typing one into a message. Messages persist in Slack's history and reach the
// bot in event payloads; a modal's input comes back only to the app, in
// `view_submission`.
//
//   !secret                       names (never values) this session gets, by scope
//   !secret NAME [file]           an ephemeral "Enter NAME" button → modal: value, scope, file
//   !secret rm NAME [session|me|workspace]
//   request_secret (a session)    the same button, posted in the thread; once set,
//                                 the session gets a message so it continues
//
// Scopes: this session (anyone enabled), just me (all sessions the person
// owns), workspace (every session; admins only). Handled here, not by the runner:
// the gateway holds the values and Slack modals need its interactivity.

import type { WebClient } from '@slack/web-api';
import type { KnownBlock, View } from '@slack/types';
import type { SlackPerson, SecretRequest, SecretScope, SlackSessionSpec } from '../protocol.js';
import { secretNameProblem } from '../secret-names.js';
import type { Store } from './db.js';
import type { Hub } from './hosts.js';
import { MAX_VALUE, type Vault } from './vault.js';
import type { Msg } from './routing.js';
import { errorText, log } from '../log.js';

export const SECRET_VIEW = 'calvin_secret';
/** Slack's limit for a plain_text_input. */
const INPUT_MAX = 3000;

const HELP = [
  '*Secrets* (values never go in messages)',
  '`!secret NAME`: set or replace `$NAME` through a private form (`!secret NAME file` for a file; `$NAME` is its path)',
  '`!secret`: names this session gets, by scope',
  '`!secret rm NAME [session|me|workspace]`: remove one',
  'Scopes: *this session*; *just me* (all your sessions); *workspace* (every session in this Slack workspace; admins only). The narrowest wins.',
  'Values that are not secret (an org name, a hostname): `!var help`.',
].join('\n');

const NOTE =
  'Sessions on the shared host all run as one Unix user for now, so another session could read this value with effort. ' +
  'It is stored encrypted on the gateway and redacted from what Computer posts.';

/** What a button carries: the session (if any), the name, file or not, and whether a session asked. */
interface ButtonData {
  k?: string;
  n: string;
  f?: 1;
  r?: 1;
}
interface ModalData {
  k?: string;
  ch?: string;
  th?: string;
  /** The request message to update, when a session asked. */
  rq?: string;
}

const enc = (d: ButtonData) => `s:${Buffer.from(JSON.stringify(d)).toString('base64url')}`;
function dec(actionId: string): ButtonData | undefined {
  try {
    const d = JSON.parse(Buffer.from(actionId.slice(2), 'base64url').toString());
    return typeof d?.n === 'string' ? d : undefined;
  } catch {
    return undefined;
  }
}

const scopeLabel = (scope: SecretScope, owner: string, viewer?: string) =>
  scope === 'session' ? 'this session' : scope === 'workspace' ? 'workspace' : owner === viewer ? 'just you' : `<@${owner}>'s sessions`;

/** The fields of a block_actions payload a button click reads. */
export interface ClickBody {
  user?: { id?: string };
  trigger_id?: string;
  channel?: { id?: string };
  container?: { channel_id?: string; thread_ts?: string; message_ts?: string };
}

/** The fields of a submitted modal: `state.values[block][action]`. */
export interface SubmittedView {
  private_metadata?: string;
  state?: {
    values?: Record<string, Record<string, { value?: string | null; selected_option?: { value?: string } | null; selected_options?: { value?: string }[] | null }>>;
  };
}

export interface SecretsUiDeps {
  store: Store;
  vault: Vault;
  hub: Hub;
}

export function createSecretsUi({ store, vault, hub }: SecretsUiDeps) {
  const thread = (spec?: SlackSessionSpec) => (spec?.kind === 'thread' ? spec.threadTs : undefined);

  async function ephemeral(client: WebClient, channel: string, user: string, text: string, threadTs?: string, blocks?: KnownBlock[]) {
    await client.chat
      .postEphemeral({ channel, user, text, ...(blocks ? { blocks } : {}), ...(threadTs ? { thread_ts: threadTs } : {}) })
      .catch((e) => log.warn('postEphemeral', e?.data?.error ?? e?.message));
  }

  function enterButton(d: ButtonData, label = `Enter ${d.n}`): KnownBlock {
    return {
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: label.slice(0, 75) }, action_id: enc(d), value: d.n, style: 'primary' }],
    };
  }

  /** `!secret …` from a person, in a session's thread (`spec`) or anywhere the bot is addressed. */
  async function command(text: string, m: Msg, person: SlackPerson, spec: SlackSessionSpec | undefined, client: WebClient) {
    const [, sub = '', ...rest] = text.trim().split(/\s+/);
    const say = (t: string, blocks?: KnownBlock[]) => ephemeral(client, m.channel, person.slackUserId, t, m.thread_ts, blocks);
    if (!vault.writable) return say('Secrets are not available: the gateway has no `SP_STORE_KEY`.');
    const lower = sub.toLowerCase();
    if (!sub || lower === 'list' || lower === 'ls') return say(list(person, spec));
    if (lower === 'help') return say(HELP);
    if (['rm', 'remove', 'delete', 'unset'].includes(lower)) return say(remove(rest[0], rest[1], person, spec));
    const name = ['set', 'add'].includes(lower) ? rest[0] : sub;
    const file = /^file$/i.test((['set', 'add'].includes(lower) ? rest[1] : rest[0]) ?? '');
    if (!name) return say(HELP);
    const problem = secretNameProblem(name);
    if (problem) return say(`Can't use \`${name}\`: ${problem}.`);
    const d: ButtonData = { ...(spec ? { k: spec.key } : {}), n: name, ...(file ? { f: 1 as const } : {}) };
    return say(`Set \`${name}\``, [
      { type: 'section', text: { type: 'mrkdwn', text: `Set \`$${name}\`${file ? ' (as a file)' : ''}. The form is private; the value is never posted.` } },
      enterButton(d),
    ]);
  }

  function list(person: SlackPerson, spec?: SlackSessionSpec): string {
    const owner = spec?.owner.slackUserId ?? person.slackUserId;
    const rows = vault.list([
      ...(spec ? [{ scope: 'session' as const, owner: spec.key }] : []),
      { scope: 'user', owner },
      ...(owner !== person.slackUserId ? [{ scope: 'user' as const, owner: person.slackUserId }] : []),
      { scope: 'workspace', owner: '' },
    ]).filter((r) => !r.variable);
    if (!rows.length) return `No secrets yet. \`!secret NAME\` sets one.\n\n${HELP}`;
    const winner = new Map<string, string>();
    for (const r of rows) if (r.scope !== 'user' || r.owner === owner) if (!winner.has(r.name)) winner.set(r.name, r.scope);
    const lines = rows.map((r) => {
      const applies = r.scope === 'user' && r.owner !== owner ? ' · not used here (not your session)' : winner.get(r.name) !== r.scope ? ' · overridden' : '';
      const when = new Date(r.updated).toISOString().slice(0, 10);
      return `• \`${r.name}\`${r.file ? ' (file)' : ''} · ${scopeLabel(r.scope, r.owner, person.slackUserId)} · set by <@${r.setBy}> ${when}${applies}`;
    });
    return `*Secrets ${spec ? 'this session gets' : 'for your sessions'}* (names only)\n${lines.join('\n')}`;
  }

  function remove(name: string | undefined, where: string | undefined, person: SlackPerson, spec?: SlackSessionSpec): string {
    if (!name) return 'Usage: `!secret rm NAME [session|me|workspace]`';
    const want = where?.toLowerCase();
    const scopes: SecretScope[] =
      want === 'session' ? ['session'] : want === 'me' || want === 'user' ? ['user'] : want === 'workspace' ? ['workspace'] : ['session', 'user', 'workspace'];
    for (const scope of scopes) {
      if (scope === 'session' && !spec) continue;
      const owner = scope === 'session' ? spec!.key : scope === 'user' ? person.slackUserId : '';
      if (!vault.list([{ scope, owner }]).some((r) => r.name === name && !r.variable)) continue;
      if (scope === 'workspace' && !person.admin) return `\`${name}\` is a workspace secret; only an admin can remove it.`;
      vault.delete(scope, owner, name);
      pushFor(scope, owner);
      log.info(`secret ${scope}/${name} removed by ${person.dir}`);
      return `Removed \`${name}\` (${scopeLabel(scope, owner, person.slackUserId)}).`;
    }
    return `No \`${name}\`${want ? ` at scope ${want}` : ''} that you can remove here.`;
  }

  function pushFor(scope: SecretScope, owner: string) {
    hub.pushSecrets(scope === 'session' ? { key: owner } : scope === 'user' ? { owner } : {});
  }

  /** A click on an "Enter NAME" button: open the modal. */
  async function open(actionId: string, body: ClickBody, client: WebClient) {
    const d = dec(actionId);
    const user = body.user?.id;
    const person = user ? store.person(user) : undefined;
    const channel: string | undefined = body.channel?.id ?? body.container?.channel_id;
    if (!d || !person) return;
    const spec = d.k ? store.session(d.k)?.spec : undefined;
    const th: string | undefined = thread(spec) ?? body.container?.thread_ts;
    const meta: ModalData = {
      ...(spec ? { k: spec.key } : {}),
      ...(channel ? { ch: channel } : {}),
      ...(th ? { th } : {}),
      ...(d.r && body.container?.message_ts ? { rq: body.container.message_ts } : {}),
    };
    await client.views.open({ trigger_id: body.trigger_id ?? '', view: modal(d, meta, person, spec) }).catch((e) => log.warn('views.open', errorText(e)));
  }

  function modal(d: ButtonData, meta: ModalData, person: SlackPerson, spec?: SlackSessionSpec): View {
    const own = !spec || spec.owner.slackUserId === person.slackUserId;
    const options = [
      ...(spec ? [{ value: 'session', text: 'This session only', description: 'This thread; deleted 30 days after it was last active' }] : []),
      {
        value: 'user',
        text: 'Just me',
        description: own ? 'All your sessions, until you remove it' : `All your sessions (not this one: it is <@${spec!.owner.slackUserId}>'s)`,
      },
      ...(person.admin ? [{ value: 'workspace', text: 'Workspace', description: 'Every session in this Slack workspace (admins only)' }] : []),
    ].map((o) => ({ value: o.value, text: { type: 'plain_text' as const, text: o.text }, description: { type: 'mrkdwn' as const, text: o.description } }));
    const fileOption = { value: 'file', text: { type: 'plain_text' as const, text: 'Provide as a file' }, description: { type: 'mrkdwn' as const, text: '`$NAME` holds the path of a file with the value' } };
    return {
      type: 'modal',
      callback_id: SECRET_VIEW,
      private_metadata: JSON.stringify(meta),
      title: { type: 'plain_text', text: 'Set a secret' },
      submit: { type: 'plain_text', text: 'Save' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'name', label: { type: 'plain_text', text: 'Name' }, element: { type: 'plain_text_input', action_id: 'v', initial_value: d.n, max_length: 64 } },
        {
          type: 'input',
          block_id: 'value',
          label: { type: 'plain_text', text: 'Value' },
          hint: { type: 'plain_text', text: 'Shown only to you while you type. Never posted, never shown again.' },
          element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: INPUT_MAX },
        },
        { type: 'input', block_id: 'scope', label: { type: 'plain_text', text: 'Available to' }, element: { type: 'radio_buttons', action_id: 'v', options, initial_option: options[0] } },
        { type: 'input', block_id: 'opts', optional: true, label: { type: 'plain_text', text: 'Options' }, element: { type: 'checkboxes', action_id: 'v', options: [fileOption], ...(d.f ? { initial_options: [fileOption] } : {}) } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: NOTE }] },
      ],
    } as View;
  }

  /**
   * The modal was submitted. Validation errors go back in the ack (the modal
   * stays open); otherwise the value is stored and `done` posts the outcome
   * after the ack, which Slack wants within 3 s.
   */
  function submit(view: SubmittedView, userId: string): { errors: Record<string, string> } | { done(client: WebClient): Promise<void> } {
    const v = view.state?.values ?? {};
    const name = String(v.name?.v?.value ?? '').trim();
    const value: string = v.value?.v?.value ?? '';
    const scope = v.scope?.v?.selected_option?.value as SecretScope | undefined;
    const file = (v.opts?.v?.selected_options ?? []).some((o: { value?: string }) => o.value === 'file');
    let meta: ModalData = {};
    try {
      meta = JSON.parse(view.private_metadata || '{}');
    } catch {}
    const person = store.person(userId);
    if (!person) return { errors: { name: 'You are not enabled on this instance.' } };
    const problem = secretNameProblem(name);
    if (problem) return { errors: { name: problem } };
    if (!value.trim()) return { errors: { value: 'Enter a value.' } };
    if (Buffer.byteLength(value) > MAX_VALUE) return { errors: { value: 'Too large.' } };
    const spec = meta.k ? store.session(meta.k)?.spec : undefined;
    if (scope === 'session' && !spec) return { errors: { scope: 'This session no longer exists; pick another scope.' } };
    if (scope === 'workspace' && !person.admin) return { errors: { scope: 'Only admins can set workspace secrets.' } };
    if (!scope) return { errors: { scope: 'Pick where it applies.' } };
    const owner = scope === 'session' ? spec!.key : scope === 'user' ? userId : '';
    try {
      // A secret's own value must not keep a trailing newline from the paste, unless it is a file.
      vault.set(scope, owner, name, file ? value : value.trim(), file, userId);
    } catch (e) {
      return { errors: { value: errorText(e) } };
    }
    log.info(`secret ${scope}/${name} set by ${person.dir}${spec ? ` from ${spec.key}` : ''}`);
    const pushed = hub.pushSecrets(scope === 'session' ? { key: owner } : scope === 'user' ? { owner } : {});
    return {
      done: async (client) => {
        const where = scopeLabel(scope, owner, userId);
        const note = `:key: <@${userId}> set \`${name}\`${file ? ' (file)' : ''} for ${where === 'just you' ? 'their sessions' : where}.`;
        if (meta.rq && meta.ch)
          await client.chat.update({ channel: meta.ch, ts: meta.rq, text: note, blocks: [] }).catch((e) => log.warn('update secret request', e?.data?.error ?? e?.message));
        else if (meta.ch && spec) await client.chat.postMessage({ channel: meta.ch, ...(meta.th ? { thread_ts: meta.th } : {}), text: note }).catch(() => {});
        else if (meta.ch) await ephemeral(client, meta.ch, userId, note.replace(`<@${userId}> set`, 'Set'), meta.th);
        // The session asked and is waiting: tell it, which starts its next turn.
        const applies = spec && (scope !== 'user' || spec.owner.slackUserId === userId);
        if (meta.rq && spec && applies) {
          const text = `Secret $${name} is set (${where === 'just you' ? 'all my sessions' : where}). It is in the environment of your next Bash command${file ? ' as the path of a file holding it' : ''}. Continue.`;
          const r = await hub.deliver(spec, { userId, text, ts: meta.rq, mentioned: true });
          if (r !== 'queued' && !r.ok) log.warn(`secret set: deliver to ${spec.key} failed: ${r.error}`);
        }
        if (pushed) log.info(`secrets pushed to ${pushed} live session(s)`);
      },
    };
  }

  /** A session's request_secret: a button in its thread, for whoever is there. */
  async function request(from: string, req: SecretRequest, client: WebClient) {
    const spec = store.session(from)?.spec;
    if (!spec) throw new Error(`unknown session ${from}`);
    const problem = secretNameProblem(req.name);
    if (problem) throw new Error(`bad name: ${problem}`);
    if (!vault.writable) throw new Error('secrets are not available: the gateway has no SP_STORE_KEY');
    const d: ButtonData = { k: spec.key, n: req.name, ...(req.file ? { f: 1 as const } : {}), r: 1 };
    await client.chat.postMessage({
      channel: spec.channel,
      ...(thread(spec) ? { thread_ts: thread(spec) } : {}),
      text: `Computer needs ${req.name}: ${req.reason}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:key: *This session needs \`$${req.name}\`*${req.file ? ' (a file)' : ''}\n${req.reason.slice(0, 500)}` } },
        enterButton(d),
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Opens a private form; the value is never posted. `!secret help` for more.' }] },
      ],
    });
  }

  return { command, open, submit, request };
}

export type SecretsUi = ReturnType<typeof createSecretsUi>;
