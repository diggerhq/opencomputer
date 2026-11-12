import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ContainersDeps, TIMEOUTS, containers } from './containers.js';
import { type AsRunner, PodmanError } from './podman.js';

const ID = '00aa11bb22cc33dd';
const rs = { id: ID, socket: '/s', version: 'v', session: { key: 'C1:1.1', forkPath: '/workspace' } } as never;
const record = { id: ID, person: 'p', key: 'C1:1.1', createdAt: '', usedAt: '' };

/** A fake runners' user: every command is recorded, `answer` says what it prints or throws. */
function rig(answer: (argv: string[]) => string | Error = () => '', over: Partial<ContainersDeps> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'containers-'));
  const calls: { argv: string[]; timeoutMs: number; repeatable?: boolean }[] = [];
  const log: string[] = [];
  const run = async (argv: string[], o: { timeoutMs: number; repeatable?: boolean }) => {
    calls.push({ argv, timeoutMs: o.timeoutMs, ...(o.repeatable && { repeatable: true }) });
    log.push(argv.slice(0, 3).join(' '));
    const a = answer(argv);
    if (a instanceof Error) throw a;
    return a;
  };
  const as: AsRunner = { run, podman: (args, o) => run(['podman', ...args], o) };
  const c = containers({
    as, runRoot: (id) => path.join(root, id), dataDir: '/data', root: '/opt/slack-presence/releases/r1', image: 'img:tag', abi: '1',
    start: async () => void log.push('start'), vars: () => ({ SP_VERSION: 'v1', PATH: '/host/bin' }), definition: () => undefined,
    serveTokens: (_run, id, session) => (log.push(`tokens ${id} ${session()}`), { close: () => void log.push('tokens closed') }),
    sleep: async () => {}, ...over,
  });
  return { c, calls, log, run: path.join(root, ID), find: (word: string) => calls.filter((x) => x.argv.join(' ').includes(word)) };
}
const fail = (stderr: string, timedOut = false) => new PodmanError('failed', timedOut ? undefined : 125, stderr, timedOut);
const mode = (p: string) => statSync(p).mode & 0o7777;

describe('containers', () => {
  it('creates within 60 s, with the run directory there first', async () => {
    const t = rig();
    await t.c.create(ID);
    expect(mode(t.run)).toBe(0o2750);
    const [create] = t.find('podman create');
    expect(create.timeoutMs).toBe(TIMEOUTS.create);
    expect(create.argv).toEqual(expect.arrayContaining(['--name', `sp-runner-${ID}`, '--label', 'sp.abi=1', 'img:tag']));
  });

  it('up: empties what the session wrote, writes the run directory, serves tokens, starts, then asks the pid', async () => {
    const def = path.join(mkdtempSync(path.join(tmpdir(), 'def-')), 'definition.json');
    writeFileSync(def, '{"name":"d"}');
    const t = rig((a) => (a[1] === 'inspect' ? '4242\n' : ''), { definition: () => def });
    const up = await t.c.up(ID, rs, record);
    expect(up.pid).toBe(4242);
    expect(t.log).toEqual(['podman unshare find', 'tokens 00aa11bb22cc33dd C1:1.1', 'start', 'podman inspect --format', '/usr/bin/systemctl --user is-active']);
    expect(t.calls[0].argv).toEqual(['podman', 'unshare', 'find', `${t.run}/runners`, `${t.run}/secrets`, '-mindepth', '1', '-delete']);
    expect([t.run, `${t.run}/runners`, `${t.run}/secrets`, `${t.run}/tokens`].map(mode)).toEqual([0o2750, 0o2770, 0o2770, 0o2750]);
    expect(readFileSync(`${t.run}/definition.json`, 'utf8')).toBe('{"name":"d"}');
    const boot = readFileSync(`${t.run}/boot.env`, 'utf8');
    expect(boot).toContain("SP_ROOT='/opt/slack-presence/releases/r1'\n");
    expect(boot).toContain('"forkPath":"/workspace"');
    expect(boot).toContain("SP_VERSION='v1'");
    expect(boot).not.toContain('PATH='); // a host path: the image's own stands
    expect(mode(`${t.run}/boot.env`)).toBe(0o640);
  });

  it('up: a first start has nothing to empty; any other failure to empty stops it', async () => {
    const none = rig((a) => (a[2] === 'find' ? fail("find: '/x/runners': No such file or directory\nfind: '/x/secrets': No such file or directory\n") : a[1] === 'inspect' ? '7' : ''));
    await expect(none.c.up(ID, rs)).resolves.toMatchObject({ pid: 7 });
    const denied = rig((a) => (a[2] === 'find' ? fail('find: cannot delete: Permission denied\n') : ''));
    await expect(denied.c.up(ID, rs)).rejects.toThrow();
    expect(denied.log).not.toContain('start');
  });

  it('up: the mounts are part of the start, given the pid; a container that could not get them is stopped', async () => {
    const t = rig((a) => (a[1] === 'inspect' ? '4242\n' : ''));
    const up = await t.c.up(ID, rs, record, async (pid) => void t.log.push(`mount ${pid}`));
    expect(t.log.slice(-2)).toEqual(['/usr/bin/systemctl --user is-active', 'mount 4242']);
    expect(up.mountMs).toBeGreaterThanOrEqual(0);
    expect((await t.c.up(ID, rs, record)).mountMs).toBeUndefined();
    const bad = rig((a) => (a[1] === 'inspect' ? '4242\n' : ''));
    await expect(bad.c.up(ID, rs, record, () => Promise.reject(new Error('sandbox-mount: refused')))).rejects.toThrow('sandbox-mount: refused');
    expect(bad.log.slice(-2)).toEqual(['podman stop --time', 'tokens closed']);
  });

  it('the definition in effect is written again for a running container, and removed when there is none', () => {
    const def = path.join(mkdtempSync(path.join(tmpdir(), 'def-')), 'definition.json');
    writeFileSync(def, '{"name":"one"}');
    let file: string | undefined = def;
    const t = rig(() => '', { definition: () => file });
    mkdirSync(t.run, { recursive: true });
    t.c.rewriteDefinition(ID);
    expect(readFileSync(`${t.run}/definition.json`, 'utf8')).toBe('{"name":"one"}');
    writeFileSync(def, '{"name":"two"}');
    t.c.rewriteDefinition(ID);
    expect(readFileSync(`${t.run}/definition.json`, 'utf8')).toBe('{"name":"two"}');
    expect(mode(`${t.run}/definition.json`)).toBe(0o640);
    file = undefined;
    t.c.rewriteDefinition(ID);
    expect(existsSync(`${t.run}/definition.json`)).toBe(false);
  });

  it('up: a spare names no session on its token socket', async () => {
    const t = rig((a) => (a[1] === 'inspect' ? '7' : ''));
    await t.c.up(ID, { id: ID, socket: '/s', version: 'v' });
    expect(t.log).toContain(`tokens ${ID} undefined`);
  });

  it('up: a start that fails stops the container and closes its token socket', async () => {
    const t = rig(() => '', { start: () => Promise.reject(new Error('start timed out')) });
    await expect(t.c.up(ID, rs, record)).rejects.toThrow('start timed out');
    expect(t.log.slice(-2)).toEqual(['podman stop --time', 'tokens closed']);
  });

  it('up: no pid within 5 s fails, and so does a pid whose unit is not active', async () => {
    const nopid = rig((a) => (a[1] === 'inspect' ? '0\n' : ''));
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => (now += 1000);
    try {
      await expect(nopid.c.up(ID, rs, record)).rejects.toThrow('has no process');
    } finally {
      Date.now = realNow;
    }
    expect(nopid.log).toContain('tokens closed');
    // Podman keeps the last run's pid when the unit never came up.
    const inactive = rig((a) => (a[1] === 'inspect' ? '99' : a.includes('is-active') ? fail('', false) : ''));
    await expect(inactive.c.up(ID, rs, record)).rejects.toThrow('not active');
    expect(inactive.find('podman stop')).toHaveLength(1);
  });

  it('stop: 15 s for Podman; a container Podman does not know is down', async () => {
    const t = rig();
    await t.c.stop(ID);
    expect(t.calls).toEqual([{ argv: ['podman', 'stop', '--time', '10', `sp-runner-${ID}`], timeoutMs: TIMEOUTS.stop, repeatable: true }]);
    const gone = rig(() => fail('Error: no container with name or ID "sp-runner-x" found: no such container'));
    await gone.c.stop(ID);
    expect(gone.calls).toHaveLength(1);
  });

  it("stop: past its timeout, kills the payload's cgroup as the runners' user and never signals the unit", async () => {
    const cg = `/user.slice/user-1500.slice/user@1500.service/slack.slice/slack-presence.slice/slack-presence-runners.slice/sp-runner-${ID}.service`;
    let active = 2;
    const t = rig((a) => (a[1] === 'stop' ? fail('', true) : a.includes('show') ? `${cg}\n` : a.includes('is-active') && active-- <= 0 ? fail('') : ''));
    await t.c.stop(ID);
    const sh = t.calls.find((x) => x.argv[0] === '/bin/sh')!;
    expect(sh.argv[2]).toContain('libpod-payload-*');
    expect(sh.argv[2]).toContain('cgroup.kill');
    expect(sh.argv.at(-1)).toBe(`/sys/fs/cgroup${cg}`);
    expect(t.calls.some((x) => x.argv.includes('kill'))).toBe(false);
    expect(t.find('is-active').length).toBeGreaterThan(1); // waited for the unit to go
  });

  it('stop: rejects, in one line, when the unit is still active after its cgroup was killed', async () => {
    const cg = `/user.slice/user-1500.slice/user@1500.service/sp-runner-${ID}.service`;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => (now += 1000);
    try {
      const t = rig((a) => (a[1] === 'stop' ? fail('', true) : a.includes('show') ? `${cg}\n` : ''));
      const e = await t.c.stop(ID).catch((e) => e);
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe(`container sp-runner-${ID} did not stop: its unit is still active after its cgroup was killed`);
    } finally {
      Date.now = realNow;
    }
  });

  it('stop: with no unit there is no cgroup to kill', async () => {
    const t = rig((a) => (a[1] === 'stop' ? fail('', true) : ''));
    await t.c.stop(ID);
    expect(t.calls.some((x) => x.argv[0] === '/bin/sh')).toBe(false);
  });

  it('remove: the container, then its home, 30 s each; never rejects', async () => {
    const t = rig();
    expect(await t.c.remove(ID)).toBe(true);
    expect(t.calls.map((x) => x.argv.slice(1))).toEqual([['rm', '--force', '--volumes', `sp-runner-${ID}`], ['volume', 'rm', '--force', `sp-home-${ID}`]]);
    expect(t.calls.every((x) => x.timeoutMs === TIMEOUTS.remove)).toBe(true);
    const bad = rig(() => fail('', true));
    expect(await bad.c.remove(ID)).toBe(false);
    expect(bad.calls).toHaveLength(2); // the volume is tried all the same
  });

  it('remove: says so, for what else the host keeps by the id (its preview ports)', async () => {
    const gone: string[] = [];
    const t = rig(() => '', { removed: (id) => void gone.push(id) });
    await t.c.remove(ID);
    expect(gone).toEqual([ID]);
  });

  it('only what changes nothing when made twice is repeatable after a wait for the image lock: stop, rm, the lists; never create, an exec, or what empties a run directory', async () => {
    const t = rig((a) => (a[1] === 'inspect' ? '7\n' : a[1] === 'ps' || a[1] === 'volume' ? '[]' : ''));
    await t.c.create(ID);
    await t.c.up(ID, rs, record);
    await t.c.execIn(ID, ['/bin/true'], { dir: '/', timeoutMs: 1000 });
    await t.c.stop(ID);
    await t.c.inventory();
    await t.c.recreate(ID);
    await t.c.remove(ID);
    const verbs = (repeatable: boolean) => [...new Set(t.calls.filter((x) => x.argv[0] === 'podman' && !!x.repeatable === repeatable).map((x) => x.argv[1]))].sort();
    expect(verbs(true)).toEqual(['ps', 'rm', 'stop', 'volume']);
    expect(verbs(false)).toEqual(['create', 'exec', 'inspect', 'unshare']);
  });

  it('recreate: the container alone goes; its home stays for the new one', async () => {
    const t = rig();
    await t.c.recreate(ID);
    expect(t.calls.map((x) => x.argv.slice(1, 3).join(' '))).toEqual(['rm --force', 'create --name']);
    expect(t.calls[0].argv).not.toContain('--volumes');
  });

  it('inventory: what Podman has under our label and names and on our run directories, 10 s each', async () => {
    const t = rig((a) => (a[1] === 'ps' ? ps() : a[1] === 'volume' ? vols : ''));
    const OTHER = 'ffee11bb22cc33dd';
    const ps = () => JSON.stringify([
      { Names: [`sp-runner-${ID}`], State: 'running', Labels: { 'sp.runner': ID, 'sp.abi': '1' }, Image: 'img:tag', Created: 1_700_000_000, Mounts: ['/home/agent', t.run] },
      { Names: ['other'], State: 'running', Labels: { 'sp.runner': ID }, Mounts: [t.run] }, // the label alone does not make it ours
      // Another host of this computer (another SP_RUN) made this one under the same Podman user: seen, never ours.
      { Names: [`sp-runner-${OTHER}`], State: 'running', Labels: { 'sp.runner': OTHER, 'sp.abi': '1' }, Mounts: ['/home/agent', `/run/elsewhere/sandbox/${OTHER}`] },
    ]);
    const vols = JSON.stringify([{ Name: `sp-home-${ID}`, CreatedAt: '2026-11-12T10:00:00Z' }, { Name: 'unrelated' }]);
    expect(await t.c.inventory()).toEqual({
      containers: [{ id: ID, state: 'running', abi: '1', image: 'img:tag', createdAt: 1_700_000_000_000 }],
      volumes: [{ id: ID, createdAt: Date.parse('2026-11-12T10:00:00Z') }],
      foreign: [OTHER],
    });
    expect(t.calls.every((x) => x.timeoutMs === TIMEOUTS.inventory)).toBe(true);
    await expect(rig(() => fail('', true)).c.inventory()).rejects.toThrow();
  });

  const info = { id: ID, state: 'running', abi: '1', image: '', createdAt: 0 };
  const at = { runRoot: (id: string) => `/r/${id}` };
  const ps = (state: string) => JSON.stringify([{ Names: [`sp-runner-${ID}`], State: state, Labels: { 'sp.runner': ID, 'sp.abi': '1' }, Mounts: [`/r/${ID}`] }]);

  it('stale: Podman says running while the unit is not active, and still says so when asked again', async () => {
    const inactive = (state: string) => rig((a) => (a.includes('is-active') ? fail('') : a[1] === 'ps' ? ps(state) : ''), at);
    expect(await inactive('running').c.stale(info)).toBe(true);
    expect(await inactive('stopping').c.stale(info)).toBe(true);
    expect(await rig().c.stale(info)).toBe(false);
    expect(await inactive('running').c.stale({ ...info, state: 'exited' })).toBe(false);
  });

  it('stale: not a container that ended by itself since the inventory, nor one whose unit gave no answer', async () => {
    // Listed as running, then it exited (its idle exit, say): the unit is inactive and Podman says exited by now.
    const ended = rig((a) => (a.includes('is-active') ? fail('') : a[1] === 'ps' ? ps('exited') : ''), at);
    expect(await ended.c.stale(info)).toBe(false);
    const gone = rig((a) => (a.includes('is-active') ? fail('') : a[1] === 'ps' ? '[]' : ''));
    expect(await gone.c.stale(info)).toBe(false);
    await expect(rig((a) => (a.includes('is-active') ? fail('', true) : '')).c.stale(info)).rejects.toMatchObject({ timedOut: true });
  });

  it('execIn: as the session, in a directory, with stdin only when given', async () => {
    const t = rig(() => 'out');
    expect(await t.c.execIn(ID, ['/bin/true'], { dir: '/workspace', timeoutMs: 5 })).toBe('out');
    expect(t.calls[0].argv).toEqual(['podman', 'exec', '--user', '1500:1500', '--workdir', '/workspace', `sp-runner-${ID}`, '/bin/true']);
  });
});
