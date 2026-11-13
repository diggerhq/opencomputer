// Secrets people give sessions (work 046), without Slack or Claude:
//   1. the vault: encryption, scopes and precedence, tampering, purge
//   2. the runner's env file, sourced by a real bash as Claude Code would: values,
//      a change mid-session, removal (unset), file secrets, quoting, reserved names
//   3. redaction: whole values, values split across streamed deltas, PEM lines,
//      the Slack client wrapper, files that contain a value
//   4. the gateway: `!secret` → ephemeral button → modal → submit → stored and
//      pushed to a (fake) host; list, remove, admin-only workspace; request_secret →
//      button → submit → the session is told; `!var` variables: set, listed with
//      values, pushed flagged, never replacing a secret
//   5. a real runner process (fake Slack): secrets over its socket → env file;
//      redacted output, variables posted intact; files deleted when it exits
//
//   npx tsx src/dev/secrets-check.ts

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { WebClient } from '@slack/web-api';
import { type GatewayToHost, type HostToGateway, isSlackSpec, type RunnerSpec, type SessionSecret, type SlackPerson, type SlackSessionSpec } from '../protocol.js';
import { Store } from '../gateway/db.js';
import { Hub } from '../gateway/hosts.js';
import { createRouter, type Msg } from '../gateway/routing.js';
import { Vault, SESSION_TTL_MS } from '../gateway/vault.js';
import { createSecretsUi } from '../gateway/secrets-ui.js';
import { createVariablesUi } from '../gateway/variables-ui.js';
import { checkVariables } from './secrets-check-variables.js';
import { SessionSecrets, redactingClient } from '../runner/session-secrets.js';
import { secretNameProblem } from '../secret-names.js';
import { lines, send } from '../ipc.js';

/** Fake Slack payloads and rows the check pokes into; typing them would only restate Slack's API. */
// biome-ignore lint/suspicious/noExplicitAny: test fakes at the Slack edge
type Payload = any;

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(ok ? 'PASS' : 'FAIL', name, ok || detail === undefined ? '' : JSON.stringify(detail).slice(0, 600));
};
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'secrets-check-'));
const KEY = 'a'.repeat(64);

// ---------------------------------------------------------------- 1. vault

{
  const store = new Store(path.join(tmp, 'v.db'));
  const v = new Vault(store.db, KEY);
  v.set('workspace', '', 'API', 'org-value-1', false, 'U_A');
  v.set('user', 'U_A', 'API', 'user-value-1', false, 'U_A');
  v.set('user', 'U_B', 'OTHER', 'b-value-123', false, 'U_B');
  v.set('session', 'C1:1.1', 'API', 'session-value-1', false, 'U_A');
  v.set('workspace', '', 'KUBE', 'line1\nline2\n', true, 'U_A');
  const get = (key: string, owner: string) => Object.fromEntries(v.forSession(key, owner).map((s) => [s.name, s]));
  const a1 = get('C1:1.1', 'U_A');
  check('vault: narrowest scope wins (session > user > workspace)', a1.API?.value === 'session-value-1' && a1.API.scope === 'session', a1);
  const a2 = get('C1:2.2', 'U_A');
  check('vault: another session of the owner gets the user value', a2.API?.value === 'user-value-1' && !a2.OTHER, a2);
  const b = get('C1:3.3', 'U_B');
  check(
    "vault: someone else's session gets the workspace value and their own",
    b.API?.value === 'org-value-1' && b.OTHER?.value === 'b-value-123',
    b,
  );
  check('vault: file flag and value kept byte for byte', a1.KUBE?.file === true && a1.KUBE.value === 'line1\nline2\n', a1.KUBE);
  const raw = store.db.prepare('SELECT data FROM user_secrets').all() as Payload[];
  check(
    'vault: nothing stored in clear',
    raw.every((r) => !Buffer.from(r.data).toString().includes('value')),
  );
  store.db.exec("UPDATE user_secrets SET owner = 'U_B' WHERE scope = 'user' AND owner = 'U_A'");
  store.db.exec("DELETE FROM user_secrets WHERE scope = 'user' AND name = 'OTHER'");
  check('vault: a row moved to another owner does not decrypt', !get('C1:3.3', 'U_B').API || get('C1:3.3', 'U_B').API.value === 'org-value-1');
  check('vault: a wrong key decrypts nothing', new Vault(store.db, 'b'.repeat(64)).forSession('C1:1.1', 'U_A').length === 0);
  check('vault: without SP_STORE_KEY it is not writable', !new Vault(store.db, '').writable);
  check(
    'vault: list shows names, narrowest first',
    v
      .list([
        { scope: 'workspace', owner: '' },
        { scope: 'session', owner: 'C1:1.1' },
      ])
      .map((r) => r.scope)
      .join() === 'session,workspace,workspace',
  );
  check('vault: delete', v.delete('session', 'C1:1.1', 'API') && !v.delete('session', 'C1:1.1', 'API'));
  v.set('session', 'C1:old', 'X', 'xxxxxxx', false, 'U_A');
  v.set('session', 'C1:new', 'X', 'xxxxxxx', false, 'U_A');
  const spec = (key: string): SlackSessionSpec => ({
    key,
    kind: 'thread',
    channel: 'C1',
    threadTs: key.split(':')[1],
    owner: { slackUserId: 'U_A', dir: 'a', gitName: 'a', gitEmail: 'a@x' },
    title: 't',
    mode: 'default',
  });
  store.putSession(spec('C1:old'));
  store.putSession(spec('C1:new'));
  store.db.prepare('UPDATE sessions SET updated = ? WHERE key = ?').run(Date.now() - SESSION_TTL_MS - 1000, 'C1:old');
  check('vault: purge drops secrets of inactive sessions only', v.purge() === 1 && v.list([{ scope: 'session', owner: 'C1:new' }]).length === 1);
  v.set('workspace', '', 'ORG', 'acme-public', false, 'U_A', true);
  check(
    'vault: a variable is delivered flagged and listed with its value',
    get('C1:new', 'U_A').ORG?.variable === true &&
      v
        .variables([{ scope: 'workspace', owner: '' }])
        .map((r) => r.value)
        .join() === 'acme-public',
  );
  v.set('workspace', '', 'ORG', 'now-secret', false, 'U_A');
  check(
    'vault: a secret set over a variable is a secret',
    !get('C1:new', 'U_A').ORG?.variable && v.variables([{ scope: 'workspace', owner: '' }]).length === 0,
  );
  const old = new Store(path.join(tmp, 'old.db'));
  old.db.exec(
    'CREATE TABLE user_secrets (scope TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, file INTEGER NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, data BLOB NOT NULL, set_by TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (scope, owner, name))',
  );
  const ov = new Vault(old.db, KEY);
  ov.set('user', 'U_A', 'X', 'xxxxxxx', false, 'U_A', true);
  check('vault: a database from before variables gains the column', ov.forSession('k', 'U_A')[0]?.variable === true);
}

// ---------------------------------------------------------------- 2. env file

const bash = (envFile: string, cmd: string) =>
  execFileSync('bash', ['-c', `. ${envFile}; ${cmd}`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
{
  const s = new SessionSecrets(path.join(tmp, 'run', 'secrets', 'sess1'));
  check('env file: directory is private (700)', (statSync(s.dir).mode & 0o777) === 0o700);
  check('env file: sources cleanly with no secrets', bash(s.envFile, 'echo ok').trim() === 'ok');
  const tricky = `it's "quoted" $HOME \`x\` \\ end`;
  s.apply([
    { name: 'API_KEY', value: 'sk-live-123456', scope: 'session' },
    { name: 'TRICKY', value: tricky, scope: 'user' },
    { name: 'SA_JSON', value: '{"k": "v"}\n', scope: 'workspace', file: true },
    { name: 'PATH', value: '/evil', scope: 'session' },
  ]);
  check('env file: value available to the next command', bash(s.envFile, 'printf %s "$API_KEY"') === 'sk-live-123456');
  check('env file: quoting survives quotes, $, backticks, backslashes', bash(s.envFile, 'printf %s "$TRICKY"') === tricky);
  const f = bash(s.envFile, 'printf %s "$SA_JSON"');
  check(
    'env file: file secret is a path to a 600 file with the exact value',
    f.startsWith(s.dir) && readFileSync(f, 'utf8') === '{"k": "v"}\n' && (statSync(f).mode & 0o777) === 0o600,
    f,
  );
  check('env file: reserved names are dropped', bash(s.envFile, 'printf %s "$PATH"') !== '/evil' && !s.names.includes('PATH'));
  check('env file: values.sh is 600', (statSync(path.join(s.dir, 'values.sh')).mode & 0o777) === 0o600);
  check('runner env: set for processes started later', process.env.API_KEY === 'sk-live-123456');
  s.apply([{ name: 'API_KEY', value: 'sk-live-rotated', scope: 'session' }]);
  check('env file: a change is seen by the next command (same env file)', bash(s.envFile, 'printf %s "$API_KEY"') === 'sk-live-rotated');
  check(
    'env file: a removed secret is unset, even if inherited',
    execFileSync('bash', ['-c', `. ${s.envFile}; printf %s "\${TRICKY-unset}"`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TRICKY: 'stale' },
    }) === 'unset',
  );
  check('env file: a removed file secret is deleted', !existsSync(f));
  check('runner env: removed ones deleted', process.env.TRICKY === undefined && process.env.SA_JSON === undefined);
  check(
    'names: reserved and malformed refused',
    !!secretNameProblem('CLAUDE_CODE_OAUTH_TOKEN') &&
      !!secretNameProblem('GIT_ASKPASS') &&
      !!secretNameProblem('1X') &&
      !!secretNameProblem('A-B') &&
      !secretNameProblem('MONID_API_KEY'),
  );
  s.cleanup();
  check('env file: cleanup removes the directory', !existsSync(s.dir));
  delete process.env.API_KEY;
}

// ---------------------------------------------------------------- 3. redaction

{
  const s = new SessionSecrets(path.join(tmp, 'run', 'secrets', 'sess2'));
  const pem = '-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n-----END KEY-----\n';
  s.apply([
    { name: 'TOKEN', value: 'ghp_abcdefghijklmnop', scope: 'session' },
    { name: 'PEM', value: pem, scope: 'user', file: true },
    { name: 'SHORT', value: 'abc', scope: 'workspace' },
  ]);
  check('redact: whole value', s.redact('token=ghp_abcdefghijklmnop.') === 'token=[secret:TOKEN].');
  check('redact: a line of a multi-line value', s.redact('see MIIEvQIBADANBgkqhkiG9w0BAQEFAASC here') === 'see [secret:PEM] here');
  check('redact: values under 6 chars are left (would match ordinary text)', s.redact('abc') === 'abc');
  const text = 'start ghp_abcdefghijklmnop middle ghp_abcdefghijklmnop end ghp_abc';
  let allSplits = true;
  for (let i = 0; i <= text.length; i++)
    for (let j = i; j <= text.length; j += 7) {
      const f = s.stream();
      const out = f.push(text.slice(0, i)) + f.push(text.slice(i, j)) + f.push(text.slice(j)) + f.flush();
      if (out !== 'start [secret:TOKEN] middle [secret:TOKEN] end ghp_abc') allSplits = false;
    }
  check('redact: streamed text, the value split at every point across deltas', allSplits);
  const f = s.stream();
  check('redact: stream holds back only a possible prefix', f.push('hello gh') === 'hello ' && f.push('x') === 'ghx');
  const seen: Payload[] = [];
  const fake = {
    chat: { postMessage: async (a: Payload) => (seen.push(a), { ok: true }) },
    files: { uploadV2: async (a: Payload) => (seen.push(a), { ok: true }) },
  };
  const c = redactingClient(fake, (t) => s.redact(t));
  const buf = Buffer.from('ghp_abcdefghijklmnop');
  await c.chat.postMessage({ text: 'x ghp_abcdefghijklmnop', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'ghp_abcdefghijklmnop' } }] });
  await c.files.uploadV2({ file: buf, initial_comment: 'ghp_abcdefghijklmnop' });
  check(
    'client: nested block text redacted',
    JSON.stringify(seen[0]) ===
      JSON.stringify({ text: 'x [secret:TOKEN]', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '[secret:TOKEN]' } }] }),
    seen[0],
  );
  check('client: buffers untouched, comments redacted', seen[1].file === buf && seen[1].initial_comment === '[secret:TOKEN]');
  // The real WebClient (classes, bound methods, axios inside) against a local Slack stand-in.
  const bodies: string[] = [];
  const api = createServer((req, res) => {
    let b = '';
    req
      .on('data', (d) => (b += d))
      .on('end', () => {
        bodies.push(`${req.url} ${decodeURIComponent(b)}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"ts":"1.1"}');
      });
  });
  await new Promise<void>((ok) => api.listen(0, ok));
  const real = redactingClient(
    new WebClient('xoxb-x', { slackApiUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/`, retryConfig: { retries: 0 } }),
    (t) => s.redact(t),
  );
  const r = await real.chat.postMessage({ channel: 'C1', text: 'real ghp_abcdefghijklmnop' });
  await real.apiCall('chat.update', { channel: 'C1', ts: '1.1', text: 'via apiCall ghp_abcdefghijklmnop' });
  api.close();
  check(
    'client: a real WebClient works wrapped and sends redacted text',
    r.ok && bodies.length === 2 && bodies.every((b) => b.includes('[secret:TOKEN]') && !b.includes('ghp_abcdefghijklmnop')),
    bodies,
  );
  check(
    'send_file guard: a file holding a value is caught',
    s.foundIn(Buffer.from('a\nghp_abcdefghijklmnop\n')) === 'TOKEN' && !s.foundIn(Buffer.from('nothing')),
  );
  s.cleanup();
}

// ---------------------------------------------------------------- 4. gateway: !secret, modal, push, request

const owner: SlackPerson = { slackUserId: 'U_OWNER', dir: 'owner', gitName: 'Owner', gitEmail: 'i@x', admin: true };
const ada: SlackPerson = { slackUserId: 'U_ADA', dir: 'ada', gitName: 'Ada', gitEmail: 'm@x' };
const BOT = 'U_BOT';
const calls: { method: string; args: Payload }[] = [];
const method =
  (name: string, result: Payload = {}) =>
  async (args: Payload) => (calls.push({ method: name, args }), { ok: true, ...result });
const client: Payload = {
  chat: { postMessage: method('chat.postMessage', { ts: '500.1' }), postEphemeral: method('chat.postEphemeral'), update: method('chat.update') },
  views: { open: method('views.open') },
  reactions: { add: method('reactions.add') },
  agents: { sessions: { setStatus: method('agents.sessions.setStatus') } },
};
const called = (name: string) => calls.filter((c) => c.method === name);
const store = new Store(path.join(tmp, 'gw.db'));
store.putPerson(owner);
store.putPerson(ada);
store.putHost('vm-1', 'host-token');
const vault = new Vault(store.db, KEY);
const hub: Hub = new Hub({
  store,
  tokens: [],
  credentials: () => ({ slackBotToken: 'xoxb', slackBotUserId: BOT }),
  models: () => ({}),
  mintToken: async () => ({ token: 't', expiresAt: new Date().toISOString() }),
  secretsFor: (spec) => (isSlackSpec(spec) ? vault.forSession(spec.key, spec.owner.slackUserId) : []),
  requestSecret: (from, req) => ui.request(from, req, client),
});
const ui = createSecretsUi({ store, vault, hub });
const vars = createVariablesUi({ store, vault, hub });
const router = createRouter({ store, hub, mode: 'bypassPermissions', models: () => ({}), secrets: ui, variables: vars });
const server = createServer((_, res) => res.writeHead(404).end());
hub.attach(server);
await new Promise<void>((ok) => server.listen(0, ok));
const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/host`, { headers: { authorization: 'Bearer host-token' } });
const got: GatewayToHost[] = [];
ws.on('message', (d) => {
  const m: GatewayToHost = JSON.parse(String(d));
  got.push(m);
  if ('id' in m && m.t !== 'secret-asked' && m.t !== 'reply') ws.send(JSON.stringify({ t: 'reply', id: m.id, ok: true } satisfies HostToGateway));
});
await new Promise((ok) => ws.on('open', ok));
ws.send(JSON.stringify({ t: 'hello', protocol: 1, hostId: 'vm-1', version: 'test', sessions: [] } satisfies HostToGateway));
const next = async <T extends GatewayToHost['t']>(t: T, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) {
    const i = got.findIndex((m) => m.t === t);
    if (i >= 0) return got.splice(i, 1)[0] as Extract<GatewayToHost, { t: T }>;
  }
};
let ev = 0;
const route = (m: Partial<Msg>, mentioned = false) =>
  router.route(
    { channel: 'C1', ts: `200.${++ev}`, user: owner.slackUserId, ...m } as Msg,
    { client, botUserId: BOT, teamId: 'T1', eventId: `Ev${ev}` },
    mentioned,
  );
const button = (c?: { args: Payload }) =>
  c?.args.blocks?.flatMap((b: Payload) => b.elements ?? []).find((e: Payload) => e.type === 'button')?.action_id as string | undefined;
const state = (name: string, value: string, scope: string, file = false) => ({
  name: { v: { value: name } },
  value: { v: { value } },
  scope: { v: { selected_option: { value: scope } } },
  opts: { v: { selected_options: file ? [{ value: 'file' }] : [] } },
});

// A session exists and has a runner on vm-1.
await route({ ts: '300.1', text: `<@${BOT}> start` }, true);
const SK = 'C1:300.1';
const first = await next('deliver');
check('gateway: a delivery carries the session secrets (none yet)', Array.isArray(first?.secrets) && first.secrets.length === 0, first);
store.report({ key: SK, status: 'idle' }, 'vm-1');

calls.length = 0;
await route({ thread_ts: '300.1', text: '!secret MONID_API_KEY' });
const eph = called('chat.postEphemeral')[0];
const aid = button(eph);
check(
  '!secret NAME: ephemeral button, nothing delivered to the session',
  eph?.args.user === owner.slackUserId && eph.args.thread_ts === '300.1' && aid?.startsWith('s:') && !(await next('deliver', 200)),
  eph,
);
await route({ thread_ts: '300.1', text: '!secret CLAUDE_CODE_OAUTH_TOKEN' });
check('!secret: reserved names refused', /reserved/.test(called('chat.postEphemeral')[1]?.args.text));

await ui.open(
  aid!,
  { user: { id: owner.slackUserId }, trigger_id: 'trig', channel: { id: 'C1' }, container: { message_ts: '300.9', thread_ts: '300.1' } },
  client,
);
const view = called('views.open')[0]?.args.view;
const opts = view?.blocks
  .find((b: Payload) => b.block_id === 'scope')
  ?.element.options.map((o: Payload) => o.value)
  .join();
check(
  'modal: opened with the trigger, name prefilled, scopes for an admin',
  called('views.open')[0]?.args.trigger_id === 'trig' &&
    view.callback_id === 'calvin_secret' &&
    opts === 'session,user,workspace' &&
    view.blocks[0].element.initial_value === 'MONID_API_KEY',
  view,
);
const meta = view.private_metadata;
await ui.open(aid!, { user: { id: ada.slackUserId }, trigger_id: 't2', channel: { id: 'C1' }, container: {} }, client);
check(
  'modal: no workspace scope for a non-admin',
  called('views.open')[1]
    ?.args.view.blocks.find((b: Payload) => b.block_id === 'scope')
    .element.options.map((o: Payload) => o.value)
    .join() === 'session,user',
);

const e1 = ui.submit({ private_metadata: meta, state: { values: state('BAD-NAME', 'v', 'session') } }, owner.slackUserId);
const e2 = ui.submit({ private_metadata: meta, state: { values: state('X1', '  ', 'session') } }, owner.slackUserId);
const e3 = ui.submit({ private_metadata: meta, state: { values: state('X1', 'value1', 'workspace') } }, ada.slackUserId);
check(
  'submit: bad name, empty value and non-admin workspace are errors on the modal',
  'errors' in e1 && !!e1.errors.name && 'errors' in e2 && !!e2.errors.value && 'errors' in e3 && !!e3.errors.scope,
);

calls.length = 0;
const ok1 = ui.submit({ private_metadata: meta, state: { values: state('MONID_API_KEY', 'mk_live_0123456789\n', 'session') } }, owner.slackUserId);
const pushed = await next('secrets');
check(
  'submit: stored (trimmed) and pushed to the live session',
  !('errors' in ok1) && pushed?.sessionKey === SK && pushed.secrets[0]?.value === 'mk_live_0123456789' && pushed.secrets[0].scope === 'session',
  pushed,
);
if (!('errors' in ok1)) await ok1.done(client);
const note = called('chat.postMessage')[0]?.args;
check(
  'submit: a note in the thread names the secret, never the value',
  note?.thread_ts === '300.1' && /MONID_API_KEY/.test(note.text) && !JSON.stringify(calls).includes('mk_live'),
  note,
);

const ok2 = ui.submit({ private_metadata: meta, state: { values: state('SHARED', 'org-wide-value', 'workspace') } }, owner.slackUserId);
check(
  'submit: an admin sets a workspace secret, pushed to every live session',
  !('errors' in ok2) && (await next('secrets'))?.secrets.map((s) => s.name).join() === 'MONID_API_KEY,SHARED',
);
const ok3 = ui.submit({ private_metadata: meta, state: { values: state('ADA_ONLY', 'ada-value-123', 'user') } }, ada.slackUserId);
check("submit: 'just me' from someone else's thread is not pushed to it", !('errors' in ok3) && !(await next('secrets', 300)));

calls.length = 0;
await route({ thread_ts: '300.1', text: '!secret', user: ada.slackUserId });
const listing = called('chat.postEphemeral')[0]?.args.text ?? '';
check(
  '!secret: names by scope, values never',
  /MONID_API_KEY.*this session/.test(listing) &&
    /SHARED.*workspace/.test(listing) &&
    /ADA_ONLY.*not used here/.test(listing) &&
    !/mk_live|org-wide/.test(listing),
  listing,
);
await route({ thread_ts: '300.1', text: '!secret rm SHARED', user: ada.slackUserId });
check(
  '!secret rm: workspace secret needs an admin',
  /only an admin/.test(called('chat.postEphemeral')[1]?.args.text) && vault.list([{ scope: 'workspace', owner: '' }]).length === 1,
);
await route({ thread_ts: '300.1', text: '!secret rm SHARED' });
check(
  '!secret rm: removed and pushed',
  /Removed/.test(called('chat.postEphemeral')[2]?.args.text) && (await next('secrets'))?.secrets.map((s) => s.name).join() === 'MONID_API_KEY',
);

await route({ thread_ts: '300.1', text: 'next turn' });
const d2 = await next('deliver');
check('gateway: the next delivery carries the current secrets', d2?.secrets?.map((s) => s.name).join() === 'MONID_API_KEY', d2);

// request_secret: from the host, as a runner would ask.
calls.length = 0;
ws.send(
  JSON.stringify({
    t: 'secret-request',
    id: 'rq1',
    from: SK,
    req: { name: 'GCP_SA', reason: 'deploy to the dev project', file: true },
  } satisfies HostToGateway),
);
const asked = await next('secret-asked');
const reqMsg = called('chat.postMessage')[0];
const reqAid = button(reqMsg);
check(
  'request_secret: a button posted in the thread, answered ok',
  asked &&
    !asked.error &&
    reqMsg?.args.thread_ts === '300.1' &&
    /GCP_SA/.test(reqMsg.args.text) &&
    /deploy to the dev project/.test(JSON.stringify(reqMsg.args.blocks)),
  { asked, reqMsg },
);
ws.send(JSON.stringify({ t: 'secret-request', id: 'rq2', from: SK, req: { name: 'PATH', reason: 'x' } } satisfies HostToGateway));
check('request_secret: a reserved name is refused', /reserved/.test((await next('secret-asked'))?.error ?? ''));
await ui.open(
  reqAid!,
  { user: { id: owner.slackUserId }, trigger_id: 't3', channel: { id: 'C1' }, container: { message_ts: '500.1', thread_ts: '300.1' } },
  client,
);
const rview = called('views.open').at(-1)?.args.view;
check(
  'request_secret: the modal starts with file ticked',
  rview?.blocks.find((b: Payload) => b.block_id === 'opts')?.element.initial_options?.length === 1,
);
calls.length = 0;
const ok4 = ui.submit(
  { private_metadata: rview.private_metadata, state: { values: state('GCP_SA', '{"type":"service_account"}', 'session', true) } },
  owner.slackUserId,
);
await next('secrets');
if (!('errors' in ok4)) await ok4.done(client);
const told = await next('deliver');
check(
  'request_secret: once set, the request message is updated and the session is told',
  called('chat.update')[0]?.args.ts === '500.1' && /GCP_SA/.test(told?.msg.text ?? '') && told?.secrets?.some((s) => s.name === 'GCP_SA' && s.file),
  { update: called('chat.update'), told },
);

await checkVariables({ check, route, next, called, calls, button, vault, vars, owner, ada });

ws.close();
server.close();

// ---------------------------------------------------------------- 5. a real runner

{
  const RUN = mkdtempSync('/tmp/scr-'); // short: unix socket paths are limited
  const fork = path.join(tmp, 'fork');
  execFileSync('git', ['init', '-q', fork]);
  const key = 'C9:900.1';
  const sock = path.join(RUN, 'runners', 'r.sock');
  const rs: RunnerSpec = {
    session: { key, kind: 'thread', channel: 'C9', threadTs: '900.1', owner, title: 't', mode: 'default', forkPath: fork },
    socket: sock,
    version: 'check',
  };
  let out = '';
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, '..', 'runner', 'main.ts')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_SPEC: JSON.stringify(rs), SP_RUN: RUN, SP_FAKE_SLACK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [child.stdout!, child.stderr!]) s.setEncoding('utf8').on('data', (d) => (out += d));
  let conn: net.Socket | undefined;
  for (let i = 0; i < 200 && !conn; i++) {
    await sleep(50);
    conn = await new Promise<net.Socket | undefined>((ok) => {
      const c = net.createConnection(sock);
      c.once('connect', () => ok(c));
      c.once('error', () => ok(undefined));
    });
  }
  check('runner: started and listening', !!conn, out.slice(-500));
  if (conn) {
    const replies: Payload[] = [];
    lines(conn, (m) => replies.push(m));
    const dir = path.join(RUN, 'secrets', Buffer.from(key).toString('base64url'));
    const secrets: SessionSecret[] = [
      { name: 'RUNNER_CHECK_KEY', value: 'rck_9876543210', scope: 'session' },
      { name: 'RUNNER_CHECK_ORG', value: 'public-org-name-42', scope: 'workspace', variable: true },
    ];
    send(conn, { t: 'secrets', secrets });
    await sleep(300);
    check(
      'runner: env file sourced by bash gives the value',
      existsSync(path.join(dir, 'env.sh')) && bash(path.join(dir, 'env.sh'), 'printf %s "$RUNNER_CHECK_KEY"') === 'rck_9876543210',
    );
    // `!model <value>` makes the runner post the value back: it must come out redacted.
    send(conn, { t: 'deliver', id: 'd1', msg: { userId: owner.slackUserId, text: '!model rck_9876543210', ts: '900.2' } });
    for (let i = 0; i < 100 && !replies.some((r) => r.t === 'reply' && r.id === 'd1'); i++) await sleep(50);
    check(
      'runner: its Slack output is redacted',
      /\[secret:RUNNER_CHECK_KEY\]/.test(out) && !/chat\.postMessage[^\n]*rck_9876543210/.test(out),
      out.slice(-800),
    );
    send(conn, { t: 'deliver', id: 'd2', msg: { userId: owner.slackUserId, text: '!model public-org-name-42', ts: '900.3' } });
    for (let i = 0; i < 100 && !replies.some((r) => r.t === 'reply' && r.id === 'd2'); i++) await sleep(50);
    check(
      'runner: a variable is in the env file and posted intact',
      bash(path.join(dir, 'env.sh'), 'printf %s "$RUNNER_CHECK_ORG"') === 'public-org-name-42' &&
        /public-org-name-42/.test(out) &&
        !/RUNNER_CHECK_ORG\]/.test(out),
      out.slice(-800),
    );
    send(conn, { t: 'exit' });
    for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(50);
    check('runner: exits and deletes its secrets directory', child.exitCode === 0 && !existsSync(dir), {
      code: child.exitCode,
      exists: existsSync(dir),
    });
  }
  child.kill();
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
