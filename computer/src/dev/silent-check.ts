// The silent-turn mechanics without Claude: scripted model streams into a
// Session with a fake Slack client. A reply that is exactly SILENT posts
// nothing (and removes a thinking card that made it out); SILENT is never shown.
//   npx tsx src/dev/silent-check.ts

import { Translator } from '../runner/harness/claude/translate.js';
import { Session, SILENT } from '../runner/session.js';

let n = 0;
const calls: { method: string; args: any }[] = [];
const method = (name: string) => async (args: any) => {
  calls.push({ method: name, args });
  return { ok: true, ts: `1.${++n}`, channel_id: 'C_FAKE' };
};
const fake: any = {
  chat: Object.fromEntries(['startStream', 'appendStream', 'stopStream', 'postMessage', 'update', 'delete'].map((m) => [m, method(`chat.${m}`)])),
  agents: { sessions: { setStatus: method('agents.sessions.setStatus') } },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const s = new Session(
  { key: 'k', kind: 'thread', channel: 'C_FAKE', threadTs: '1.0', userId: 'U1', cwd: '/tmp', title: 't', mode: 'default' },
  fake,
  () => {},
);
const t = new Translator();
const feed = async (m: any) => {
  for (const e of t.translate(m)) (s as any).onEvent(e);
};
const ev = (event: any) => feed({ type: 'stream_event', parent_tool_use_id: null, event });

/** One turn whose reply is one text block streamed in `parts`, optionally after a long thinking block. */
async function turn(parts: string[], thinkMs = 0) {
  calls.length = 0;
  let i = 0;
  if (thinkMs) {
    await ev({ type: 'content_block_start', index: i, content_block: { type: 'thinking' } });
    await sleep(thinkMs);
    await ev({ type: 'content_block_stop', index: i++ });
  }
  await ev({ type: 'content_block_start', index: i, content_block: { type: 'text' } });
  for (const p of parts) await ev({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: p } });
  await ev({ type: 'content_block_stop', index: i });
  await feed({ type: 'result', subtype: 'success', total_cost_usd: 0 });
  await sleep(300);
  return [...calls];
}
const shown = (c: typeof calls) =>
  c.flatMap((x) => [
    ...(x.args.chunks ?? []).map((k: any) => k.text ?? ''),
    ...(x.args.blocks ?? []).map((b: any) => b.text ?? b.elements?.[0]?.text ?? ''),
  ]).join('');
const posted = (c: typeof calls) => c.filter((x) => x.method.startsWith('chat.') && x.method !== 'chat.delete');

let failed = 0;
function check(name: string, ok: boolean, got: unknown) {
  if (!ok) failed++;
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(got).slice(0, 800));
}

const a = await turn(['<no-', 'reply', '/>']);
check('SILENT split across deltas → nothing posted', posted(a).length === 0, a);
check('SILENT → status back to active', a.some((x) => x.args.status === 'active'), a);

const b = await turn(['Hello ', 'there']);
check('normal reply streamed with footer', shown(b).includes('Hello there') && /\$0\.00/.test(shown(b)), b);

const c = await turn(['<b>bold</b> ok']);
check('text starting like a tag is shown', shown(c).includes('<b>bold</b> ok'), c);

const d = await turn([' ', SILENT, ' ']);
check('SILENT with surrounding whitespace → nothing posted', posted(d).length === 0, d);

const e = await turn([SILENT, '\n\nActually, one note.']);
check('SILENT followed by text → text shown, SILENT not', shown(e).includes('Actually, one note.') && !shown(e).includes(SILENT), e);

const f = await turn([SILENT], 1800);
check('SILENT after a visible thinking card → card message deleted, no footer',
  f.some((x) => x.method === 'chat.delete') && !/\$0\.00/.test(shown(f)), f);

calls.length = 0;
await ev({ type: 'message_start', message: { usage: {} } });
await feed({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content: [{ type: 'text', text: 'Invalid auth token' }] },
});
await feed({ type: 'result', subtype: 'success', total_cost_usd: 0 });
await sleep(300);
const g = [...calls];
check('final-only SDK error is shown instead of an empty completion', shown(g).includes('Invalid auth token'), g);

calls.length = 0;
await ev({ type: 'message_start', message: { usage: {} } });
await feed({
  type: 'assistant',
  parent_tool_use_id: null,
  error: 'billing_error',
  message: { content: [{ type: 'text', text: 'API Error: 402 {"error":{"message":"This request requires more credits"}}' }] },
});
await feed({ type: 'result', subtype: 'success', total_cost_usd: 0 });
await sleep(300);
const p = [...calls];
check('out of credits → nothing posted (the gateway posts the paywall)', posted(p).length === 0, p);

calls.length = 0;
await ev({ type: 'message_start', message: { usage: {} } });
await feed({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'look around', prompt: 'x' } }] },
});
await feed({
  type: 'assistant',
  parent_tool_use_id: 'toolu_task',
  message: { content: [{ type: 'text', text: 'subagent musing' }] },
});
await feed({ type: 'result', subtype: 'success', total_cost_usd: 0 });
await sleep(300);
const h = [...calls];
check('subagent text is not shown as the reply', !shown(h).includes('subagent musing'), h);

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
