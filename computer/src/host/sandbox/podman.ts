// Running Podman, and the few other commands a sandbox needs, as the runners'
// user (work 103): `[...runnerUser.sudo, '--', '/usr/bin/podman', ...args]`.
// The host itself never holds Podman's state; every call is one process that
// ends, bounded by the caller's timeout.
//
// Invariants:
// - Commands are absolute paths and argv arrays: no shell, and the host's PATH
//   never decides what runs as the runners' user.
// - Every command runs in `/`: Podman refuses to start in a directory its
//   user cannot enter, and the host's own may be one.
// - A call that fails or runs out of time rejects with PodmanError, which
//   carries the exit code and stderr; nothing is retried here.

import { execFile as nodeExecFile } from 'node:child_process';

export const PODMAN = '/usr/bin/podman';

export class PodmanError extends Error {
  constructor(
    message: string,
    /** The exit code; undefined when the command was killed or never ran. */
    readonly code: number | undefined,
    readonly stderr: string,
    /** It ran past its timeout and was killed. */
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'PodmanError';
  }
}

export interface RunOptions {
  timeoutMs: number;
  stdin?: string;
}

/** `execFile` as this file uses it; tests pass their own. */
export type Exec = (
  cmd: string,
  args: string[],
  o: { cwd: string; timeout: number; killSignal: 'SIGKILL'; maxBuffer: number; encoding: 'utf8' },
  done: (err: (Error & { code?: number | string | null; killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => { stdin?: { end(data?: string): void } | null };

export interface AsRunner {
  /** `podman <args>` as the runners' user: its stdout. */
  podman(args: string[], o: RunOptions): Promise<string>;
  /** Any other command, by absolute path, as the runners' user. */
  run(argv: string[], o: RunOptions): Promise<string>;
}

const words = (argv: string[]) => argv.slice(0, 3).join(' ');

/** `sudo`: `runnerUser(env).sudo`, the prefix that makes a command the runners' user's. */
export function asRunner(sudo: string[], exec: Exec = nodeExecFile as unknown as Exec): AsRunner {
  const run = (argv: string[], o: RunOptions) =>
    new Promise<string>((resolve, reject) => {
      if (!argv[0]?.startsWith('/')) return reject(new PodmanError(`not an absolute command: ${argv[0]}`, undefined, '', false));
      const [cmd, ...args] = [...sudo, '--', ...argv];
      const child = exec(cmd, args, { cwd: '/', timeout: o.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 2 ** 20, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const timedOut = !!err.killed;
        const code = typeof err.code === 'number' ? err.code : undefined;
        const why = timedOut ? `timed out after ${o.timeoutMs} ms` : (stderr.trim().split('\n').pop() || err.message);
        reject(new PodmanError(`${words(argv)}: ${why}`, code, stderr, timedOut));
      });
      child.stdin?.end(o.stdin);
    });
  return { run, podman: (args, o) => run([PODMAN, ...args], o) };
}
