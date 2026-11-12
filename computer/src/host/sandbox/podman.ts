// Running Podman, and the few other commands a sandbox needs, as the runners'
// user (work 103): `[...runnerUser.sudo, '--', '/usr/bin/podman', ...args]`.
// The host itself never holds Podman's state; every call is one process that
// ends, bounded by the caller's timeout.
//
// A timeout must end the command, not only sudo: SIGKILL to sudo leaves the
// command running (measured: sudo cannot relay it). So every command runs
// under timeout(1) as the runners' user, which ends it by itself; the host's
// own timer sends sudo SIGTERM, which it relays, and decides `timedOut`.
//
// Invariants:
// - Commands are absolute paths and argv arrays: no shell, and the host's PATH
//   never decides what runs as the runners' user.
// - Every command runs in `/`: Podman refuses to start in a directory its
//   user cannot enter, and the host's own may be one.
// - A call that fails or runs out of time rejects with PodmanError, which
//   carries the exit code and stderr; nothing is retried here.
// - `timedOut` is true only when the caller's time ran out: never for output
//   past the limit or a command something else killed.
// - A call that timed out rejects once its command is gone (SIGTERM, SIGKILL
//   2 s later), or 3 s after the timeout at the latest.

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

/** `execFile` as this file uses it; tests pass their own. No `timeout` of its: its signal would stop at sudo. */
export type Exec = (
  cmd: string,
  args: string[],
  o: { cwd: string; maxBuffer: number; encoding: 'utf8' },
  done: (err: (Error & { code?: number | string | null }) | null, stdout: string, stderr: string) => void,
) => { stdin?: { end(data?: string): void } | null; kill?(signal: 'SIGTERM' | 'SIGKILL'): unknown };

export interface AsRunner {
  /** `podman <args>` as the runners' user: its stdout. */
  podman(args: string[], o: RunOptions): Promise<string>;
  /** Any other command, by absolute path, as the runners' user. */
  run(argv: string[], o: RunOptions): Promise<string>;
}

const words = (argv: string[]) => argv.slice(0, 3).join(' ');

export const TIMEOUT = '/usr/bin/timeout';
/** Seconds between a command's SIGTERM and its SIGKILL once its time is up. */
export const KILL_AFTER_S = 2;

/** `argv` under timeout(1): SIGTERM after `timeoutMs`, SIGKILL to its whole process group `KILL_AFTER_S` later; also when timeout(1) itself gets SIGTERM. */
export const bounded = (argv: string[], timeoutMs: number) => [TIMEOUT, `--kill-after=${KILL_AFTER_S}`, Math.max(0.001, timeoutMs / 1000).toFixed(3), ...argv];

/** `argv` as the runners' user, bounded as above: its stdout. `asRunner` for a command that is not Podman's and may be found on sudo's PATH (launch.ts). */
export function runBounded(sudo: string[], argv: string[], o: RunOptions, exec: Exec = nodeExecFile as unknown as Exec): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const [cmd, ...args] = [...sudo, '--', ...bounded(argv, o.timeoutMs)];
    // Only this timer says "timed out": a command killed for its output, or by anyone else, did not.
    let timedOut = false;
    const late = () => new PodmanError(`${words(argv)}: timed out after ${o.timeoutMs} ms`, undefined, '', true);
    const child = exec(cmd, args, { cwd: '/', maxBuffer: 16 * 2 ** 20, encoding: 'utf8' }, (err, stdout, stderr) => {
      clearTimeout(term);
      clearTimeout(kill);
      if (timedOut) return reject(late());
      if (!err) return resolve(stdout);
      const code = typeof err.code === 'number' ? err.code : undefined;
      reject(new PodmanError(`${words(argv)}: ${stderr.trim().split('\n').pop() || err.message}`, code, stderr, false));
    });
    // sudo relays SIGTERM and timeout(1) turns it into SIGTERM, then SIGKILL, for the command's process group.
    const term = setTimeout(() => {
      timedOut = true;
      child.kill?.('SIGTERM');
    }, o.timeoutMs);
    // Past that, something still holds the output: the caller waits no longer. sudo cannot relay this one.
    const kill = setTimeout(() => {
      child.kill?.('SIGKILL');
      reject(late());
    }, o.timeoutMs + (KILL_AFTER_S + 1) * 1000);
    child.stdin?.end(o.stdin);
  });
}

/** `sudo`: `runnerUser(env).sudo`, the prefix that makes a command the runners' user's. */
export function asRunner(sudo: string[], exec?: Exec): AsRunner {
  const run = (argv: string[], o: RunOptions) =>
    argv[0]?.startsWith('/') ? runBounded(sudo, argv, o, exec) : Promise.reject(new PodmanError(`not an absolute command: ${argv[0]}`, undefined, '', false));
  return { run, podman: (args, o) => run([PODMAN, ...args], o) };
}
