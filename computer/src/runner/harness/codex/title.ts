// A Codex session's display name (work 093), as claude/title.ts is Claude
// Code's, but in one stage: Codex writes no title of its own over the
// app-server, so the thread keeps its opening message until people have sent
// `TITLE_AFTER` messages; then a one-off thread on the same app-server names
// it, and `thread/name/set` keeps the name in the thread, so a runner that
// restarts reads it back instead of asking again.
//
// Invariants:
// - it never fails: no title is an answer (the one before stays);
// - the naming thread is ephemeral (never written to disk), runs on the
//   session's model and credentials, has no tools and is let go when done.

import { log } from '../../../log.js';
import { cleanTitle, conversation, type Naming, type Said, TITLE_AFTER, TITLE_PROMPT } from '../title.js';
import type { Wire } from './app-server.js';
import { PROVIDER } from './config.js';

const TIMEOUT_MS = 60_000;

/** What naming needs of the harness: its app-server, and the notifications of a thread of its own. */
export interface Namer {
  request<T>(method: string, params: unknown): Promise<T>;
  /** Hands `thread`'s notifications to `on` until the returned function is called. */
  listen(thread: string, on: (method: string, p: Wire) => void): () => void;
  model: string;
  cwd: string;
}

type Item = { type?: string; text?: string; content?: { type?: string; text?: string }[] };

/** The main conversation in a thread's turns: people's messages and the agent's, no tool calls. */
export function said(turns: { items?: Item[] }[]): Said[] {
  return turns.flatMap((t) =>
    (t.items ?? []).flatMap((i): Said[] => {
      if (i.type === 'agentMessage') return [{ person: false, text: i.text ?? '' }];
      if (i.type !== 'userMessage') return [];
      return [{ person: true, text: (i.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') }];
    }),
  );
}

/** `thread`'s title after a turn: its name once it has one, nothing while it is short. Undefined on any failure. */
export async function nameThread(n: Namer, thread: string): Promise<Naming | undefined> {
  try {
    const { thread: t } = await n.request<{ thread: { name?: string | null; turns?: { items?: Item[] }[] } }>('thread/read', { threadId: thread, includeTurns: true });
    if (t.name) return { title: t.name, done: true };
    const { said: count, text } = conversation(said(t.turns ?? []));
    if (count < TITLE_AFTER) return { done: false };
    const title = cleanTitle(await ask(n, text));
    if (!title) return { done: false };
    await n.request('thread/name/set', { threadId: thread, name: title });
    return { title, done: true };
  } catch (e) {
    log.warn(`codex: naming the session failed: ${(e as Error).message}`);
    return undefined;
  }
}

/** The reply of a one-off thread with `TITLE_PROMPT` as its only instructions to `convo`. */
async function ask(n: Namer, convo: string): Promise<string> {
  const { thread } = await n.request<{ thread: { id: string } }>('thread/start', {
    model: n.model,
    modelProvider: PROVIDER,
    cwd: n.cwd,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    baseInstructions: TITLE_PROMPT,
  });
  let stop = () => {};
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let reply = '';
      timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS);
      stop = n.listen(thread.id, (method, p) => {
        if (method === 'item/completed' && p.item?.type === 'agentMessage') reply = p.item.text ?? reply;
        if (method === 'turn/completed') p.turn?.status === 'completed' ? resolve(reply) : reject(new Error(`turn ${p.turn?.status}`));
      });
      n.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: convo, text_elements: [] }], effort: 'low' }).catch(reject);
    });
  } finally {
    clearTimeout(timer);
    stop();
    n.request('thread/unsubscribe', { threadId: thread.id }).catch(() => {});
  }
}
