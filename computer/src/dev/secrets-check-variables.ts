// Part of secrets-check.ts (section 4): `!var` in the gateway. Variables are
// plain values, set in a message, shown and never redacted; one that looks like
// a credential is asked about first, with a "Set it anyway" button.

import type { GatewayToHost, Person } from '../protocol.js';
import type { Vault } from '../gateway/vault.js';
import type { VariablesUi } from '../gateway/variables-ui.js';

/** Fake Slack payloads and messages, as in secrets-check.ts. */
// biome-ignore lint/suspicious/noExplicitAny: test fakes at the Slack edge
type Payload = any;

export interface VariablesCheck {
  check: (name: string, ok: unknown, detail?: unknown) => void;
  route: (m: Payload) => Promise<unknown>;
  next: <T extends GatewayToHost['t']>(t: T, ms?: number) => Promise<Extract<GatewayToHost, { t: T }> | undefined>;
  called: (name: string) => { method: string; args: Payload }[];
  calls: { method: string; args: Payload }[];
  button: (c?: { args: Payload }) => string | undefined;
  vault: Vault;
  vars: VariablesUi;
  owner: Person;
  ada: Person;
}

export async function checkVariables({ check, route, next, called, calls, button, vault, vars, owner, ada }: VariablesCheck) {
  calls.length = 0;
  const ephText = () => called('chat.postEphemeral').at(-1)?.args.text ?? '';
  await route({ thread_ts: '300.1', text: '!var ORG_NAME acme-public-org workspace', user: ada.slackUserId });
  check('!var: workspace scope needs an admin', /Only admins/.test(ephText()) && !(await next('secrets', 200)), ephText());
  await route({ thread_ts: '300.1', text: '!var ORG_NAME acme-public-org workspace' });
  const vp = await next('secrets');
  const org = vp?.secrets.find((x) => x.name === 'ORG_NAME');
  check(
    '!var: set, flagged as a variable and pushed; nothing delivered',
    org?.value === 'acme-public-org' &&
      org.variable === true &&
      org.scope === 'workspace' &&
      /Set `ORG_NAME` = `acme-public-org`/.test(ephText()) &&
      !(await next('deliver', 200)),
    { org, t: ephText() },
  );
  await route({ thread_ts: '300.1', text: '!var MONID_API_KEY plain' });
  check(
    '!var: does not replace a secret in the same scope, nor show it',
    /is a secret/.test(ephText()) && !JSON.stringify(calls).includes('mk_live') && !(await next('secrets', 200)),
    ephText(),
  );
  await route({ thread_ts: '300.1', text: '!vars', user: ada.slackUserId });
  check(
    '!vars: lists variables with values, not secrets',
    /ORG_NAME` = `acme-public-org` · workspace/.test(ephText()) && !/MONID|GCP_SA/.test(ephText()),
    ephText(),
  );
  await route({ thread_ts: '300.1', text: '!secret' });
  check('!secret: lists secrets only', !/ORG_NAME/.test(ephText()) && /MONID_API_KEY/.test(ephText()), ephText());
  await route({ thread_ts: '300.1', text: '!secret rm ORG_NAME' });
  check(
    '!secret rm: leaves variables alone',
    !/Removed/.test(ephText()) && vault.variables([{ scope: 'workspace', owner: '' }]).length === 1,
    ephText(),
  );
  await route({ thread_ts: '300.1', text: '!var DEPLOY_TOKEN abc123' });
  const soft = called('chat.postEphemeral').at(-1);
  const vaid = button(soft);
  check(
    '!var: a credential-looking one is not set; it asks, with a button',
    /Not set: the name `DEPLOY_TOKEN` sounds like a credential/.test(soft?.args.text) && vaid === 'v:C1:300.1' && !(await next('secrets', 200)),
    soft?.args,
  );
  const responded: Payload[] = [];
  const vvalue = soft?.args.blocks?.flatMap((b: Payload) => b.elements ?? []).find((e: Payload) => e.type === 'button')?.value as string;
  await vars.confirm(vaid ?? '', vvalue, { user: { id: owner.slackUserId } }, async (r) => void responded.push(r));
  const forced = (await next('secrets'))?.secrets.find((x) => x.name === 'DEPLOY_TOKEN');
  check(
    '!var: "Set it anyway" sets it in place of the question',
    forced?.value === 'abc123' &&
      forced.variable === true &&
      forced.scope === 'session' &&
      responded[0]?.replace_original &&
      /Set `DEPLOY_TOKEN`/.test(responded[0]?.text),
    { forced, responded },
  );
  await vars.confirm(vaid ?? '', '!var ORG_NAME x workspace', { user: { id: ada.slackUserId } }, async (r) => void responded.push(r));
  check(
    '!var: "Set it anyway" re-checks who may set it',
    /Only admins/.test(responded.at(-1)?.text) && !(await next('secrets', 200)),
    responded.at(-1),
  );
  await route({ thread_ts: '300.1', text: '!var rm ORG_NAME workspace' });
  check(
    '!var rm: removed and pushed',
    /Removed `ORG_NAME`/.test(ephText()) && !(await next('secrets'))?.secrets.some((x) => x.name === 'ORG_NAME'),
    ephText(),
  );
}
