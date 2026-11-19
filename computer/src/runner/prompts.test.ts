// Prompts and session roles (work 112, "Prompts"): who a prompt waits on, who
// may click it, and that a typed reply from any driver still declines it.

import { describe, expect, it } from 'vitest';
import type { KnownBlock } from '@slack/types';
import type { GateAsk } from './harness/types.js';
import { mayAnswer, permissionPrompt, type PromptHost, prompts, waitingLine } from './prompts.js';

/** A host whose thread records what it posts. */
function host(driver?: string) {
  const posted: KnownBlock[][] = [];
  const h = {
    info: { key: 'C1:1.0', cwd: '/tmp/w' },
    thread: {
      post: async (_text: string, blocks: KnownBlock[]) => (posted.push(blocks), '9.9'),
      update: async () => {},
      delete: async () => {},
      userName: async (id: string) => id,
    },
    ...(driver ? { driver } : {}),
    patchTask() {},
    rotate() {},
    persist() {},
  };
  return { h: h as unknown as PromptHost, posted };
}

const ask = (): GateAsk => ({ id: 't1', kind: 'tool', canRemember: false, signal: new AbortController().signal }) as unknown as GateAsk;
const contextLine = (blocks: KnownBlock[]) => JSON.stringify(blocks.at(-1));

describe('mayAnswer', () => {
  it('refuses a driver’s click only when the prompt waits on someone else', () => {
    expect(mayAnswer({ asked: 'U2' }, 'driver', 'U3')).toBe(false);
    expect(mayAnswer({}, 'driver', 'U3')).toBe(false);
    expect(mayAnswer({ asked: 'U2' }, 'driver', 'U2')).toBe(true);
    expect(mayAnswer({ asked: 'U2' }, 'owner', 'U1')).toBe(true);
    expect(mayAnswer({ asked: 'U2' }, undefined, 'U3')).toBe(true);
  });
});

describe('the prompt', () => {
  it('names the driver it waits on, and only then', async () => {
    expect(waitingLine(undefined, 'or reply')).toBe('or reply');
    const theirs = host('U2');
    const mine = host();
    void permissionPrompt(theirs.h, 'Bash', { command: 'ls' }, ask());
    void permissionPrompt(mine.h, 'Bash', { command: 'ls' }, ask());
    await new Promise((r) => setImmediate(r));
    expect(contextLine(theirs.posted[0])).toContain('Waiting on <@U2> · or reply here to decline');
    expect(contextLine(mine.posted[0])).not.toContain('Waiting on');
    expect([...prompts.values()].map((p) => p.asked)).toEqual(['U2', undefined]);
    for (const p of [...prompts.values()]) await p.cancel();
  });

  it('a typed reply from another driver declines it, as before', async () => {
    const { h } = host('U2');
    const decision = permissionPrompt(h, 'Bash', { command: 'ls' }, ask());
    await new Promise((r) => setImmediate(r));
    const [p] = [...prompts.values()];
    await p.onText('use rg instead', 'U3');
    expect(await decision).toMatchObject({ behavior: 'deny', message: 'The user declined and said: use rg instead' });
  });
});
