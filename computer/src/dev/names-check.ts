// The model sees people's and the channel's names (work 048 U13), end to end
// without credentials: the real Agent SDK, a local stand-in for the Anthropic
// API that records the last user message of every request, and a fake Slack
// client that answers users.info and conversations.info and counts the calls.
// Also: a Slack that fails or hangs leaves the ids and does not hold the message.
//   npx tsx src/dev/names-check.ts

import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Session, type SessionInfo } from '../runner/session.js';
import { endHarness } from './harness-end.js';

// ---- fake Anthropic API: answers "ok", keeps what the model was given
const inputs: string[] = [];
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    const msg = { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
    if (!j.stream) return res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(msg));
    type Msg = { role: string; content: string | { text?: string }[] };
    const last = (j.messages as Msg[] | undefined)?.filter((m) => m.role === 'user').at(-1);
    const parts = typeof last?.content === 'string' ? [last.content] : (last?.content ?? []).map((c) => c.text ?? '');
    inputs.push(parts.join('\n'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, d: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
    ev('message_start', { message: { ...msg, content: [], stop_reason: null } });
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
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'names-check-cfg-'));

// ---- fake Slack: a small directory; `broken` makes lookups fail or hang
const people: Record<string, string> = { U0ADAADA01: 'Ada', U0OWNER001: 'owner' };
const calls: Record<string, number> = {};
let broken: 'fail' | 'hang' | undefined;
// biome-ignore lint/suspicious/noExplicitAny: a WebClient stand-in
const node = (names: string[]): any =>
  new Proxy(() => {}, {
    get: (_, k) => (k === 'then' ? undefined : node([...names, String(k)])),
    apply: async (_, __, [args]) => {
      const m = names.join('.');
      calls[m] = (calls[m] ?? 0) + 1;
      if (m === 'users.info' || m === 'conversations.info') {
        if (broken === 'fail') throw Object.assign(new Error('An API error occurred: ratelimited'), { data: { error: 'ratelimited' } });
        if (broken === 'hang') return new Promise(() => {});
        if (m === 'users.info') return { ok: true, user: { id: args.user, profile: { display_name: people[args.user] ?? '' }, real_name: '' } };
        return { ok: true, channel: { id: args.channel, name: 'eng' } };
      }
      return { ok: true, ts: `1.${calls[m]}`, channel_id: 'C_FAKE' };
    },
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const open = (channel: string) => {
  const info: SessionInfo = {
    key: channel, kind: 'thread', channel, threadTs: '1.0', userId: 'U0ADAADA01',
    cwd: mkdtempSync(join(tmpdir(), 'names-check-')), title: 't', mode: 'default',
  };
  const s = new Session(info, node([]), () => {});
  return { s, close: () => endHarness(s) };
};
async function turn(s: Session, user: string, text: string, mentioned = true) {
  const t0 = Date.now();
  await s.send(text, user, [], mentioned);
  for (let i = 0; i < 300 && s.isBusy; i++) await sleep(100);
  return { input: inputs.at(-1) ?? '', sendMs: Date.now() - t0 };
}

let failed = 0;
function check(name: string, ok: boolean, got: unknown) {
  if (!ok) failed++;
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(got).slice(0, 600));
}

let { s, close } = open('C0ENG0001');
let r = await turn(s, 'U0ADAADA01', 'hi, @U0OWNER001 says hello');
check('sender by name, with a mention', r.input.includes('[Slack: from Ada (<@U0ADAADA01>) in #eng, mentions you]'), r);
check('inline mention named', r.input.includes('hi, @owner (<@U0OWNER001>) says hello'), r);
check('no bare @U… left', !/(^|[^<])@U0/.test(r.input), r);

r = await turn(s, 'U0OWNER001', 'not for you', false);
check('second speaker, not mentioned', r.input.includes('[Slack: from owner (<@U0OWNER001>) in #eng, does not mention you]'), r);
check('lookups cached: one users.info per person, one conversations.info', calls['users.info'] === 2 && calls['conversations.info'] === 1, calls);
close();

broken = 'fail';
({ s, close } = open('C0OTHER01'));
r = await turn(s, 'U0NEWBIE1', 'hello');
check('failing Slack: ids stand in', r.input.includes('[Slack: from <@U0NEWBIE1> in channel C0OTHER01, mentions you]'), r);
close();

broken = 'hang';
({ s, close } = open('C0THIRD01'));
r = await turn(s, 'U0LATE0001', 'still there?');
check('hanging Slack: message goes through with ids', r.input.includes('[Slack: from <@U0LATE0001> in channel C0THIRD01, mentions you]'), r);
check('hanging Slack: held at most ~0.8 s', r.sendMs < 5000, r.sendMs);
close();

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
