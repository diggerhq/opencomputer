// Running the workspace scripts, bin/ws-*.sh (work 103, seam S2). The scripts
// hold the git sequences; clones.ts, fork.ts, housekeep.ts, prune.ts and
// idle.ts keep the locks, the scheduling, the telemetry and the parsing, and
// reach git only through a ScriptRunner. `hostScripts` runs a script on the
// host as the runners' user (as-runner.ts), with host paths.
//
// Invariants:
// - A script prints one line per repository, tab-separated: the repository,
//   `ok` or `failed`, then its fields; a failed line's third field is a
//   one-line message (bin/ws-lib.sh). `row` turns a failed line into an Error
//   with that message.
// - `run` rejects only when the script itself failed: a non-zero exit, or the
//   timeout, after which the script is stopped and `killed` is set (errText in
//   clones.ts then says "timed out").

import { spawn } from 'node:child_process';
import path from 'node:path';
import { command } from './as-runner.js';

const BIN = path.resolve(import.meta.dirname, '..', '..', 'bin');

export class ScriptError extends Error {
  constructor(
    script: string,
    readonly code: number | null,
    readonly stderr: string,
    /** Stopped at its timeout. */
    readonly killed = false,
  ) {
    super(`${script}: ${killed ? 'timed out' : stderr.trim() || `exit ${code}`}`);
  }
}

export interface ScriptRunner {
  /** Run bin/<script> with these arguments; resolves with stdout, rejects with ScriptError { code, stderr } on a non-zero exit or the timeout (0: none). */
  run(script: string, args: string[], o: { stdin?: string; timeoutMs: number }): Promise<string>;
  /** How this runner names the clones directory and a workspace: host paths, or /clones and /workspace. */
  clones: string;
  workspace(hostForkPath: string): string;
}

/** The scripts on the host, for one clones directory (a person's `ws`). */
export function hostScripts(clones: string): ScriptRunner {
  return {
    clones,
    workspace: (hostForkPath) => hostForkPath,
    run(script, args, o) {
      const c = command('sh', [path.join(BIN, script), ...args], { GIT_TERMINAL_PROMPT: '0' });
      return new Promise<string>((resolve, reject) => {
        const p = spawn(c.cmd, c.args, { env: c.env, stdio: [o.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        let killed = false;
        const timer = o.timeoutMs > 0 ? setTimeout(() => ((killed = true), p.kill('SIGTERM')), o.timeoutMs) : undefined;
        p.stdout!.setEncoding('utf8').on('data', (d) => (out += d));
        p.stderr!.setEncoding('utf8').on('data', (d) => (err += d));
        p.on('error', (e) => (clearTimeout(timer), reject(e)));
        p.on('close', (code) => {
          clearTimeout(timer);
          killed || code !== 0 ? reject(new ScriptError(script, code, err, killed)) : resolve(out);
        });
        if (o.stdin !== undefined) {
          p.stdin!.on('error', () => {}); // a script that ended early: its exit says so
          p.stdin!.end(o.stdin);
        }
      });
    },
  };
}

/** A script's lines by repository: the fields after the repository, the first `ok` or `failed`. */
export function rows(stdout: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [repo, ...fields] = line.split('\t');
    found.set(repo, fields);
  }
  return found;
}

/** The fields of an `ok` line for this repository; throws the message of a `failed` one. */
export function row(stdout: string, repo: string): string[] {
  const [status, ...fields] = rows(stdout).get(repo) ?? [];
  if (status === 'ok') return fields;
  throw new Error(status === 'failed' ? fields[0] || 'failed' : `no result for ${repo}`);
}
