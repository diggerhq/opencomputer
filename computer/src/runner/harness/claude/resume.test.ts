import { describe, expect, it } from 'vitest';
import { resumable } from './resume.js';

describe('resumable', () => {
  it('keeps an id whose transcript is there', async () => {
    const asked: unknown[] = [];
    expect(await resumable('sdk-1', '/workspace', async (...a) => (asked.push(a), { sessionId: 'sdk-1' }))).toBe('sdk-1');
    expect(asked).toEqual([['sdk-1', { dir: '/workspace' }]]);
  });

  it('drops an id with no transcript: a new conversation, not a harness that exits at every message', async () => {
    expect(await resumable('codex-thread', '/workspace', async () => undefined)).toBeUndefined();
  });

  it('keeps the id when the lookup fails: a conversation is not dropped on a doubt', async () => {
    expect(await resumable('sdk-1', '/workspace', async () => Promise.reject(new Error('EACCES')))).toBe('sdk-1');
  });

  it('no id asks nothing', async () => {
    expect(await resumable(undefined, '/workspace', async () => Promise.reject(new Error('asked')))).toBeUndefined();
  });
});
