// Workspace writes as the runners' user (work 077). On a computer whose host
// runs as sp-host (deploy/vm/sp-host.sh), <SP_DATA>/people stays the agent's:
// the host runs its git and file operations there through `sudo -u agent`, so
// sessions can change and delete everything the host made, and the host never
// has to write what sessions made. Without a runner user (runners, laptops,
// hosts before the migration) these are the plain node:fs calls.
//
// The process that starts (host/main.ts, a dev check) calls configureAsRunner
// once with its environment; nothing here reads process.env.

import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import type { RunnerUser } from '../host/runner-user.js';

let user: RunnerUser | undefined;
/** The caller's environment: what `command` passes on, and the source of KEEP. */
let hostEnv: NodeJS.ProcessEnv = {};
// What the host's git and setup commands rely on from its environment; sudo resets the rest.
const KEEP = ['PATH', 'LANG', 'SP_RUN', 'SP_DATA', 'SP_DEFINITION'];

/** `runners`: runnerUser(env) (undefined: everything as the host's user); `env`: the process's environment. */
export function configureAsRunner(runners: RunnerUser | undefined, env: NodeJS.ProcessEnv) {
  user = runners;
  hostEnv = env;
}
const as = () => user;

/** The runners' user's home: theirs when they run as another user, else the caller's. */
export const runnerHome = () => user?.env.HOME ?? hostEnv.HOME ?? os.homedir();

/** `cmd args` as the runners' user, with `env` added; as is when runners run as the host's user. */
export function command(cmd: string, args: string[], env: Record<string, string> = {}): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const u = as();
  if (!u) return { cmd, args, env: { ...hostEnv, ...env } };
  const kept = Object.fromEntries(KEEP.filter((k) => hostEnv[k] !== undefined).map((k) => [k, hostEnv[k]!]));
  const vars = Object.entries({ ...kept, ...u.env, ...env }).map(([k, v]) => `${k}=${v}`);
  const [sudo, ...pre] = u.sudo;
  return { cmd: sudo, args: [...pre, '--', 'env', ...vars, cmd, ...args], env: hostEnv };
}

function run(cmd: string, args: string[], input?: string) {
  const c = command(cmd, args);
  return new Promise<void>((resolve, reject) => {
    const p = spawn(c.cmd, c.args, { env: c.env, stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr!.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd}: ${err.trim() || `exit ${code}`}`))));
    if (input !== undefined) p.stdin!.end(input);
  });
}

export const mkdir = async (dir: string, o?: { recursive?: boolean }) => void (as() ? await run('mkdir', ['-p', '--', dir]) : await fsp.mkdir(dir, o));
/** Always recursive and forced, as every caller wants. */
export const rm = (p: string) => (as() ? run('rm', ['-rf', '--', p]) : fsp.rm(p, { recursive: true, force: true }));
export const rename = (from: string, to: string) => (as() ? run('mv', ['-T', '--', from, to]) : fsp.rename(from, to));
export const writeFile = (file: string, data: string) => (as() ? run('sh', ['-c', 'cat > "$1"', 'sh', file], data) : fsp.writeFile(file, data));
export const appendFile = (file: string, data: string) => (as() ? run('sh', ['-c', 'cat >> "$1"', 'sh', file], data) : fsp.appendFile(file, data));
export const copyFile = (from: string, to: string) => (as() ? run('cp', ['--', from, to]) : fsp.copyFile(from, to));
/** Sets the modification time to now. */
export const touch = (file: string) => (as() ? run('touch', ['-c', '--', file]) : fsp.utimes(file, new Date(), new Date()));
