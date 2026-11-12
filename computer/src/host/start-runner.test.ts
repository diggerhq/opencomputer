import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { send } from '../ipc.js';
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
    register: () => void log.push('registered'), closed: () => void log.push('closed'), message: (_r: unknown, m: { t: string }) => void log.push(`message ${m.t}`), exit: () => void log.push('exit sent'),
    stopSandbox: async (id: string) => void log.push(`stopped ${id}`),
  } as unknown as StartDeps;
  return { log, start: () => runnerStarts(d).startRunner(spec, {}),
    /** Host restart: the runner found in the record's container (sandbox/sweep.ts). */
    takeBack: (s: net.Socket) => runnerStarts({ ...d, exit: (x: net.Socket) => (log.push('exit sent'), x.destroy()) } as StartDeps).adopt(record.id, s, { verify: true, sandbox: { record: { ...record, repos: {} }, run: '/run/sp/sandbox/a' } }) };
}

/** A connected pair: the host's end, and the runner's to write its first message on. */
async function pair(): Promise<{ host: net.Socket; runner: net.Socket; close(): void }> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'adopt-')), 's');
  const server = net.createServer();
  await new Promise<void>((ok) => server.listen(file, ok));
  const runner = new Promise<net.Socket>((ok) => server.once('connection', ok));
  const host = net.connect(file);
  return { host, runner: await runner, close: () => (host.destroy(), server.close()) };
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

  it('a runner that reports another thread once it was taken on is not asked to go: its socket is destroyed and its container stopped', async () => {
    const p = await pair();
    const t = rig(p.host);
    await t.start();
    send(p.runner, { t: 'report', report: { key: 'C1:1.1', status: 'idle', forkPath: '/workspace' } });
    send(p.runner, { t: 'report', report: { key: 'C1:9.9', status: 'idle', forkPath: '/workspace' } });
    send(p.runner, { t: 'token', id: 'x' }); // what it sends after is never read
    await new Promise((r) => p.host.once('close', r));
    await new Promise((r) => setImmediate(r));
    expect(p.host.destroyed).toBe(true);
    expect(t.log).toEqual(['registered', 'message report', `stopped ${record.id}`, 'tokens closed', 'closed']);
    p.close();
  });
});

describe('a container found running after a host restart', () => {
  const report = (key: string) => ({ t: 'report', report: { key, status: 'idle', forkPath: '/workspace' } });

  it('is taken back when its first report names its record\'s thread', async () => {
    const p = await pair();
    const t = rig(p.host);
    send(p.runner, report('C1:1.1'));
    expect(await t.takeBack(p.host)).toMatchObject({ id: record.id, key: 'C1:1.1' });
    expect(t.log).toEqual(['registered', 'message report']);
    p.close();
  });

  it('is not taken back when it reports another thread, or says it is a spare: it is told to go', async () => {
    for (const first of [report('C1:9.9'), { t: 'spare', spare: { state: 'parked' } }]) {
      const p = await pair();
      const t = rig(p.host);
      send(p.runner, first);
      await expect(t.takeBack(p.host)).rejects.toThrow(/it reports C1:9.9, not its record's C1:1.1|it says it is a spare/); // at once, not at the adoption timeout
      await new Promise((r) => p.host.once('close', r));
      expect(t.log).toEqual([`stopped ${record.id}`, 'tokens closed']);
      p.close();
    }
  });
});
