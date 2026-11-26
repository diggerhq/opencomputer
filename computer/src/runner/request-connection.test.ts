import { describe, expect, it } from 'vitest';
import type { ConnectionRequest } from '../protocol.js';
import { requestConnectionTool } from './request-connection.js';
import { invoke } from './tool.js';

function tool(fail?: string) {
  const asked: ConnectionRequest[] = [];
  const t = requestConnectionTool(async (req) => {
    if (fail) throw new Error(fail);
    asked.push(req);
  });
  const run = async (input: object) => {
    const r = await t.handler(input as never);
    return { text: (r.content[0] as { text: string }).text, isError: !!r.isError };
  };
  return { asked, run, t };
}

describe('request_connection', () => {
  it('asks once per service, with a one-line reason, and says to end the turn', async () => {
    const t = tool();
    const r = await t.run({ service: 'linear', reason: 'To file\n the bug' });
    expect(r).toEqual({ text: expect.stringContaining('End your turn'), isError: false });
    expect(t.asked).toEqual([{ service: 'linear', reason: 'To file the bug' }]);
    expect((await t.run({ service: 'linear', reason: 'again' })).isError).toBe(true);
    expect(t.asked).toHaveLength(1);
    expect((await t.run({ service: 'gmail', reason: 'To read mail' })).isError).toBe(false);
    expect(t.asked).toHaveLength(2);
  });

  it("returns the gateway's refusal as an error, and lets the agent ask again", async () => {
    const t = tool('unknown session');
    expect(await t.run({ service: 'gmail', reason: 'To read mail' })).toEqual({ text: 'could not ask: unknown session', isError: true });
    expect(await t.run({ service: 'gmail', reason: 'To read mail' })).toEqual({ text: 'could not ask: unknown session', isError: true });
  });

  it('offers only the services the gateway grants: github is not one', async () => {
    const t = tool();
    const r = await invoke(t.t, { service: 'github', reason: 'To open a PR' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Invalid arguments for tool request_connection');
    expect(t.asked).toEqual([]);
  });
});
