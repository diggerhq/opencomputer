// A multi-person thread against real Claude and a fake Slack client: messages
// not addressed to the agent post nothing; ones that are get an answer.
//   npx tsx src/dev/addressing-check.ts

import { Session, SILENT } from '../runner/session.js';
import { ensureWorkdir } from '../workspace.js';

const OWNER = 'U_OWNER';
const posts: { method: string; text: string }[] = [];
let n = 0;
const text = (a: any) =>
  [a.text, ...(a.chunks ?? []).map((c: any) => c.text ?? ''), ...(a.blocks ?? []).map((b: any) => b.text ?? b.elements?.[0]?.text ?? '')]
    .filter((t) => typeof t === 'string' && t.trim())
    .join(' ');
const method = (name: string) => async (args: any) => {
  if (!name.startsWith('agents.')) posts.push({ method: name, text: text(args) });
  return { ok: true, ts: `1.${++n}`, channel_id: 'C_FAKE' };
};
const fake: any = {
  chat: Object.fromEntries(['startStream', 'appendStream', 'stopStream', 'postMessage', 'update', 'delete'].map((m) => [m, method(`chat.${m}`)])),
  users: { info: async () => ({ user: { profile: { display_name: 'tester' } } }) },
  conversations: { info: async () => ({ channel: { name: 'fake-channel' } }) },
  agents: { sessions: { setStatus: method('agents.sessions.setStatus') } },
  reactions: { add: method('reactions.add') },
};

const key = `addressing-${Date.now()}`;
const s = new Session(
  { key, kind: 'thread', channel: 'C_FAKE', threadTs: '1.0', userId: OWNER, cwd: await ensureWorkdir(key), title: 'addressing', mode: 'default' },
  fake,
  () => {},
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function say(user: string, mentioned: boolean, msg: string) {
  posts.length = 0;
  await s.send(msg, user, [], mentioned);
  while (s.isBusy) await sleep(200);
  await sleep(500);
  return [...posts];
}

let failed = 0;
function check(name: string, ok: boolean, got: unknown) {
  if (!ok) failed++;
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(got).slice(0, 600));
}
const shown = (p: typeof posts) => p.filter((x) => x.method !== 'chat.delete').map((x) => x.text).join(' ');

const a = await say(OWNER, true, 'Reply with exactly the word: ready');
check('mentioned → answers', /ready/i.test(shown(a)), a);

const b = await say(OWNER, false, '@U_ALICE can you review the PR when you get a sec?');
check('owner talking to someone else → nothing posted', !shown(b), b);

const c = await say('U_ALICE', false, 'yep, on it after lunch');
check("someone else's reply → nothing posted", !shown(c), c);

const d = await say(OWNER, false, "what's 2+2? just the number");
check('owner asks a question, no mention → answers', /\b4\b/.test(shown(d)), d);

for (const p of [a, b, c, d]) check('sentinel never shown', !shown(p).includes(SILENT), p);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
