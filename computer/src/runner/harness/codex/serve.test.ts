import { describe, expect, it } from 'vitest';
import type { GateAsk, GateDecision, Mode } from '../types.js';
import { type Wire, RpcError } from './app-server.js';
import { Served } from './serve.js';

function served(decide: (name: string, input: Wire, ask: GateAsk) => GateDecision | Promise<GateDecision>, mode: Mode = 'default') {
  const asks: { name: string; input: Wire; ask: GateAsk }[] = [];
  const host = {
    mode,
    items: new Map<string, Wire>(),
    setMode(m: Mode) {
      host.mode = m;
    },
    item: (id: string) => host.items.get(id),
    gate: async (name: string, input: Wire, ask: GateAsk) => (asks.push({ name, input, ask }), decide(name, input, ask)),
  };
  const read = async () => ({ ok: true, messages: [{ name: 'a', ts: '1', text: 'hello' }] }) as Wire;
  const s = new Served({ cwd: () => '/w', hooks: { threads: { read, post: read } }, sendFile: (async () => ({})) as Wire, postCard: (async () => ({})) as Wire }, host);
  return { s, host, asks };
}
const allow: GateDecision = { behavior: 'allow', updatedInput: {} };

describe('Served', () => {
  it('offers Calvin tools as dynamic tools with JSON Schemas', () => {
    const specs = served(() => allow).s.specs();
    const read = specs.find((t) => t.name === 'read_thread')!;
    expect(read.type).toBe('function');
    expect(read.inputSchema).toMatchObject({ type: 'object', properties: { url: { type: 'string' } } });
    expect(read.inputSchema).not.toHaveProperty('$schema');
  });

  it('a command approval asks as Bash, with the reason; the answers map to Codex decisions', async () => {
    const { s, asks } = served(() => ({ ...allow, remember: true }));
    const p = {
      threadId: 't',
      turnId: 'u',
      itemId: 'i1',
      command: "/bin/bash -lc 'ls'",
      commandActions: [{ type: 'listFiles', command: 'ls' }],
      cwd: '/w',
      reason: 'to look',
    };
    expect(await s.request('item/commandExecution/requestApproval', p, 7)).toEqual({ decision: 'acceptForSession' });
    expect(asks[0]).toMatchObject({
      name: 'Bash',
      input: { command: 'ls', cwd: '/w' },
      ask: { id: 'i1', kind: 'command', reason: 'to look', canRemember: true },
    });
    const deny = served(() => ({ behavior: 'deny', message: 'no' })).s;
    expect(await deny.request('item/commandExecution/requestApproval', p, 8)).toEqual({ decision: 'decline' });
    const stop = served(() => ({ behavior: 'deny', message: 'no', interrupt: true })).s;
    expect(await stop.request('item/commandExecution/requestApproval', p, 9)).toEqual({ decision: 'cancel' });
  });

  it('an ask resolved right after its request (the same chunk) is aborted, not left waiting', async () => {
    const { s, asks } = served(() => new Promise<GateDecision>(() => {}));
    void s.request('item/commandExecution/requestApproval', { itemId: 'i', command: 'ls' }, 3);
    s.resolved(3);
    await Promise.resolve();
    expect(asks[0].ask.signal?.aborted).toBe(true);
  });

  it('a file change asks as Edit or Write with its diff, from the item it names', async () => {
    const { s, host, asks } = served(() => allow);
    host.items.set('f', { id: 'f', type: 'fileChange', changes: [{ path: '/w/new.ts', diff: '+x', kind: { type: 'add' } }] });
    expect(await s.request('item/fileChange/requestApproval', { itemId: 'f' }, 1)).toEqual({ decision: 'accept' });
    expect(asks[0]).toMatchObject({ name: 'Write', input: { file_path: '/w/new.ts', diff: '+x' }, ask: { kind: 'edit' } });
  });

  it("a question is AskUserQuestion; answers go back by Codex's question ids", async () => {
    const { s, asks } = served((_n, input) => ({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which?': 'B' } } }));
    const p = {
      itemId: 'q',
      questions: [
        {
          id: 'q1',
          header: 'Pick',
          question: 'Which?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
        },
      ],
    };
    expect(await s.request('item/tool/requestUserInput', p, 2)).toEqual({ answers: { q1: { answers: ['B'] } } });
    expect(asks[0]).toMatchObject({ name: 'AskUserQuestion', ask: { kind: 'question', canRemember: false } });
  });

  it('a Calvin tool call is gated in default mode except read_thread, remembered when allowed for the session, and schema-checked', async () => {
    const { s, asks } = served(() => ({ ...allow, remember: true }));
    const ok = await s.request('item/tool/call', { callId: 'c1', tool: 'read_thread', arguments: { url: 'https://x.slack.com/archives/C1/p1' } }, 3);
    expect(ok).toMatchObject({ contentItems: [{ type: 'inputText' }] });
    expect(asks).toHaveLength(0);
    const bad = (await s.request('item/tool/call', { callId: 'c2', tool: 'post_thread', arguments: { text: 5 } }, 4)) as Wire;
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ name: 'mcp__calvin__post_thread', ask: { kind: 'tool', id: 'c2' } });
    expect(bad.success).toBe(false);
    expect(bad.contentItems[0].text).toMatch(/Invalid arguments for tool post_thread/);
    await s.request('item/tool/call', { callId: 'c3', tool: 'post_thread', arguments: {} }, 5);
    expect(asks).toHaveLength(1);
    expect(await s.request('item/tool/call', { callId: 'c4', tool: 'nope', arguments: {} }, 6)).toMatchObject({ success: false });
  });

  it('a denied tool call fails with the reason, and bypass mode asks nothing', async () => {
    const { s } = served(() => ({ behavior: 'deny', message: 'not now' }));
    expect(await s.request('item/tool/call', { callId: 'c', tool: 'post_thread', arguments: {} }, 1)).toEqual({
      contentItems: [{ type: 'inputText', text: 'not now' }],
      success: false,
    });
    const by = served(() => ({ behavior: 'deny', message: 'x' }), 'bypassPermissions');
    await by.s.request('item/tool/call', { callId: 'c', tool: 'post_thread', arguments: {} }, 1);
    expect(by.asks).toHaveLength(0);
  });

  it('an ask Codex stops waiting for, or the turn ends under, is aborted', async () => {
    const signals: AbortSignal[] = [];
    const { s } = served(
      (_n, _i, ask) =>
        new Promise((r) => (signals.push(ask.signal), ask.signal.addEventListener('abort', () => r({ behavior: 'deny', message: 'aborted' })))),
    );
    const a = s.request('item/commandExecution/requestApproval', { itemId: 'a', command: 'x' }, 10);
    const b = s.request('item/commandExecution/requestApproval', { itemId: 'b', command: 'y' }, 11);
    await Promise.resolve();
    s.resolved(10);
    expect(await a).toEqual({ decision: 'decline' });
    expect(signals[1].aborted).toBe(false);
    s.abortAll();
    expect(await b).toEqual({ decision: 'decline' });
  });

  it('refuses requests it does not serve, the ChatGPT token refresh among them', async () => {
    const { s } = served(() => allow);
    await expect(s.request('account/chatgptAuthTokens/refresh', {}, 1)).rejects.toBeInstanceOf(RpcError);
  });
});
