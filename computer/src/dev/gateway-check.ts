// Check the gateway's routing and host link without Slack: a temp SQLite db,
// the hub on a local HTTP server, a fake host over a real WebSocket, and
// synthetic Slack events through the router with a fake WebClient.
//   npx tsx src/dev/gateway-check.ts

import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { encodeActionId, type GatewayToHost, type HostToGateway, type SlackPerson } from '../protocol.js';
import type { ModelRoutes } from '../protocol-model.js';
import { Store } from '../gateway/db.js';
import { Hub } from '../gateway/hosts.js';
import { createRouter, type Msg } from '../gateway/routing.js';
import { checkHostToken, issueHostToken } from '../setup/index.js';

const owner: SlackPerson = { slackUserId: 'U_OWNER', dir: 'owner', gitName: 'Owner', gitEmail: 'owner@example.com' };
const BOT = 'U_BOT';

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(ok ? 'PASS' : 'FAIL', name, ok || detail === undefined ? '' : JSON.stringify(detail));
};

// ---- fake Slack: every call recorded
const calls: { method: string; args: any }[] = [];
const method = (name: string, result: any = {}) => async (args: any) => {
  calls.push({ method: name, args });
  return { ok: true, ...result };
};
const client: any = {
  chat: { postMessage: method('chat.postMessage', { ts: '9.9' }), postEphemeral: method('chat.postEphemeral') },
  reactions: { add: method('reactions.add') },
  auth: { test: method('auth.test', { url: 'https://acme.slack.com/' }) },
  agents: {
    sessions: { setStatus: method('agents.sessions.setStatus') },
    conversations: { create: method('agents.conversations.create', { channel_id: 'C_CODE' }) },
  },
};
const called = (name: string) => calls.filter((c) => c.method === name);

// ---- gateway pieces on a temp db
const dir = mkdtempSync(path.join(os.tmpdir(), 'gw-check-'));
const store = new Store(path.join(dir, 'gateway.db'));
store.putPerson(owner);
store.putHost('vm-1', 'issued-token');
const setupToken = issueHostToken(store.db, 'vm-2');
let botToken = 'xoxb-fake';
const claudeRoute = { mode: 'profile', profile: 'anthropic-key', vars: { token: 'fake-key' }, key: 'k-claude' } as const;
const models: ModelRoutes = { claude: claudeRoute };
const hub = new Hub({
  store,
  tokens: ['static-token'],
  checkToken: (t) => checkHostToken(store.db, t),
  credentials: () => ({ slackBotToken: botToken, slackBotUserId: BOT }),
  models: () => models,
  mintToken: async () => {
    throw new Error('GitHub App not configured');
  },
});
const router = createRouter({ store, hub, mode: 'bypassPermissions', models: () => models });
const server = createServer((_, res) => res.writeHead(404).end());
hub.attach(server);
await new Promise<void>((ok) => server.listen(0, ok));
const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/host`;

// ---- a fake host: auto-replies ok to requests, records what it got
class FakeHost {
  ws: WebSocket;
  got: GatewayToHost[] = [];
  private waiters: [(m: GatewayToHost) => boolean, (m: GatewayToHost) => void][] = [];
  constructor(token: string) {
    this.ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on('message', (d) => {
      const m: GatewayToHost = JSON.parse(String(d));
      this.got.push(m);
      if ('id' in m && m.t !== 'token' && m.t !== 'reply') this.send({ t: 'reply', id: m.id, ok: true });
      this.waiters = this.waiters.filter(([f, done]) => (f(m) ? (done(m), false) : true));
    });
  }
  send(m: HostToGateway) {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends GatewayToHost['t']>(t: T, ms = 2000): Promise<Extract<GatewayToHost, { t: T }> | undefined> {
    const found = this.got.find((m) => m.t === t);
    if (found) return (this.got.splice(this.got.indexOf(found), 1), Promise.resolve(found as any));
    return new Promise((ok) => {
      const w: (typeof this.waiters)[number] = [(m) => m.t === t, (m) => (clearTimeout(timer), this.got.splice(this.got.indexOf(m), 1), ok(m as any))];
      const timer = setTimeout(() => ((this.waiters = this.waiters.filter((x) => x !== w)), ok(undefined)), ms);
      this.waiters.push(w);
    });
  }
  opened() {
    return new Promise<boolean>((ok) => {
      this.ws.on('open', () => ok(true));
      this.ws.on('error', () => ok(false));
    });
  }
  hello() {
    this.send({ t: 'hello', protocol: 1, hostId: 'vm-1', version: 'test', sessions: [] });
  }
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
let ev = 0;
const msg = (m: Partial<Msg>): Msg => ({ channel: 'C1', ts: `100.${++ev}`, user: owner.slackUserId, ...m });
const route = (m: Msg, mentioned = false, eventId = `Ev${ev}`) => router.route(m, { client, botUserId: BOT, teamId: 'T1', eventId }, mentioned);

// 1. Host auth
check('bad token rejected', !(await new FakeHost('wrong').opened()));
check('static token accepted', await new FakeHost('static-token').opened());
check('token issued by /setup accepted', await new FakeHost(setupToken).opened());
check('revoked-looking /setup token rejected', !(await new FakeHost(setupToken.slice(0, -2) + 'xx').opened()));
const host = new FakeHost('issued-token');
check('issued token accepted', await host.opened());
host.hello();
const welcome = await host.next('welcome');
check('welcome carries credentials and people', welcome?.credentials.slackBotToken === 'xoxb-fake' && welcome.people[0]?.dir === 'owner', welcome);
check('welcome carries the model routes', JSON.stringify(welcome?.models) === JSON.stringify({ claude: claudeRoute }), welcome?.models);

// 1b. A fresh install pushes credentials instead of dropping the host
botToken = 'xoxb-new';
hub.refreshCredentials();
const cr = await host.next('credentials');
check('credentials pushed after an install, host stays connected', cr?.credentials.slackBotToken === 'xoxb-new' && host.ws.readyState === WebSocket.OPEN, cr);
check('credentials carry the model routes', JSON.stringify(cr?.models) === JSON.stringify({ claude: claudeRoute }), cr?.models);

// 2. Allowlist
calls.length = 0;
await route(msg({ user: 'U_STRANGER', text: `<@${BOT}> hi` }), true);
check('stranger gets ephemeral only', called('chat.postEphemeral')[0]?.args.text.includes('not enabled') && calls.length === 1, calls);
check('stranger: nothing to the host', !(await host.next('deliver', 300)));

// 3. New session by mention
calls.length = 0;
const first = msg({ text: `<@${BOT}> fix the &lt;build&gt;` });
await route(first, true);
const d1 = await host.next('deliver');
check('new session delivered', d1?.session.key === `C1:${first.ts}` && d1.session.kind === 'thread' && d1.session.owner.dir === 'owner', d1);
check('text decoded, mention stripped', d1?.msg.text === 'fix the <build>', d1?.msg);
check('immediate feedback: status processing', called('agents.sessions.setStatus')[0]?.args.status === 'processing', calls);

// 4. Thread reply routes to the same session; the host's report reaches the spec
host.send({ t: 'session', report: { key: `C1:${first.ts}`, status: 'busy', sdkSessionId: 'sdk-1', forkPath: '/data/people/owner/sessions/x' } });
await sleep(50);
const reply = msg({ thread_ts: first.ts, text: 'and the tests' });
await route(reply);
const d2 = await host.next('deliver');
check('thread reply → same session', d2?.session.key === `C1:${first.ts}` && d2.msg.text === 'and the tests', d2);
check('report stored, resume ids in spec', d2?.session.sdkSessionId === 'sdk-1' && !!d2.session.forkPath, d2?.session);

// 4a. Slack permalinks in a person's message are read or refused before delivery (work 049)
await route(msg({ thread_ts: first.ts, text: 'see <https://elsewhere.slack.com/archives/C0123ABC/p1791569537611249>' }));
const dl = await host.next('deliver');
const linked = dl?.msg.linked?.[0];
check('permalink to another workspace: delivered with the refusal', linked?.ok === false && linked.reason.includes('another Slack workspace'), dl?.msg);
check('message without links: no linked field', d2?.msg.linked === undefined, d2?.msg);
const fastAuth = client.auth.test;
client.auth.test = async (a: any) => (await sleep(300), fastAuth(a));
void route(msg({ thread_ts: first.ts, text: 'see <https://elsewhere.slack.com/archives/C0123ABC/p1791569537611249>' }));
await sleep(20);
void route(msg({ thread_ts: first.ts, text: 'and summarize it' }));
const o1 = await host.next('deliver');
const o2 = await host.next('deliver');
client.auth.test = fastAuth;
check('a slow link read does not let the next message overtake it', !!o1?.msg.linked && o2?.msg.text === 'and summarize it', [o1?.msg.text, o2?.msg.text]);

// 4b. Addressing: replies carry whether they mention the bot; chatter aimed at
// others gets no "thinking…" flash; a stranger chatting in the thread gets no ephemeral
calls.length = 0;
await route(msg({ thread_ts: first.ts, text: `<@${BOT}> and lint` }), true);
const dm1 = await host.next('deliver');
check('mention in a thread reply → mentioned', dm1?.msg.mentioned === true && dm1.msg.text === 'and lint', dm1?.msg);
check('plain thread reply → not mentioned', d2?.msg.mentioned === false, d2?.msg);
calls.length = 0;
await route(msg({ thread_ts: first.ts, text: '<@U_OTHER> can you look at this?' }));
const other = await host.next('deliver');
check('reply to someone else still delivered, marked not mentioned', other?.msg.mentioned === false, other?.msg);
check('reply to someone else: no status flash', called('agents.sessions.setStatus').length === 0, calls);
calls.length = 0;
await route(msg({ thread_ts: first.ts, user: 'U_STRANGER', text: 'lol nice' }));
check('stranger chatting in a session thread: silent, nothing delivered', calls.length === 0 && !(await host.next('deliver', 300)), calls);

// 5. Duplicate event id (a Slack retry) is dropped
await route(msg({ thread_ts: first.ts, text: 'retry' }), false, 'Ev-dup');
await host.next('deliver');
await route(msg({ thread_ts: first.ts, text: 'retry' }), false, 'Ev-dup');
check('duplicate event_id dropped', !(await host.next('deliver', 300)));

// 6. ! commands forwarded, no feedback status
calls.length = 0;
await route(msg({ thread_ts: first.ts, text: '!status' }));
const d3 = await host.next('deliver');
check('!command forwarded as delivery', d3?.msg.text === '!status', d3);
check('!command: no status set', called('agents.sessions.setStatus').length === 0, calls);

// 7. Unaddressed channel chatter ignored
await route(msg({ text: 'just chatting' }));
check('chatter ignored', !(await host.next('deliver', 300)));

// 8. DM and code channel
await route(msg({ channel: 'D1', channel_type: 'im', text: 'hello in dm' }));
const dm = await host.next('deliver');
check('DM starts a session', dm?.session.channel === 'D1' && dm.session.kind === 'thread', dm?.session);
await route(msg({ text: `<@${BOT}> ch build a thing` }), true);
const cc = await host.next('deliver');
check('ch → code channel session', cc?.session.key === 'C_CODE' && cc.session.kind === 'channel' && cc.msg.text === 'build a thing', cc?.session);


// 9. Button click routed by decodeActionId; stop button
await router.action(encodeActionId(`C1:${first.ts}`, 'pr7', 'allow'), owner.slackUserId, client, 'C1');
const a = await host.next('action');
check('action routed by session key', a?.sessionKey === `C1:${first.ts}` && a.promptId === 'pr7' && a.value === 'allow', a);
await router.stop({ channel: 'C1', thread_ts: first.ts }, 'Ev-stop');
const st = await host.next('stop');
check('stop button → stop', st?.sessionKey === `C1:${first.ts}`, st);

// 10. token request answered with the error text
host.send({ t: 'token', id: 'tok1', sessionKey: `C1:${first.ts}` });
const tok = await host.next('token');
check('token request → error text', tok?.id === 'tok1' && tok.error === 'GitHub App not configured', tok);

// 11. Offline: queue + ephemeral, flushed on reconnect
host.ws.close();
await sleep(100);
calls.length = 0;
await route(msg({ thread_ts: first.ts, text: 'while offline' }));
await router.action(encodeActionId(`C1:${first.ts}`, 'pr8', 'deny'), owner.slackUserId, client, 'C1');
check('offline: ephemeral', called('chat.postEphemeral')[0]?.args.text.includes('offline'), calls);
const back = new FakeHost('issued-token');
await back.opened();
back.hello();
const q1 = await back.next('deliver');
const q2 = await back.next('action');
check('queued delivery flushed on reconnect', q1?.msg.text === 'while offline' && q1.session.sdkSessionId === 'sdk-1', q1);
check('queued action flushed on reconnect', q2?.promptId === 'pr8', q2);

back.ws.close();
server.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
