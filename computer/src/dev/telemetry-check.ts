// Runner telemetry end to end without credentials (work 054): the real Agent
// SDK, a scripted stand-in for the Anthropic API, a fake Slack client behind
// the metered client, and TurnEvents. Asserts the facts reported for a turn
// that thinks, runs a tool and answers, then a warm turn, against the SDK's
// real message shapes rather than hand-written ones. Then a session whose
// harness starts before its first message (runner/main.ts prewarms on
// credentials): `harness.started` comes with no turn, and the turn finds the
// harness up. `--out <file>` writes the
// events as Tinybird NDJSON, to run the `turns` pipe over them
// (telemetry/tinybird/scripts/turns-local.py).
//   npx tsx src/dev/telemetry-check.ts [--out events.ndjson]

import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Session, type SessionInfo } from '../runner/session.js';
import { endHarness } from './harness-end.js';
import { meteredClient } from '../runner/surface-meter.js';
import { TurnEvents } from '../runner/turn-events.js';
import { type Batch, createTelemetry } from '../telemetry/emitter.js';
import { eventLine } from '../telemetry/envelope.js';
import { fakeSlack } from './fake-slack.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const THINK_MS = 2500;

// ---- fake Anthropic API: a turn's first request thinks then calls Bash; after the tool result it answers.
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const j = body ? JSON.parse(body) : {};
    const base = { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
    if (!req.url?.startsWith('/v1/messages')) return res.writeHead(404).end();
    if (!j.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...base, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
    }
    const last = j.messages?.at(-1)?.content;
    const afterTool = Array.isArray(last) && last.some((b: { type?: string }) => b.type === 'tool_result');
    const text = JSON.stringify(j.messages ?? []);
    const toolTurn = text.includes('use a tool') && !afterTool;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, d: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
    ev('message_start', { message: { ...base, content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 40 } } });
    if (toolTurn) {
      ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'let me check' } });
      await sleep(THINK_MS);
      ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
      ev('content_block_stop', { index: 0 });
      ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_check1', name: 'Bash', input: {} } });
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"sleep 1","description":"wait"}' } });
      ev('content_block_stop', { index: 1 });
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
    } else {
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'done' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    }
    ev('message_stop', {});
    res.end();
  });
});
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
process.env.ANTHROPIC_API_KEY = 'sk-test';
for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'MODEL']) delete process.env[k];
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'telemetry-check-cfg-'));

// ---- the runner's pieces, as runner/main.ts wires them
const batches: Batch[] = [];
const telemetry = createTelemetry({ service: 'runner', version: 'check', region: 'local', send: (b) => void batches.push(b), base: { session_key: 'k' } });
const info: SessionInfo = {
  key: 'k',
  kind: 'thread',
  channel: 'C_FAKE',
  threadTs: '1.0',
  userId: 'U1',
  cwd: mkdtempSync(join(tmpdir(), 'telemetry-check-')),
  title: 't',
  mode: 'bypassPermissions',
};
let s!: Session;
let turns!: TurnEvents;
const slackCalls: string[] = [];
function runner(i: SessionInfo) {
  turns = new TurnEvents(telemetry, { model: () => s.info.model, tierOf: () => undefined, provider: () => 'anthropic' });
  s = new Session(i, meteredClient(fakeSlack((l) => void slackCalls.push(l)), (c) => turns.surfaceCall(c)), () => {}, { turns });
}
runner(info);

let n = 0;
async function turn(text: string) {
  const sentAt = Date.now() - 200;
  turns.delivered({ id: `019a3b4c-0000-7000-8000-00000000000${++n}`, sentAt, receivedAt: sentAt + 50, surface: 'slack', surfaceWorkspaceId: 'T1', conversationId: 'C_FAKE', personId: 'U1', path: n === 1 ? 'new' : 'warm' });
  await s.send(text, 'U1');
  for (let i = 0; i < 600 && s.isBusy; i++) await sleep(100);
  await telemetry.flush();
}

let failed = 0;
function check(name: string, ok: boolean, got: unknown) {
  if (!ok) failed++;
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(got).slice(0, 900));
}

await turn('please use a tool');
const events = () => batches.flatMap((b) => b.events);
const names = (): string[] => events().map((e) => e.event_name);
const kinds = () => events().filter((e) => e.event_name === 'model.block_started').map((e) => e.data.kind);
const order = [
  'delivery.received',
  'prompt.pushed',
  'turn.started',
  'harness.started',
  'model.response_started',
  'model.block_started',
  'model.block_stopped',
  'model.block_started',
  'model.block_stopped',
  'model.response_ended',
  'tool.completed',
  'model.response_started',
  'model.block_started',
  'model.block_stopped',
  'model.response_ended',
  'turn.ended',
  'turn.closed',
];
let at = -1;
check('turn 1: facts in order', order.every((e) => (at = names().indexOf(e, at + 1)) >= 0), names());
check('turn 1: nothing dropped as invalid', !names().includes('telemetry.dropped'), events().filter((e) => e.event_name === 'telemetry.dropped'));
check('turn 1: thinking, then the tool, then text', kinds().join() === 'thinking,tool,text', kinds());
const tool = events().find((e) => e.event_name === 'model.block_started' && e.data.kind === 'tool');
check('turn 1: the tool block names its call', tool?.tool_call_id === 'toolu_check1' && tool?.tool_name === 'Bash', tool);
const visible = events().filter((e) => e.event_name === 'surface.call' && e.turn_id === tool?.turn_id);
check('turn 1: every Slack call is reported under the turn', visible.length > 0, visible);
const ended = events().find((e) => e.event_name === 'turn.ended');
const shown = events().find((e) => e.event_name === 'thinking.shown');
check('turn 1: the Thinking… card is reported under the turn', !!shown && shown.turn_id === tool?.turn_id, shown);
check('turn 1: usage and API time from the result', ended?.outcome === 'completed' && (ended?.data.input_tokens as number) > 0 && ended?.data.api_ms !== undefined, ended);
check('turn 1: the model rides on model events', events().find((e) => e.event_name === 'model.response_started')?.model !== undefined, events()[4]);
check('nothing derived is reported', !events().some((e) => e.event_name !== 'surface.call' && e.event_name.startsWith('model.') && e.duration_ms !== undefined), names());

const t1 = ended?.turn_id;
await turn('thanks');
const started = events().filter((e) => e.event_name === 'turn.started');
check('turn 2 (warm): its own turn id and seq', started.length === 2 && started[1].turn_id !== t1 && started[1].data.turn_seq === 2 && started[1].path === 'warm', started);
check('turn 2: harness already up, no second harness.started', names().filter((e) => e === 'harness.started').length === 1, names());

// ---- a prewarmed harness: a new runner process for a new session
endHarness(s);
await sleep(300);
const before = events().length;
const fresh = () => events().slice(before);
runner({ ...info, sdkSessionId: undefined, key: 'k2', cwd: mkdtempSync(join(tmpdir(), 'telemetry-check-')) });
s.prewarm();
for (let i = 0; i < 100 && !fresh().some((e) => e.event_name === 'harness.started'); i++) {
  await sleep(100);
  await telemetry.flush();
}
const warm = fresh().find((e) => e.event_name === 'harness.started');
check('prewarm: harness.started before any turn, with no turn', !!warm && !warm.turn_id && !fresh().some((e) => e.event_name === 'turn.started'), fresh());
// New credentials before the first message: the harness is replaced, and the replacement reports its start too.
s.prewarm(true);
const starts = () => fresh().filter((e) => e.event_name === 'harness.started').length;
for (let i = 0; i < 100 && starts() < 2; i++) {
  await sleep(100);
  await telemetry.flush();
}
check('prewarm: a replaced harness’s successor reports its start', starts() === 2 && !fresh().some((e) => e.event_name === 'harness.started' && e.turn_id), fresh());
slackCalls.length = 0;
await turn('thanks');
const t3 = fresh().find((e) => e.event_name === 'turn.started');
check('prewarm: the turn has no harness.started of its own', !fresh().some((e) => e.event_name === 'harness.started' && e.turn_id), fresh().map((e) => e.event_name));
check('prewarm: the turn completes', fresh().some((e) => e.event_name === 'turn.ended' && e.turn_id === t3?.turn_id && e.outcome === 'completed'), fresh());
check('prewarm: a brand-new session still posts its intro', slackCalls.some((l) => l.includes('chat.postMessage') && l.includes('Thread k2')), slackCalls);

const out = process.argv.indexOf('--out');
if (out > 0) writeFileSync(process.argv[out + 1], events().map(eventLine).join('\n') + '\n');
console.log(failed ? `${failed} FAILED` : 'all passed');
endHarness(s);
api.close();
process.exit(failed ? 1 : 0);
