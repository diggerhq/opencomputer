import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Wire, AppServer, EXITED, RpcError } from './app-server.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'app-server-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A child running `body` (node) with a line reader `on(m)` and `send(m)`. */
function script(body: string) {
  const f = path.join(dir, 'srv.mjs');
  writeFileSync(
    f,
    `#!/usr/bin/env node\nimport readline from 'node:readline';\nconst send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');\nreadline.createInterface({ input: process.stdin }).on('line', (l) => on(JSON.parse(l)));\n${body}\n`,
  );
  chmodSync(f, 0o755);
  return f;
}

/** Whether `pid` is still a process (a zombie counts until its parent, or init after it, reaps it). */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function server(body: string, onRequest: (m: string, p: Wire, id: Wire) => Promise<unknown> = async () => ({})) {
  const notes: [string, Wire][] = [];
  const failed: [string, number][] = [];
  let closed: string | undefined;
  const srv = new AppServer({
    bin: script(body),
    args: [],
    cwd: dir,
    env: process.env,
    onNotification: (m, p) => notes.push([m, p]),
    onRequest,
    onClose: (why) => (closed = why),
    onFailed: (m, c) => failed.push([m, c]),
  });
  return { srv, notes, failed, closed: () => closed };
}

describe('AppServer', () => {
  it('matches responses to requests by id, whatever their order, and hands over notifications in order', async () => {
    const { srv, notes } = server(`
      const held = [];
      function on(m) {
        held.push(m);
        if (held.length === 2) { send({ method: 'n', params: 1 }); send({ id: held[1].id, result: 'second' }); send({ method: 'n', params: 2 }); send({ id: held[0].id, result: 'first' }); }
      }`);
    const [a, b] = await Promise.all([srv.request('a', {}), srv.request('b', {})]);
    expect([a, b]).toEqual(['first', 'second']);
    expect(notes).toEqual([
      ['n', 1],
      ['n', 2],
    ]);
    srv.kill();
  });

  it("answers the server's requests by its own ids, which never resolve ours, and errors from a failing handler", async () => {
    const got: Wire[] = [];
    const { srv } = server(
      `function on(m) {
        if (m.method === 'go') { send({ id: 1, method: 'ask', params: { q: 1 } }); send({ id: 'x', method: 'boom' }); return; }
        if (m.method === undefined) { got(m); }
      }
      const seen = []; function got(m) { seen.push(m); if (seen.length === 2) send({ id: 1, result: seen }); }`,
      async (m) => {
        if (m === 'boom') throw new RpcError(-32601, 'no', m);
        return { ok: true };
      },
    );
    const r = await srv.request('go', {});
    got.push(...(r as Wire[]));
    expect(got).toEqual(
      expect.arrayContaining([
        { id: 1, result: { ok: true } },
        { id: 'x', error: { code: -32601, message: 'no' } },
      ]),
    );
    srv.kill();
  });

  it('hands a server request to its handler before the messages read after it, even in the same chunk', async () => {
    const order: string[] = [];
    const srv = new AppServer({
      bin: script(`function on(m) { process.stdout.write(JSON.stringify({ id: 9, method: 'ask' }) + '\\n' + JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: 9 } }) + '\\n' + JSON.stringify({ id: m.id, result: 1 }) + '\\n'); }`),
      args: [],
      cwd: dir,
      env: process.env,
      onNotification: (m) => order.push(m),
      onRequest: (m) => (order.push(m), new Promise(() => {})),
      onClose: () => {},
    });
    await srv.request('go', {});
    expect(order).toEqual(['ask', 'serverRequest/resolved']);
    srv.kill();
  });

  it('a JSON-RPC error rejects with its code; a child that exits fails what waits, and later calls', async () => {
    const { srv, failed, closed } = server(
      `function on(m) { if (m.method === 'bad') send({ id: m.id, error: { code: -32600, message: 'nope' } }); else process.exit(2); }`,
    );
    await expect(srv.request('bad', {})).rejects.toMatchObject({ code: -32600, message: 'nope' });
    await expect(srv.request('die', {})).rejects.toMatchObject({ code: EXITED });
    await expect(srv.request('after', {})).rejects.toMatchObject({ code: EXITED });
    expect(failed.map(([m]) => m)).toEqual(['bad', 'die', 'after']);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed()).toBe('exit 2');
    expect(srv.alive).toBe(false);
  });

  it('times a request out', async () => {
    const { srv } = server('function on() {}');
    await expect(srv.request('slow', {}, 50)).rejects.toThrow(/did not answer slow/);
    srv.kill();
  });

  it("kill ends what the child spawned too: the signal goes to the child's process group", async () => {
    const { srv, notes, closed } = server(
      `import { spawn } from 'node:child_process'; const g = spawn('sleep', ['30'], { stdio: 'ignore' }); send({ method: 'grandchild', params: { pid: g.pid } }); function on() {}`,
    );
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
      return ok();
    };
    expect(await until(() => notes.length > 0)).toBe(true);
    const pid: number = notes[0][1].pid;
    expect(() => process.kill(pid, 0)).not.toThrow();
    srv.kill();
    expect(await until(() => closed() !== undefined)).toBe(true);
    expect(await until(() => !alive(pid))).toBe(true);
    srv.kill(); // idempotent after the exit
  });

  it('reads lines split across chunks, and kills a child whose line is too long', async () => {
    const { srv, closed } = server(
      `function on(m) { const s = JSON.stringify({ id: m.id, result: 'x'.repeat(200000) }); process.stdout.write(s.slice(0, 7)); setTimeout(() => process.stdout.write(s.slice(7) + '\\n'), 20); }`,
    );
    expect(((await srv.request('big', {})) as string).length).toBe(200000);
    srv.kill();
    const tiny = new AppServer({
      bin: script(`function on(m) { process.stdout.write('y'.repeat(5000)); }`),
      args: [],
      cwd: dir,
      env: process.env,
      maxLine: 1000,
      onNotification() {},
      onRequest: async () => ({}),
      onClose() {},
    });
    await expect(tiny.request('x', {})).rejects.toMatchObject({ code: EXITED });
    await new Promise((r) => setTimeout(r, 20));
    expect(closed()).toBeDefined();
  });
});
