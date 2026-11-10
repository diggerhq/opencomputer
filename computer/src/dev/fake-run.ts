// Drive a Session against a fake Slack client that prints every API call.
// Approves permission prompts automatically after a short delay.
//   npx tsx src/dev/fake-run.ts "prompt" ["steer message sent 8s later"]
//   IMAGE=shot.png attaches a PNG to the first message, as a Slack upload would.
//   BLOCKS=1 prints message blocks in full.
//   STREAM_TTL_S=20 closes each stream that long after it started, as Slack
//   does (about 10 min): later appendStream calls fail message_not_in_streaming_state.
//   EXIT_AFTER_S=90 exits then, even mid-turn (an unanswered question never idles).
//   SP_CONTEXT_WINDOW and SP_COMPACT_AT as in the runner (Claude Code compacts near
//   window - 33k, 100000 being its floor; the fork compaction runs after a turn above
//   SP_COMPACT_AT). FACTS=1 prints the telemetry facts (runner/turn-events.ts);
//   FACTS=context.compacted,model.response_started prints only those.
//   NEXT="text" is sent once the first turn and any fork compaction are over;
//   NEXT_DURING_FORK_S=3 sends it that long after a fork compaction starts instead.
//   KEY=<key> RESUME=<sdk session id> resumes a conversation of an earlier run
//   (its key keeps the same working directory); the session id prints at exit.

import { Session, prompts } from '../runner/session.js';
import { panels } from '../runner/agents.js';
import { ensureWorkdir } from '../workspace.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Attachment } from '../runner/attachments.js';
import { configureCompaction } from '../runner/harness/claude/shadow.js';
import { TurnEvents } from '../runner/turn-events.js';
import { createTelemetry } from '../telemetry/emitter.js';

configureCompaction(process.env);
const facts = process.env.FACTS;
const telemetry = createTelemetry({
  service: 'runner',
  version: 'fake-run',
  region: 'local',
  base: { session_key: 'fake' },
  send: (b) => {
    for (const e of b.events)
      if (facts === '1' || facts?.split(',').includes(e.event_name)) console.log(stamp(), 'FACT', e.event_name, JSON.stringify({ duration_ms: e.duration_ms, data: e.data }));
  },
});

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(3)}s`;
let n = 0;
let clicked = false;
let sawOutput = false;
const short = (a: any) => {
  const s = JSON.stringify(a, (k, v) => (k === 'blocks' && !process.env.BLOCKS ? `[${v.length} blocks]` : v));
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
};
const method = (name: string) => async (args: any) => {
  console.log(stamp(), name, short(args));
  // The agents panel: print its rows as they would read.
  if (/subagent/.test(args.text ?? '') && args.blocks)
    for (const b of args.blocks) console.log('      |', (b.text?.text ?? b.elements?.[0]?.text ?? '').replace(/\n/g, ' ⏎ '), b.accessory ? `[${b.accessory.text.text}]` : '');
  // CLICK=stop|result presses the first such button on the panel once, like a user would.
  const btn = (args.blocks ?? []).map((b: any) => b.accessory?.action_id).find((id: string) => id?.split(':')[2] === process.env.CLICK);
  if (btn && !clicked) {
    clicked = true;
    const [, pid, verb, task] = btn.split(':');
    setTimeout(() => { console.log(stamp(), '>>> CLICK', verb); void panels.get(pid)?.onAction(verb, task, 'TRIGGER'); }, 1500);
  }
  if (name === 'chat.postMessage' && /Claude wants|Plan ready|Allow|wants to/i.test(args.text ?? '')) {
    setTimeout(() => {
      for (const p of prompts.values()) void p.onAction('allow', 'U_TEST');
    }, 500);
  }
  const ts = `1.${++n}`;
  if (name === 'chat.startStream') streamStarted.set(ts, Date.now());
  return { ok: true, ts, channel_id: 'C_FAKE' };
};
const ttl = Number(process.env.STREAM_TTL_S ?? 0) * 1000;
const streamStarted = new Map<string, number>();
const appendStream = async (args: any) => {
  const t = streamStarted.get(args.ts);
  if (ttl && t !== undefined && Date.now() - t > ttl) {
    console.log(stamp(), 'chat.appendStream', '✗ message_not_in_streaming_state', args.ts);
    throw Object.assign(new Error('message_not_in_streaming_state'), { data: { ok: false, error: 'message_not_in_streaming_state' } });
  }
  return method('chat.appendStream')(args);
};
const fake: any = {
  chat: {
    startStream: method('chat.startStream'),
    appendStream,
    stopStream: method('chat.stopStream'),
    postMessage: method('chat.postMessage'),
    update: method('chat.update'),
    delete: method('chat.delete'),
  },
  users: { info: async () => ({ user: { profile: { display_name: 'tester' } } }) },
  conversations: { info: async () => ({ channel: { name: 'fake-channel' } }) },
  agents: {
    sessions: { setStatus: method('agents.sessions.setStatus') },
    conversations: {
      setProperties: method('agents.conversations.setProperties'),
      setView: method('agents.conversations.setView'),
      archive: method('agents.conversations.archive'),
    },
  },
  reactions: { add: method('reactions.add') },
  files: {
    // The bytes go to upload_url; a data: URL accepts them without a server.
    getUploadURLExternal: async (a: any) => (await method('files.getUploadURLExternal')(a), { ok: true, upload_url: 'data:,', file_id: `F${++n}` }),
    completeUploadExternal: method('files.completeUploadExternal'),
  },
  views: { open: method('views.open') },
};

const [prompt, steer] = process.argv.slice(2);
const key = process.env.KEY || `fake-${Date.now()}`;
const sdkSessionId = process.env.RESUME || undefined;
const s = new Session(
  { key, kind: 'thread', channel: 'C_FAKE', threadTs: '1.0', userId: 'U_TEST', teamId: 'T_TEST', cwd: await ensureWorkdir(key), title: prompt.slice(0, 60), mode: 'default', sdkSessionId },
  fake,
  () => {},
  {
    turns: new TurnEvents(telemetry, { model: () => s.info.model, tierOf: () => undefined, provider: () => 'anthropic' }),
    // Marks where the model's first event of each turn lands among the Slack calls (work 068: the stream opens before it).
    busy: (b) => void (b && (sawOutput = false)),
    output: () => void (sawOutput || ((sawOutput = true), console.log(stamp(), '>>> first model event'))),
  },
);
if (facts) setInterval(() => void telemetry.flush(), 500);
const img = process.env.IMAGE;
const atts: Attachment[] = img
  ? [{ name: path.basename(img), path: path.resolve(img), mimetype: 'image/png', image: { media_type: 'image/png', data: readFileSync(img).toString('base64') } }]
  : [];
// `!` commands go to command(), as the router does; `!! text` is a prompt.
if (prompt.startsWith('!') && !prompt.startsWith('!!')) await s.command(prompt, 'U_TEST');
else await s.send(prompt, 'U_TEST', atts);
if (steer) setTimeout(() => { console.log(stamp(), '>>> STEER', steer); void s.send(steer, 'U_TEST'); }, 8000);
const exitAfter = Number(process.env.EXIT_AFTER_S ?? 0) * 1000;
if (exitAfter) setTimeout(() => { console.log(stamp(), `exiting after ${exitAfter / 1000}s; streams started: ${streamStarted.size}`); process.exit(0); }, exitAfter);
const next = process.env.NEXT;
const duringFork = Number(process.env.NEXT_DURING_FORK_S ?? 0) * 1000;
let nextSent = !next;
let forkSeen = false;
const sendNext = () => { nextSent = true; console.log(stamp(), '>>> NEXT', next); void s.send(next!, 'U_TEST'); };
let idle = 0;
setInterval(() => {
  if (s.shadow.running && !forkSeen) {
    forkSeen = true;
    console.log(stamp(), '>>> fork compaction running');
    if (duringFork && !nextSent) setTimeout(sendNext, duringFork);
  }
  idle = s.isBusy || s.shadow.running || [...panels.values()].some((p) => p.running) ? 0 : idle + 1;
  if (!nextSent && !duringFork && idle >= 3) return sendNext();
  if (idle >= 8 && nextSent && Date.now() - t0 > 15000) {
    console.log(stamp(), `idle, exiting; KEY=${key} RESUME=${s.info.sdkSessionId}`);
    void telemetry.flush().then(() => process.exit(0));
  }
}, 1000);
