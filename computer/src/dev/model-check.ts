// `!model`, `+smart`/`+fast` and `!effort` end to end without credentials: the real Agent SDK, a fake Slack
// client, and a local stand-in for the Anthropic API that records which model
// every request used. Covers switching while idle, while a turn runs, an
// unknown id, and a runner restart (a new Session from the persisted info).
//   npx tsx src/dev/model-check.ts

import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Session, type SessionInfo } from '../runner/session.js';
import { endHarness } from './harness-end.js';

// ---- fake Anthropic API: every model is known except UNKNOWN
const UNKNOWN = 'claude-nope-1';
const used: string[] = []; // model of each streamed (turn) request
const efforts: (string | undefined)[] = []; // and its reasoning effort
let slowMs = 0;
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const j = body ? JSON.parse(body) : {};
    const json = (code: number, v: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
    if (!req.url?.startsWith('/v1/messages')) return json(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
    if (j.model === UNKNOWN) return json(404, { type: 'error', error: { type: 'not_found_error', message: `model: ${j.model}` } });
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
    if (!j.stream) return json(200, msg);
    used.push(j.model);
    efforts.push(j.output_config?.effort);
    if (slowMs) await sleep(slowMs);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, d: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
    ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    ev('message_stop', {});
    res.end();
  });
});
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
process.env.ANTHROPIC_API_KEY = 'sk-test';
for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'MODEL']) delete process.env[k];
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'model-check-cfg-'));

// ---- fake Slack: keep the text of everything posted
const said: string[] = [];
const node = (names: string[]): any =>
  new Proxy(() => {}, {
    get: (_, k) => (k === 'then' ? undefined : node([...names, String(k)])),
    apply: async (_, __, [args]) => {
      if (names.join('.') === 'chat.postMessage') said.push(args.text ?? '');
      else if (names[0] === 'chat') said.push(JSON.stringify(args)); // streams, footers
      return { ok: true, ts: `1.${said.length}`, channel_id: 'C_FAKE' };
    },
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let persisted: SessionInfo | undefined;
const info: SessionInfo = {
  key: 'k', kind: 'thread', channel: 'C_FAKE', threadTs: '1.0', userId: 'U1',
  cwd: mkdtempSync(join(tmpdir(), 'model-check-')), title: 't', mode: 'default',
};
const open = (i: SessionInfo) => {
  const s: Session = new Session(i, node([]), () => (persisted = { ...s.info }));
  return s;
};
let s = open(info);

async function turn(text: string) {
  await s.send(text, 'U1');
  for (let i = 0; i < 300 && s.isBusy; i++) await sleep(100);
}
async function command(text: string) {
  said.length = 0;
  const t0 = Date.now();
  await s.command(text, 'U1');
  return { reply: said.join('\n'), ms: Date.now() - t0 };
}
const last = () => used[used.length - 1];
const lastEffort = () => efforts[efforts.length - 1];

let failed = 0;
function check(name: string, ok: boolean, got: unknown) {
  if (!ok) failed++;
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(got).slice(0, 600));
}

// idle, before the session's first query
let r = await command('!model haiku');
check('idle: !model haiku is confirmed', r.reply.includes('model → `haiku`'), r);
await turn('one');
check('idle: next turn runs on haiku', last() === 'claude-haiku-5-5', used);
check('idle: info/footer show the resolved id', s.info.model === 'claude-haiku-5-5' && said.some((t) => t.includes('haiku-5-5')), { model: s.info.model, said });

// unknown id: a clear error, nothing changes
r = await command(`!model ${UNKNOWN}`);
check('unknown id: error says so and lists choices', /can't switch/.test(r.reply) && /choices: .*`opus`/.test(r.reply), r);
check('unknown id: model and persisted model unchanged', s.info.model === 'claude-haiku-5-5' && persisted?.model === 'claude-haiku-5-5', { model: s.info.model, persisted: persisted?.model });
await turn('two');
check('unknown id: next turn still on haiku', last() === 'claude-haiku-5-5', used);

// mid-turn
slowMs = 3000;
const running = turn('three');
await sleep(1000);
check('busy: a turn is running', s.isBusy, s.isBusy);
r = await command('!model sonnet');
check('busy: confirmed without waiting for the turn', r.reply.includes('model → `sonnet`') && r.ms < 2500, r);
await running;
slowMs = 0;
await turn('four');
check('busy: the following turn runs on sonnet', last() === 'claude-sonnet-5-5', used);

// runner restart: a new Session from what was persisted (the report the gateway folds into the spec)
endHarness(s); // the old runner exits
check('restart: sonnet was persisted', persisted?.model === 'claude-sonnet-5-5', persisted);
s = open({ ...info, model: persisted?.model, sdkSessionId: persisted?.sdkSessionId });
await turn('five');
check('restart: resumed session runs on sonnet', last() === 'claude-sonnet-5-5', used);
endHarness(s); // the old runner exits
s = open({ ...info, model: persisted?.model, sdkSessionId: persisted?.sdkSessionId });
r = await command('!model opus');
check('restart: !model before the first turn is confirmed', r.reply.includes('model → `opus`'), r);
await turn('six');
check('restart: then runs on opus', last() === 'claude-opus-5-5', used);
r = await command('!model');
check('!model with no id shows the current one', r.reply.includes('claude-opus-5-5'), r);

// tiers: `+smart` / `+fast` / `+default` at the start of a message, and `!model <tier>`
said.length = 0;
await turn('+fast quick one');
check('+fast: switches and runs the rest of the message on sonnet', last() === 'claude-sonnet-5-5' && said.some((t) => t.includes('model → fast')), { used, said });
const n = used.length;
said.length = 0;
await s.send('+smart', 'U1');
check('+smart alone: confirmed, no turn', !s.isBusy && used.length === n && said.some((t) => t.includes('model → smart (`claude-fable-5-2`)')), { used, said });
await turn('hard one');
check('+smart: next turn runs on fable', last() === 'claude-fable-5-2', used);
r = await command('!model default');
check('!model default: back to opus', r.reply.includes('model → default (`claude-opus-5-5`)'), r);
await turn('+default seven');
check('+default when already default: no switch, turn runs on opus', last() === 'claude-opus-5-5', used);
await turn('a +smart mid-message is just text');
check('+tier only counts at the start', last() === 'claude-opus-5-5', used);

// effort: medium by default, `!effort <level>` from the next request, kept across a model switch and a restart
check('effort: medium by default', efforts.length > 0 && efforts.every((e) => e === 'medium'), efforts);
r = await command('!effort');
check('!effort with no level shows the current one', r.reply.includes('effort: `medium`'), r);
r = await command('!effort lots');
check('!effort with an unknown level lists the choices, unchanged', r.reply.includes('choices:') && s.info.effort === undefined, r);
r = await command('!effort high');
check('!effort high is confirmed', r.reply.includes('effort → `high`'), r);
await turn('eight');
check('!effort high: next turn runs at high', lastEffort() === 'high', efforts);
await command('!model sonnet');
await turn('nine');
check('a model switch keeps the effort', last() === 'claude-sonnet-5-5' && lastEffort() === 'high', { used, efforts });
check('effort: high was persisted', persisted?.effort === 'high', persisted);
endHarness(s);
s = open({ ...info, model: persisted?.model, effort: persisted?.effort, sdkSessionId: persisted?.sdkSessionId });
await turn('ten');
check('restart: resumed session runs at high', lastEffort() === 'high', efforts);

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
