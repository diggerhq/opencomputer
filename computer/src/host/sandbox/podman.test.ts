import { describe, expect, it } from 'vitest';
import { type Exec, PodmanError, asRunner } from './podman.js';

const sudo = ['/usr/bin/sudo', '-n', '-u', 'agent', 'XDG_RUNTIME_DIR=/run/user/1500'];

function fake(result: { err?: object; stdout?: string; stderr?: string }) {
  const calls: { cmd: string; args: string[]; timeout: number; stdin?: string }[] = [];
  const exec: Exec = (cmd, args, o, done) => {
    const call: (typeof calls)[number] = { cmd, args, timeout: o.timeout };
    calls.push(call);
    queueMicrotask(() => done((result.err as never) ?? null, result.stdout ?? '', result.stderr ?? ''));
    return { stdin: { end: (d?: string) => void (call.stdin = d) } };
  };
  return { exec, calls };
}

describe('asRunner', () => {
  it('runs podman through the sudo prefix, with the timeout, and returns stdout', async () => {
    const f = fake({ stdout: '42\n' });
    expect(await asRunner(sudo, f.exec).podman(['inspect', 'x'], { timeoutMs: 5000 })).toBe('42\n');
    expect(f.calls).toEqual([{ cmd: '/usr/bin/sudo', args: ['-n', '-u', 'agent', 'XDG_RUNTIME_DIR=/run/user/1500', '--', '/usr/bin/podman', 'inspect', 'x'], timeout: 5000, stdin: undefined }]);
  });

  it('passes stdin', async () => {
    const f = fake({});
    await asRunner(sudo, f.exec).run(['/bin/cat'], { timeoutMs: 1, stdin: 'in' });
    expect(f.calls[0].stdin).toBe('in');
  });

  it('a non-zero exit rejects with the code and stderr', async () => {
    const f = fake({ err: Object.assign(new Error('Command failed'), { code: 125 }), stderr: 'warning\nError: no such container\n' });
    const e = await asRunner(sudo, f.exec).podman(['rm', 'x'], { timeoutMs: 1 }).catch((e) => e);
    expect(e).toBeInstanceOf(PodmanError);
    expect(e).toMatchObject({ code: 125, timedOut: false, stderr: 'warning\nError: no such container\n' });
    expect(e.message).toBe('/usr/bin/podman rm x: Error: no such container');
  });

  it('a timeout rejects as timed out', async () => {
    const f = fake({ err: Object.assign(new Error('killed'), { killed: true, code: null }) });
    const e = await asRunner(sudo, f.exec).podman(['stop', 'x'], { timeoutMs: 15000 }).catch((e) => e);
    expect(e).toMatchObject({ timedOut: true, code: undefined });
    expect(e.message).toMatch(/timed out after 15000 ms/);
  });

  it('refuses a command that is not an absolute path', async () => {
    const f = fake({});
    await expect(asRunner(sudo, f.exec).run(['podman'], { timeoutMs: 1 })).rejects.toThrow(/absolute/);
    expect(f.calls).toHaveLength(0);
  });
});
