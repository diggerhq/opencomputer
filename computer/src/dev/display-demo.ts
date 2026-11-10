// Stream mock turns into a real Slack thread to compare task display styles.
//   npx tsx src/dev/display-demo.ts <channel> <thread_ts> <user_id> <team_id> [plan|rolling|opening|all]
// Uses SLACK_BOT_TOKEN from .env.

import { WebClient } from '@slack/web-api';
import type { AnyChunk } from '@slack/types';
import { loadEnv } from '../env.js';

loadEnv();
const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const [channel, thread_ts, user, team, which = 'all'] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STEPS = [
  { title: 'Read(calc.js)', output: '96 lines' },
  { title: 'Grep("evaluate", src/)', output: '3 matches' },
  { title: 'Edit(calc.js)', output: '+12 −3' },
  { title: 'Bash(npm test)', output: '✔ 5 pass' },
  { title: 'Bash(git commit -m "Add sqrt")', output: '[main 1a2b3c4]' },
];

async function stream(mode: 'plan' | 'timeline', first: AnyChunk[]) {
  const r = await client.chat.startStream({
    channel, thread_ts, recipient_user_id: user, recipient_team_id: team, task_display_mode: mode, chunks: first,
  });
  const ts = r.ts!;
  return {
    append: (chunks: AnyChunk[]) => client.chat.appendStream({ channel, ts, chunks }),
    stop: (footer: string) =>
      client.chat.stopStream({ channel, ts, blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }] }),
  };
}

const text = (t: string): AnyChunk => ({ type: 'markdown_text', text: t });

// A: Slack's plan mode. All tasks grouped in one plan block with a live title.
async function plan() {
  const s = await stream('plan', [text('*A · plan mode.* Adding `sqrt` to the calculator.\n\n'), { type: 'plan_update', title: 'Working…' }]);
  for (const [i, st] of STEPS.entries()) {
    await s.append([
      { type: 'plan_update', title: `Step ${i + 1} · ${st.title}` },
      { type: 'task_update', id: `a${i}`, title: st.title, status: 'in_progress' },
    ]);
    await sleep(1200);
    await s.append([{ type: 'task_update', id: `a${i}`, title: st.title, status: 'complete', output: st.output }]);
  }
  await s.append([{ type: 'plan_update', title: `Ran ${STEPS.length} steps` }, text('Done: `sqrt(x)` works and tests pass.')]);
  await s.stop('A · plan mode · demo');
}

// B: timeline, one card per run of consecutive steps; earlier steps fold into its details.
async function rolling() {
  const s = await stream('timeline', [text('*B · rolling card.* Adding `sqrt` to the calculator.\n\n')]);
  const done: string[] = [];
  const card = (title: string, status: 'in_progress' | 'complete', output?: string): AnyChunk => ({
    type: 'task_update', id: 'run1', title, status,
    ...(done.length ? { details: `${done.length} earlier: ${done.join(' · ')}` } : {}),
    ...(output ? { output } : {}),
  });
  for (const st of STEPS) {
    await s.append([card(st.title, 'in_progress')]);
    await sleep(1200);
    await s.append([card(st.title, 'complete', st.output)]);
    await sleep(300);
    done.push(`✓ ${st.title.replace(/\(.*/, '')}`);
  }
  const n = done.length;
  done.length = 0;
  await s.append([
    { type: 'task_update', id: 'run1', title: `Ran ${n} steps`, status: 'complete', details: STEPS.map((x) => x.title).join(' · ') },
    text('\n\nDone: `sqrt(x)` works and tests pass.'),
  ]);
  await s.stop('B · rolling card · demo');
}

// C: the message opens at push on a `Started` card (work 068), which becomes the first thing shown.
async function opening() {
  const started: AnyChunk = { type: 'task_update', id: 'open', title: 'Started', status: 'in_progress' };
  const flips: [string, AnyChunk[][]][] = [
    ['thinking first', [[{ type: 'task_update', id: 'open', title: 'Thinking… · reading the question', status: 'in_progress' }], [{ type: 'task_update', id: 'open', title: 'Thought for 2s', status: 'complete' }, text('Here is the answer.')]]],
    ['tool first', [[{ type: 'task_update', id: 'open', title: 'Bash(npm test)', status: 'in_progress' }], [{ type: 'task_update', id: 'open', title: 'Bash(npm test)', status: 'complete', output: '✔ 5 pass' }, text('Tests pass.')]]],
    ['text first', [[{ type: 'task_update', id: 'open', title: 'Started', status: 'complete' }, text('Hi.')]]],
    ['failed before any token', [[{ type: 'task_update', id: 'open', title: 'Started', status: 'error', details: 'error_max_turns' }]]],
  ];
  for (const [label, steps] of flips) {
    const s = await stream('timeline', [started]);
    for (const chunks of steps) {
      await sleep(1500);
      await s.append(chunks);
    }
    await s.stop(`C · opening card · ${label} · demo`);
  }
}

if (which === 'plan' || which === 'all') await plan().catch((e) => console.error('plan', e?.data ?? e));
if (which === 'rolling' || which === 'all') await rolling().catch((e) => console.error('rolling', e?.data ?? e));
if (which === 'opening' || which === 'all') await opening().catch((e) => console.error('opening', e?.data ?? e));
console.log('done');
