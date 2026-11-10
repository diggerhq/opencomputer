// Variables in Slack (work 046): `!var` sets, lists and removes values a
// session gets in its environment that are not secret (variables.ts has the
// syntax). Kept in the vault next to secrets, with the same scopes and rules:
// workspace needs an admin. A variable never replaces a secret of the same
// name in the same scope, so a credential is never shown by accident; a
// secret may replace a variable (secrets-ui.ts), which only makes it stricter.
// A value that looks like a credential (credentialHint) is not kept until the
// person clicks "Set it anyway": the button carries the command, and the click
// runs it again, checks and all, except that one.

import type { KnownBlock, WebClient } from '@slack/web-api';
import type { SlackPerson, SecretScope, SlackSessionSpec } from '../protocol.js';
import { credentialHint, parseVariableCommand, showValue, VARIABLE_HELP, type VariableCommand } from '../variables.js';
import type { Store } from './db.js';
import type { Hub } from './hosts.js';
import type { Vault } from './vault.js';
import type { Msg } from './routing.js';
import type { ClickBody } from './secrets-ui.js';
import { log } from '../log.js';

const label = (scope: SecretScope, owner: string, viewer: string) =>
  scope === 'session' ? 'this session' : scope === 'workspace' ? 'workspace' : owner === viewer ? 'just you' : `<@${owner}>'s sessions`;

/** Slack's limit on a button's value, which carries the command. */
const BUTTON_VALUE_MAX = 2000;

interface Reply {
  text: string;
  blocks?: KnownBlock[];
}

export function createVariablesUi({ store, vault, hub }: { store: Store; vault: Vault; hub: Hub }) {
  /** True when `text` was a `!var` command: answered here, never delivered. */
  async function command(text: string, m: Msg, person: SlackPerson, spec: SlackSessionSpec | undefined, client: WebClient): Promise<boolean> {
    const cmd = parseVariableCommand(text);
    if (!cmd) return false;
    const r = answer(cmd, person, spec, text);
    await client.chat
      .postEphemeral({ channel: m.channel, user: person.slackUserId, ...r, ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}) })
      .catch((e) => log.warn('postEphemeral', e?.data?.error ?? e?.message));
    return true;
  }

  /** A click on "Set it anyway": the command again, without the credential check, in place of the question. */
  async function confirm(actionId: string, value: string, body: ClickBody, respond: (r: Reply & { replace_original: boolean }) => Promise<unknown>) {
    const user = body.user?.id;
    const person = user ? store.person(user) : undefined;
    const cmd = parseVariableCommand(value);
    if (!person || cmd?.kind !== 'set') return;
    const key = actionId.slice(2);
    const spec = key ? store.session(key)?.spec : undefined;
    if (key && !spec) return void (await respond({ text: 'That session is gone; nothing was set.', replace_original: true }));
    await respond({ text: reply(cmd, person, spec, true), replace_original: true }).catch((e) => log.warn('respond', e?.message));
  }

  function answer(cmd: VariableCommand, person: SlackPerson, spec: SlackSessionSpec | undefined, text: string): Reply {
    const out = reply(cmd, person, spec, false);
    if (typeof out === 'string') return { text: out };
    const ask = `Not set: ${out.hint}. A variable is shown in Slack and never redacted, so keep credentials with \`!secret ${out.name}\` instead.`;
    if (text.length > BUTTON_VALUE_MAX) return { text: `${ask} (Too long for a button: if it is not secret, set it as a secret anyway.)` };
    return {
      text: ask,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${ask} If it is not secret, set it anyway.` } },
        {
          type: 'actions',
          elements: [{ type: 'button', text: { type: 'plain_text', text: 'Set it anyway' }, action_id: `v:${spec?.key ?? ''}`, value: text }],
        },
      ],
    };
  }

  /** The reply, or, unless `confirmed`, why the value looks like a credential. */
  function reply(cmd: VariableCommand, person: SlackPerson, spec: SlackSessionSpec | undefined, confirmed: true): string;
  function reply(cmd: VariableCommand, person: SlackPerson, spec: SlackSessionSpec | undefined, confirmed: boolean): string | { hint: string; name: string };
  function reply(cmd: VariableCommand, person: SlackPerson, spec: SlackSessionSpec | undefined, confirmed: boolean): string | { hint: string; name: string } {
    const me = person.slackUserId;
    if (!vault.writable) return 'Variables are not available: the gateway has no `SP_STORE_KEY`.';
    if (cmd.kind === 'help') return VARIABLE_HELP;
    if (cmd.kind === 'bad') return `Can't do that: ${cmd.reason}.`;
    if (cmd.kind === 'list') {
      const scopes = [
        ...(spec ? [{ scope: 'session' as const, owner: spec.key }] : []),
        { scope: 'user' as const, owner: spec?.owner.slackUserId ?? me },
        { scope: 'workspace' as const, owner: '' },
      ];
      const rows = vault.variables(scopes);
      if (!rows.length) return `No variables yet.\n\n${VARIABLE_HELP}`;
      // Secrets count too: a narrower secret of the same name overrides a variable.
      const winner = new Map<string, SecretScope>();
      for (const r of vault.list(scopes)) if (!winner.has(r.name)) winner.set(r.name, r.scope);
      const lines = rows.map(
        (r) => `• \`${r.name}\` = ${showValue(r.value)} · ${label(r.scope, r.owner, me)}${winner.get(r.name) === r.scope ? '' : ' · overridden'}`,
      );
      return `*Variables ${spec ? 'this session gets' : 'for your sessions'}*\n${lines.join('\n')}`;
    }
    const scope: SecretScope = cmd.scope ?? (spec ? 'session' : 'user');
    if (scope === 'session' && !spec) return 'Not in a session: add `me` or `workspace`.';
    if (scope === 'workspace' && !person.admin) return 'Only admins can set or remove workspace variables.';
    const owner = scope === 'session' ? spec!.key : scope === 'user' ? me : '';
    const where = label(scope, owner, me);
    const existing = cmd.name ? vault.list([{ scope, owner }]).find((r) => r.name === cmd.name) : undefined;
    if (cmd.kind === 'rm') {
      if (!existing?.variable) return `No variable \`${cmd.name ?? ''}\` in ${where}. \`!vars\` lists them.`;
      vault.delete(scope, owner, existing.name);
      push(scope, owner);
      log.info(`variable ${scope}/${existing.name} removed by ${person.dir}`);
      return `Removed \`${existing.name}\` from ${where}.`;
    }
    if (existing && !existing.variable)
      return `\`${cmd.name}\` is a secret in ${where}; a variable does not replace a secret. \`!secret rm ${cmd.name}\` first if it is not secret.`;
    const hint = confirmed ? undefined : credentialHint(cmd.name, cmd.value);
    if (hint) return { hint, name: cmd.name };
    vault.set(scope, owner, cmd.name, cmd.value, false, me, true);
    push(scope, owner);
    log.info(`variable ${scope}/${cmd.name} set by ${person.dir}`);
    return `Set \`${cmd.name}\` = ${showValue(cmd.value)} for ${where}. It is in the environment of the session's next Bash command.`;
  }

  function push(scope: SecretScope, owner: string) {
    hub.pushSecrets(scope === 'session' ? { key: owner } : scope === 'user' ? { owner } : {});
  }

  return { command, confirm };
}

export type VariablesUi = ReturnType<typeof createVariablesUi>;
