import net from 'node:net';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../protocol.js';
import { createTelemetry } from '../telemetry/emitter.js';
import type { SandboxStarts, Started } from './sandbox/start.js';
import { type StartDeps, runnerStarts } from './start-runner.js';

const owner = { dir: 'pat', gitName: 'Pat', gitEmail: 'pat@example.com' };
const spec: SessionSpec = { key: 'C1:1.1', kind: 'thread', owner, title: 't', mode: 'default' };
const record = { id: 'aaaaaaaaaaaaaaaa', person: 'pat', key: 'C1:1.1', createdAt: '', usedAt: '' };

/** A host whose sandbox start hands back `sock`; `log` says what was done with it. */
function rig(sock: net.Socket) {
  const log: string[] = [];
  const started: Started = { record, run: '/run/sp/sandbox/a', sock, session: spec, resumed: false, abandon: async () => void log.push('abandoned') };
  const sandbox: SandboxStarts = { start: async () => started };
  const d = {
    tm: createTelemetry({ service: 'host', version: 'v', region: 'r', send: () => {} }),
    sandbox,
    serveTokens: () => ({ close: () => void log.push('tokens closed') }),
    creds: () => undefined, forRunner: () => undefined,
    register: () => void log.push('registered'), closed: () => {}, message: () => {}, exit: () => void log.push('exit sent'),
  } as unknown as StartDeps;
  return { log, start: () => runnerStarts(d).startRunner(spec, {}) };
}

describe('a sandboxed start that is not taken on', () => {
  it('a runner that exited while it started: its container is stopped and its token socket closed', async () => {
    const sock = new net.Socket();
    sock.destroy();
    const t = rig(sock);
    await expect(t.start()).rejects.toThrow('runner exited while it started');
    expect(t.log).toEqual(['abandoned']);
  });

  it('a runner that is there is taken on, and nothing of it is stopped', async () => {
    const sock = new net.Socket();
    const t = rig(sock);
    const r = await t.start();
    expect(r).toMatchObject({ id: record.id, key: 'C1:1.1', sandbox: { record } });
    expect(t.log).toEqual(['registered']);
    sock.destroy();
  });
});
