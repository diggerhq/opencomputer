import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { invoke, jsonSchema, tool } from './tool.js';

const echo = tool('echo', 'Echo it', { text: z.string().describe('what to say'), times: z.number().optional() }, async (a) => ({
  content: [{ type: 'text', text: a.text.repeat(a.times ?? 1) }],
}));

describe('tool', () => {
  it('lists its input as JSON Schema, without the $schema line', () => {
    expect(jsonSchema(echo)).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string', description: 'what to say' }, times: { type: 'number' } },
      required: ['text'],
    });
    expect(jsonSchema(echo)).not.toHaveProperty('$schema');
  });

  it('runs on valid input', async () => {
    expect(await invoke(echo, { text: 'a', times: 2 })).toEqual({ content: [{ type: 'text', text: 'aa' }] });
  });

  it('answers invalid input and a throwing handler with a failed result', async () => {
    const bad = await invoke(echo, { times: 'x' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/^Invalid arguments for tool echo: text: .*; times: /);
    const boom = tool('boom', '', {}, async () => {
      throw new Error('nope');
    });
    expect(await invoke(boom, undefined)).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
  });
});
