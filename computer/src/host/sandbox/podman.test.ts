import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Exec, PodmanError, asRunner, bounded } from './podman.js';

const sudo = ['/usr/bin/sudo', '-n', '-u', 'agent', 'XDG_RUNTIME_DIR=/run/user/1500'];

type Done = Parameters<Exec>[3];

/** `result`: what the command ends with by itself; none = it runs until `finish` is called. */
function fake(result?: { err?: object; stdout?: string; stderr?: string }) {
  const calls: { cmd: string; args: string[]; opts: object; stdin?: string }[] = [];
  const signals: string[] = [];
  let finish: Done = () => {};
  const exec: Exec = (cmd, args, o, done) => {
    const call: (typeof calls)[number] = { cmd, args, opts: o };
    calls.push(call);
    finish = done;
    if (result) queueMicrotask(() => done((result.err as never) ?? null, result.stdout ?? '', result.stderr ?? ''));
    return { stdin: { end: (d?: string | Buffer) => void (call.stdin = d as string) }, kill: (s) => void signals.push(s) };
  };
  return { exec, calls, signals, finish: (...a: Parameters<Done>) => finish(...a) };
}

afterEach(() => vi.useRealTimers());

describe('asRunner', () => {
  it('runs podman through the sudo prefix under timeout(1), and returns stdout', async () => {
    const f = fake({ stdout: '42\n' });
    expect(await asRunner(sudo, f.exec).podman(['inspect', 'x'], { timeoutMs: 5000 })).toBe('42\n');
    expect(f.calls).toEqual([{
      cmd: '/usr/bin/sudo',
      args: ['-n', '-u', 'agent', 'XDG_RUNTIME_DIR=/run/user/1500', '--', '/usr/bin/timeout', '--kill-after=2', '5.000', '/usr/bin/podman', 'inspect', 'x'],
      opts: { cwd: '/', maxBuffer: 16 * 2 ** 20, encoding: 'utf8' }, // no timeout of execFile's: its SIGKILL would stop at sudo
      stdin: undefined,
    }]);
  });

  it('a variable for the command goes into the sudo prefix, and stdin may be bytes', async () => {
    const f = fake({ stdout: '' });
    await asRunner(sudo, f.exec).podman(['unshare', 'true'], { timeoutMs: 1000, env: { SP_DATA: '/data' }, stdin: Buffer.from('x') });
    expect(f.calls[0].args.slice(3, 7)).toEqual(['XDG_RUNTIME_DIR=/run/user/1500', 'SP_DATA=/data', '--', '/usr/bin/timeout']);
    expect(String(f.calls[0].stdin)).toBe('x');
  });

  it('timeout(1) never gets 0, which would mean no limit', () => {
    expect(bounded(['/bin/true'], 0)[2]).toBe('0.001');
    expect(bounded(['/bin/true'], 0.2)[2]).toBe('0.001');
    expect(bounded(['/bin/true'], 1500)[2]).toBe('1.500');
  });

  it('passes stdin', async () => {
    const f = fake({});
    await asRunner(sudo, f.exec).run(['/bin/cat'], { timeoutMs: 1000, stdin: 'in' });
    expect(f.calls[0].stdin).toBe('in');
  });

  it('a non-zero exit rejects with the code and stderr', async () => {
    const f = fake({ err: Object.assign(new Error('Command failed'), { code: 125 }), stderr: 'warning\nError: no such container\n' });
    const e = await asRunner(sudo, f.exec).podman(['rm', 'x'], { timeoutMs: 1000 }).catch((e) => e);
    expect(e).toBeInstanceOf(PodmanError);
    expect(e).toMatchObject({ code: 125, timedOut: false, stderr: 'warning\nError: no such container\n' });
    expect(e.message).toBe('/usr/bin/podman rm x: Error: no such container');
  });

  it('at the timeout sudo gets SIGTERM, which it relays, and the call rejects as timed out once the command is gone', async () => {
    vi.useFakeTimers();
    const f = fake();
    const p = asRunner(sudo, f.exec).podman(['stop', 'x'], { timeoutMs: 15000 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(f.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signals).toEqual(['SIGTERM']);
    f.finish(Object.assign(new Error('Command failed'), { code: 124 }), '', '');
    const e = await p;
    expect(e).toMatchObject({ timedOut: true, code: undefined });
    expect(e.message).toBe('/usr/bin/podman stop x: timed out after 15000 ms');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.signals).toEqual(['SIGTERM']); // no SIGKILL for a command that went
  });

  it('a command whose output outlives it is given up 3 s after the timeout', async () => {
    vi.useFakeTimers();
    const f = fake();
    const p = asRunner(sudo, f.exec).podman(['stop', 'x'], { timeoutMs: 1000 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await p).toMatchObject({ timedOut: true });
  });

  it('a command killed for anything but its time (too much output, a signal) did not time out', async () => {
    const big = Object.assign(new Error('stdout maxBuffer length exceeded'), { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    const e = await asRunner(sudo, fake({ err: big }).exec).podman(['logs', 'x'], { timeoutMs: 15000 }).catch((e) => e);
    expect(e).toMatchObject({ timedOut: false, code: undefined });
    expect(e.message).toBe('/usr/bin/podman logs x: stdout maxBuffer length exceeded');
  });

  it('refuses a command that is not an absolute path', async () => {
    const f = fake({});
    await expect(asRunner(sudo, f.exec).run(['podman'], { timeoutMs: 1 })).rejects.toThrow(/absolute/);
    expect(f.calls).toHaveLength(0);
  });
});
