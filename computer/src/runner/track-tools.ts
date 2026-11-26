// The tools of a track's own session (work 118, section 41; `role: 'track'`):
// rename a thread or the track, tell or stop one of its threads, say where
// the track stands, and read and edit its Doc. Each is one call to the public
// API (work.ts, cloud.ts); Org enforces the role whatever a runner offers.
//
// Invariants: a Doc edit is saved on the revision last read here, so a Doc
// that moved since is read again, never overwritten; a change to a person's
// lines comes back `proposed` and is told as that, not retried.

import { z } from 'zod';
import { CloudError } from './cloud.js';
import { sessionOf } from './threads.js';
import { tool, type CalvinTool } from './tool.js';
import { answer, keyOf, notFor, said, SID, TID, type Work } from './work.js';

interface Doc {
  rev: number;
  text: string;
  spans: Array<{ from: number; to: number; by: string }>;
}

export function trackTools(w: Work): CalvinTool[] {
  const track = () => {
    const r = w.session().role;
    return r?.name === 'track' ? r.trackId : undefined;
  };
  /** Runs a track tool's body with the track's id; refused sooner for any other session. */
  const asTrack = (name: string, what: string, run: (tid: string) => Promise<string>) => {
    const tid = track();
    if (!tid) return Promise.resolve(said(notFor(w, name, { thread: false }) ?? `${name} is for a track's own session`, true));
    return answer(what, () => run(tid));
  };
  let doc: Doc | undefined;
  const readDoc = async (tid: string): Promise<Doc> => {
    // No route reads one Doc: it is a row of the feed, so a snapshot of that kind is read.
    const r = await w.api.call('GET', '/feed', { query: { kinds: 'doc' } });
    const row = (Array.isArray(r?.rows) ? r.rows : []).find((x: any) => x?.kind === 'doc' && (x.id === tid || x.trackId === tid));
    if (!row) throw new Error('this track has no Doc yet');
    doc = { rev: Number(row.rev), text: String(row.text ?? ''), spans: Array.isArray(row.spans) ? row.spans : [] };
    return doc;
  };
  const tools = [
    tool(
      'rename',
      'Rename a thread of this track, or the track. A name a person set stays: the refusal says so.',
      { target: z.string().describe('The thread (cs_…) or the track (trk_…)'), name: z.string().min(1).max(200) },
      ({ target, name }, call) =>
        asTrack('rename', 'not renamed', async () => {
          if (TID.test(target)) await w.api.call('PUT', `/work/tracks/${target}/name`, { body: { name }, key: keyOf(call) });
          else if (SID.test(target)) await w.api.call('PUT', `/work/threads/${target}/title`, { body: { title: name }, key: keyOf(call) });
          else throw new Error('target is a session id (cs_…) or a track id (trk_…)');
          return `Renamed ${target}.`;
        }),
    ),
    tool(
      'tell_thread',
      'Send a message to a thread of this track, as a turn there: it steers the thread if it is working.',
      { thread: z.string().describe('The thread: a session id (cs_…) or its Slack link'), message: z.string().min(1).max(100_000) },
      ({ thread, message }, call) =>
        asTrack('tell_thread', 'not told', async () => {
          const sid = await sessionOf(w, thread);
          await w.api.call('POST', `/sessions/${sid}/turns`, { body: { input: message, ifBusy: 'steer' }, key: keyOf(call) });
          return `Told ${sid}.`;
        }),
    ),
    tool('stop_thread', 'Stop what a thread of this track is doing now. It keeps its work and can be told to go on.', { thread: z.string().describe('The thread: a session id (cs_…) or its Slack link') }, ({ thread }, call) =>
      asTrack('stop_thread', 'not stopped', async () => {
        const sid = await sessionOf(w, thread);
        await w.api.call('POST', `/sessions/${sid}/interrupt`, { body: {}, key: keyOf(call) });
        return `Stopped ${sid}.`;
      }),
    ),
    tool('set_stand', 'Say where the track stands, in a line or two, as the person reads it at the top of the track: what is done, what is next, what waits on them.', { stand: z.string().min(1).max(2000) }, ({ stand }, call) =>
      asTrack('set_stand', 'stand not set', async (tid) => {
        await w.api.call('PUT', `/work/tracks/${tid}/stand`, { body: { stand }, key: keyOf(call) });
        return 'Set.';
      }),
    ),
    tool('doc_read', 'Read the track\'s Doc: its text, and which lines a person wrote. Read it before doc_edit.', {}, () =>
      asTrack('doc_read', 'could not read the Doc', async (tid) => {
        const d = await readDoc(tid);
        const theirs = d.spans.map((s) => `lines ${s.from}-${s.to} by ${s.by}`).join('; ');
        return [`Revision ${d.rev}.${theirs ? ` Written by a person (a change to these is proposed to them, not made): ${theirs}.` : ''}`, '---', d.text].join('\n');
      }),
    ),
    tool(
      'doc_edit',
      'Edit the track\'s Doc: replace `old`, which must occur exactly once in the text doc_read returned, with `new`. A change to lines a person wrote is proposed to them instead of made.',
      { old: z.string().describe('The text to replace; empty to append `new` at the end'), new: z.string() },
      ({ old, new: next }, call) =>
        asTrack('doc_edit', 'Doc not edited', async (tid) => {
          const d = doc ?? (await readDoc(tid));
          const count = old === '' ? 1 : d.text.split(old).length - 1;
          if (count !== 1) throw new Error(count ? `\`old\` occurs ${count} times; give more of the text around it` : '`old` is not in the Doc as last read; doc_read it again');
          const text = old === '' ? `${d.text}${d.text && !d.text.endsWith('\n') ? '\n' : ''}${next}` : d.text.replace(old, () => next);
          try {
            const r = await w.api.call('PUT', `/work/tracks/${tid}/doc`, { body: { baseRev: d.rev, text }, key: keyOf(call) });
            doc = { ...d, rev: Number(r?.value?.rev ?? d.rev + 1), text };
            return `Saved revision ${doc.rev}.`;
          } catch (e) {
            doc = undefined; // whatever was refused, the next edit starts from a fresh read
            if (e instanceof CloudError && e.reason === 'proposed') return 'These are a person\'s lines: the change is proposed to them and applies when they accept. Do not retry it.';
            if (e instanceof CloudError && e.code === 'conflict') throw new Error('the Doc changed since you read it; doc_read it again, then edit');
            throw e;
          }
        }),
    ),
  ];
  return tools as CalvinTool[];
}
