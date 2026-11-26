import { describe, expect, it } from 'vitest';
import type { Wire } from './app-server.js';
import { type Namer, nameThread, said } from './title.js';

const user = (text: string) => ({ type: 'userMessage', content: [{ type: 'text', text }] });
const agent = (text: string) => ({ type: 'agentMessage', text });
const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ items: [user(`ask ${i}`), { type: 'commandExecution' }, agent(`done ${i}`)] }));

/** An app-server whose thread `main` has `history`, and whose naming thread replies `reply`. */
function fake(history: { name?: string; turns: unknown[] }, reply = 'Fix the login page') {
  const sent: { method: string; params: Wire }[] = [];
  const on = new Map<string, (method: string, p: Wire) => void>();
  const n: Namer = {
    model: 'gpt-5.5',
    cwd: '/work',
    listen: (thread, f) => (on.set(thread, f), () => on.delete(thread)),
    async request<T>(method: string, params: Wire) {
      sent.push({ method, params });
      if (method === 'thread/read') return { thread: history } as T;
      if (method === 'thread/start') return { thread: { id: 'namer' } } as T;
      if (method === 'turn/start')
        setTimeout(() => {
          on.get('namer')?.('item/completed', { threadId: 'namer', item: agent(`"${reply}."`) });
          on.get('namer')?.('turn/completed', { threadId: 'namer', turn: { status: 'completed' } });
        });
      return {} as T;
    },
  };
  return { n, sent, on };
}

describe('said', () => {
  it('keeps people and the agent, not tools', () => {
    expect(said(turns(1))).toEqual([
      { person: true, text: 'ask 0' },
      { person: false, text: 'done 0' },
    ]);
  });
});

describe('nameThread', () => {
  it('does not ask while the conversation is short', async () => {
    const f = fake({ turns: turns(2) });
    expect(await nameThread(f.n, 'main')).toEqual({ done: false });
    expect(f.sent.map((s) => s.method)).toEqual(['thread/read']);
  });

  it('reads back a name the thread already has', async () => {
    const f = fake({ name: 'Compare hosting costs', turns: turns(5) });
    expect(await nameThread(f.n, 'main')).toEqual({ title: 'Compare hosting costs', done: true });
    expect(f.sent.map((s) => s.method)).toEqual(['thread/read']);
  });

  it('names the thread on an ephemeral one, keeps the name, and lets the naming thread go', async () => {
    const f = fake({ turns: turns(3) });
    expect(await nameThread(f.n, 'main')).toEqual({ title: 'Fix the login page', done: true });
    expect(f.sent.map((s) => s.method)).toEqual(['thread/read', 'thread/start', 'turn/start', 'thread/unsubscribe', 'thread/name/set']);
    expect(f.sent[1]!.params).toMatchObject({ ephemeral: true, model: 'gpt-5.5', approvalPolicy: 'never' });
    expect(f.sent[2]!.params.input[0].text).toContain('Person: ask 2');
    expect(f.sent.at(-1)!.params).toEqual({ threadId: 'main', name: 'Fix the login page' });
    expect(f.on.size).toBe(0);
  });

  it('keeps the title before when the naming turn fails', async () => {
    const f = fake({ turns: turns(3) });
    f.n.request = async <T,>(method: string) => {
      if (method === 'thread/read') return { thread: { turns: turns(3) } } as T;
      throw new Error('proxy down');
    };
    expect(await nameThread(f.n, 'main')).toBeUndefined();
  });
});
