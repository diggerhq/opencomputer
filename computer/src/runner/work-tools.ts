// The tools a thread's agent has on the work it belongs to (work 118, section
// 41): see the work, wrap itself into a track or start one, say it is ready or
// needs the person, propose done, record a result and its review summary, tell
// its track. Each is one call to the public API (work.ts, cloud.ts); Org
// decides what applies, and a refusal comes back as the tool's failed result.
//
// Invariants: an agent proposes and marks, it never decides for a person: a
// refusal is told, never worked around; every write carries the tool call's id.

import { z } from 'zod';
import { CloudError } from './cloud.js';
import { trackOf } from './spawn.js';
import { sessionOf } from './threads.js';
import { tool, type CalvinTool } from './tool.js';
import { answer, keyOf, notFor, said, TID, type Work, workId } from './work.js';

const MAX_LIST_CHARS = 60_000;

/** Org refused for a thread or a choice that is not this agent's: the case a proposal is for. */
const notMine = (e: unknown) => e instanceof CloudError && ['refused', 'not_found', 'forbidden'].includes(e.code);

export function workTools(w: Work): CalvinTool[] {
  const own = () => w.session().id;
  const tools = [
    tool('list_work', 'The work you can see: the open tracks and threads, with their ids, names and marks. Read it before placing, telling or starting something.', {}, () =>
      answer('could not list the work', async () => {
        const text = JSON.stringify(await w.api.call('GET', '/work/overview'), null, 1);
        return text.length > MAX_LIST_CHARS ? `${text.slice(0, MAX_LIST_CHARS)}\n[cut]` : text;
      }),
    ),
    tool(
      'track_this',
      'Make this thread a track: use it when the work has grown into several threads or will run for days. This thread becomes the track\'s first thread. The person can undo it, and an undo sticks.',
      { name: z.string().min(1).max(200).optional().describe('The track\'s name; omit to let it be named from the work') },
      ({ name }, call) => {
        const no = notFor(w, 'track_this', { track: false });
        if (no) return Promise.resolve(said(no, true));
        return answer('not made a track', async () => {
          const tid = workId('trk');
          await w.api.call('POST', '/work/tracks', { body: { tid, agentSessionId: workId('cs'), sid: own(), ...(name ? { name } : {}) }, key: keyOf(call) });
          return `This thread is now in the new track ${tid}.`;
        });
      },
    ),
    tool(
      'start_track',
      'From the start box only, in your first turn: start a track for what the person asked, instead of answering in this thread. `message` is the track\'s first message; this thread is removed.',
      { name: z.string().min(1).max(200).optional().describe('The track\'s name'), message: z.string().min(1).max(20_000).describe('What the track is asked to do') },
      ({ name, message }, call) => {
        const no = notFor(w, 'start_track', { track: false });
        if (no) return Promise.resolve(said(no, true));
        return answer('no track started', async () => {
          const tid = workId('trk');
          await w.api.call('POST', '/work/tracks', { body: { tid, agentSessionId: workId('cs'), firstInput: message, ...(name ? { name } : {}) }, key: keyOf(call) });
          return `Started the track ${tid}; this thread is removed. End your turn.`;
        });
      },
    ),
    tool(
      'place_thread',
      'Put a thread in a track. A track\'s agent places threads into its own track. A session the start box opened places itself into one of its owner\'s open tracks, once, in its first turn. ' +
        'Where the thread is not yours to move, this proposes the move to the person instead.',
      {
        thread: z.string().optional().describe('The thread: a session id (cs_…) or its Slack link; omit for this thread'),
        track: z.string().regex(TID).optional().describe('The track (trk_…); omit for this session\'s own track'),
      },
      ({ thread, track }, call) =>
        answer('not placed', async () => {
          const sid = thread ? await sessionOf(w, thread) : own();
          const trackId = track ?? (await trackOf(w));
          if (!trackId) throw new Error('name the track (trk_…); list_work shows them');
          try {
            await w.api.call('PUT', `/work/threads/${sid}/track`, { body: { trackId }, key: keyOf(call) });
            return `Placed ${sid} in ${trackId}.`;
          } catch (e) {
            if (sid === own() || !notMine(e)) throw e;
            const what = `Move this thread into the track`;
            await w.api.call('POST', '/work/proposals', { body: { proposalId: workId('prp'), kind: 'move', target: sid, what, args: { trackId } }, key: keyOf(call, 'propose') });
            return `Proposed to the person: move ${sid} into ${trackId}. It moves when they accept.`;
          }
        }),
    ),
    tool(
      'mark_ready',
      'Say this thread has something for the person to look at: `what` in one line, as they will read it in the list. Name the result (from add_result) when there is one.',
      { what: z.string().min(1).max(500).describe('One line: what is ready'), result: z.string().optional().describe('The result\'s id (res_…)') },
      ({ what, result }, call) =>
        answer('not marked ready', async () => {
          await w.api.call('PUT', `/work/threads/${own()}/ready`, { body: { what, ...(result ? { resultId: result } : {}) }, key: keyOf(call) });
          return 'Marked ready.';
        }),
    ),
    tool(
      'need_you',
      'Say this thread cannot go on without the person: `what` they must decide or do, in one line. It clears when they answer.',
      { what: z.string().min(1).max(500).describe('One line: what you need from the person') },
      ({ what }, call) =>
        answer('not marked', async () => {
          await w.api.call('PUT', `/work/threads/${own()}/attention`, { body: { what }, key: keyOf(call) });
          return 'Marked as needing the person.';
        }),
    ),
    tool(
      'propose_done',
      'Propose that this thread, or its track, is done: `what` was achieved, in one line. The person accepts or dismisses; you never mark done yourself.',
      { what: z.string().min(1).max(500).describe('One line: what was done'), target: z.enum(['thread', 'track']).optional().describe('`thread` (the default) or `track`') },
      ({ what, target }, call) =>
        answer('not proposed', async () => {
          const on = target === 'track' ? await trackOf(w) : own();
          if (!on) throw new Error('this session is in no track');
          await w.api.call('POST', '/work/proposals', { body: { proposalId: workId('prp'), kind: 'done', target: on, what }, key: keyOf(call) });
          return `Proposed done for the ${target ?? 'thread'}; the person decides.`;
        }),
    ),
    tool(
      'add_result',
      'Record what this thread produced, so it shows on the thread: a pull request (`pr`, ref its URL), changed files (`changes`, ref the branch or commit range), ' +
        'a `preview` (its URL), a `file` or a `document` (its workspace path or URL). The same kind and ref again updates the title.',
      { kind: z.enum(['pr', 'changes', 'preview', 'file', 'document']), ref: z.string().min(1).max(2000), title: z.string().min(1).max(300) },
      ({ kind, ref, title }, call) =>
        answer('result not added', async () => {
          const id = workId('res');
          const r = await w.api.call('PUT', `/work/results/${id}`, { body: { sid: own(), kind, ref, title }, key: keyOf(call) });
          return `Added the result ${r?.value?.resultId ?? id}.`;
        }),
    ),
    tool(
      'review_summary',
      'Write the summary a person reads when they review a result of this thread: `head` is the commit it describes, `parts` the summary by part (for each: what changed and why, what to look at).',
      { result: z.string().describe('The result\'s id (res_…)'), head: z.string().min(1).max(200).describe('The commit the summary describes'), parts: z.record(z.string(), z.unknown()).describe('The summary, by part') },
      ({ result, head, parts }, call) =>
        answer('summary not saved', async () => {
          await w.api.call('PUT', `/work/results/${result}/review`, { body: { head, parts }, key: keyOf(call) });
          return 'Saved the review summary.';
        }),
    ),
    tool(
      'tell_track',
      'Tell the agent of the track this thread is in something it should know: a finding, a blocker, that you are done. It arrives there as a message.',
      { message: z.string().min(1).max(100_000) },
      ({ message }, call) => {
        const no = notFor(w, 'tell_track', { track: false });
        if (no) return Promise.resolve(said(no, true));
        return answer('not told', async () => {
          await w.api.call('POST', '/work/tell-track', { body: { message }, key: keyOf(call) });
          return 'Told the track.';
        });
      },
    ),
  ];
  return tools as CalvinTool[];
}

/** `send_file` on a session with no Slack surface (section 41): the file is a result on the thread. */
export async function fileResult(w: Work, cwd: string, f: { path: string; title?: string; filename: string }): Promise<void> {
  const ref = f.path.startsWith(`${cwd}/`) ? f.path.slice(cwd.length + 1) : f.path;
  const kind = /\.(md|mdx|txt|pdf|docx?|html?)$/i.test(f.filename) ? 'document' : 'file';
  await w.api.call('PUT', `/work/results/${workId('res')}`, { body: { sid: w.session().id, kind, ref, title: f.title ?? f.filename }, key: `file:${kind}:${ref}` });
}
