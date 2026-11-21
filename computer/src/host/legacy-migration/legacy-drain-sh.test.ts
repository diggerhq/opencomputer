// ONE-TIME systemd->podman migration (work 103). Delete together with the systemd launch path in step 11.
//
// deploy/vm/legacy-drain.sh (provision.sh's drain-then-flip), against a fake
// /proc and stub systemctl, journalctl and runuser: which process gets
// SIGUSR2, and when a drain counts as done.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, '../../../deploy/vm/legacy-drain.sh');

let dir: string;
const proc = () => path.join(dir, 'proc');
const state = (f: string) => path.join(dir, 'state', f);
const read = (f: string) => {
  try {
    return readFileSync(state(f), 'utf8');
  } catch {
    return '';
  }
};

/** A process in the fake /proc. */
function ps(pid: number, ppid: number, argv: string[], env: Record<string, string> = {}, cwd?: string) {
  const d = path.join(proc(), String(pid));
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'cmdline'), `${argv.join('\0')}\0`);
  writeFileSync(path.join(d, 'stat'), `${pid} (${path.basename(argv[0])} x) S ${ppid} ${pid} ${pid} 0 -1`);
  writeFileSync(path.join(d, 'environ'), `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0')}\0`);
  if (cwd) {
    mkdirSync(path.join(d, 'cwd', 'src/host/legacy-migration'), { recursive: true });
    writeFileSync(path.join(d, 'cwd', 'src/host/legacy-migration/drain.ts'), '');
  }
}

/** The unit's ExecStart: tsx's CLI, which starts main.ts as its child. */
function tsxHost(main: number, env: Record<string, string>, opts: { drain?: boolean } = {}) {
  ps(main, 1, ['node', '/opt/slack-presence/current/node_modules/.bin/tsx', 'src/host/main.ts'], env, opts.drain === false ? undefined : 'cwd');
  ps(main + 1, main, ['/usr/bin/node', '--require', '/opt/x/node_modules/tsx/dist/preflight.cjs', '--import', 'file:///opt/x/node_modules/tsx/dist/loader.mjs', 'src/host/main.ts'], env);
  ps(main + 2, main + 1, ['git', 'fetch', '--quiet']); // a housekeeping child of the host
}

function stub(name: string, body: string) {
  const f = path.join(dir, 'bin', name);
  writeFileSync(f, `#!/usr/bin/env bash\nS=${JSON.stringify(path.join(dir, 'state'))}\n${body}\n`);
  chmodSync(f, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'legacy-drain-'));
  for (const d of ['proc', 'state', 'bin']) mkdirSync(path.join(dir, d));
  stub('systemctl', `
if [[ $1 == --user ]]; then
  shift
  case $1 in
    list-units) cat "$S/units" 2>/dev/null | sed 's/$/ loaded active running x/' ;;
    stop) shift; [[ $1 == -- ]] && shift; echo "$*" >> "$S/stopped" ;;
  esac
  exit 0
fi
case "$1 $2 $3" in
  "show -p MainPID") cat "$S/mainpid" ;;
  "show -p Environment") cat "$S/environment" 2>/dev/null; echo ;;
  "show -p EnvironmentFiles") echo ;;
  "show -p InvocationID") echo inv-old ;;
  restart*) echo restarted >> "$S/restarted"; cat "$S/after-restart" > "$S/mainpid" ;;
esac`);
  stub('journalctl', '[[ " $* " == *" _SYSTEMD_INVOCATION_ID=inv-old "* ]] && cat "$S/journal" 2>/dev/null; exit 0');
  stub('runuser', 'while [[ $1 != -- ]]; do shift; done; shift; exec "$@"');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** provision.sh's call, under its shell options; `onKill` runs as the signal "arrives". */
function provision(onKill = '') {
  writeFileSync(state('on-kill'), onKill);
  const driver = `
set -euo pipefail
source ${JSON.stringify(SCRIPT)}
sleep() { :; }
kill() { echo "$*" >> ${JSON.stringify(state('killed'))}; bash ${JSON.stringify(state('on-kill'))}; }
legacy_drain_restart || echo PLAIN-RESTART`;
  const r = spawnSync('bash', ['-c', driver], {
    env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, LEGACY_PROC: proc(), LEGACY_WAIT_S: '3', LEGACY_STEP_S: '1', AGENT_USER: 'agent', AGENT_UID: '1500' },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr, killed: read('killed').trim(), stopped: read('stopped').trim(), restarted: !!read('restarted') };
}

/** The flip as the drain does it: the old host leaves, logging so, and the unit comes back as `podman` under MainPID 300. */
const flip = (opts: { launch?: string; log?: string } = {}) => {
  tsxHost(300, { SP_LAUNCH: opts.launch ?? 'podman' });
  return [
    `echo 300 > ${JSON.stringify(state('mainpid'))}`,
    `printf '%s\\n' ${JSON.stringify(opts.log ?? 'legacy drain: exiting after 42 s (no runner left)')} > ${JSON.stringify(state('journal'))}`,
    `printf 'sp-runner-stuck\\nsp-runner-newpod\\n' > ${JSON.stringify(state('units'))}`,
  ].join('\n');
};

function systemdHost() {
  tsxHost(100, {});
  writeFileSync(state('mainpid'), '100\n');
  writeFileSync(state('environment'), 'HOME=/home/agent SP_LAUNCH=podman');
  writeFileSync(state('units'), 'sp-runner-done\nsp-runner-stuck\n');
}

describe('legacy-drain.sh host-pid', () => {
  const hostPid = (pid: number) => spawnSync('bash', [SCRIPT, 'host-pid', String(pid)], { env: { ...process.env, LEGACY_PROC: proc() }, encoding: 'utf8' });

  it("finds main.ts in tsx's child, not the wrapper systemd sees as MainPID", () => {
    tsxHost(100, {});
    expect(hostPid(100).stdout.trim()).toBe('101');
  });

  it('is MainPID itself under `node --import tsx`', () => {
    ps(200, 1, ['node', '--import', 'tsx', 'src/host/main.ts']);
    ps(201, 200, ['git', 'fetch']);
    expect(hostPid(200).stdout.trim()).toBe('200');
  });

  it('fails for a process that runs no host', () => {
    ps(400, 1, ['sleep', '100']);
    expect(hostPid(400).status).toBe(1);
    expect(hostPid(999).status).toBe(1);
  });

  it('reads a command name with spaces and parentheses', () => {
    tsxHost(100, {});
    writeFileSync(path.join(proc(), '101', 'stat'), '101 (node (x) y) S 100 101 101 0 -1');
    expect(execFileSync('bash', [SCRIPT, 'host-pid', '100'], { env: { ...process.env, LEGACY_PROC: proc() }, encoding: 'utf8' }).trim()).toBe('101');
  });
});

describe('legacy_drain_restart', () => {
  it('is a plain restart when SP_LAUNCH stays systemd, with nothing signalled', () => {
    systemdHost();
    writeFileSync(state('environment'), 'HOME=/home/agent');
    const r = provision();
    expect(r.out).toContain('PLAIN-RESTART');
    expect(r.killed).toBe('');
  });

  it('is a plain restart when the running host is already podman', () => {
    systemdHost();
    tsxHost(100, { SP_LAUNCH: 'podman' });
    expect(provision().out).toContain('PLAIN-RESTART');
  });

  it('is a plain restart, with a warning, when the running release has no drain', () => {
    systemdHost();
    rmSync(path.join(proc(), '100', 'cwd'), { recursive: true });
    const r = provision();
    expect(r.out).toContain('PLAIN-RESTART');
    expect(r.err).toContain('has no drain');
    expect(r.killed).toBe('');
  });

  it('signals the node child, checks the flip, and stops only the old runners still running', () => {
    systemdHost();
    const r = provision(flip());
    expect(r.code).toBe(0);
    expect(r.killed).toBe('-USR2 101');
    expect(r.out).not.toContain('PLAIN-RESTART');
    expect(r.stopped).toBe('sp-runner-stuck'); // not sp-runner-newpod: the podman host's
    expect(r.out).toContain('host drained and back as podman (pid 301, MainPID 300)');
  });

  it('warns when the drain ended at its deadline', () => {
    systemdHost();
    const r = provision(flip({ log: 'legacy drain: exiting after 610 s (1 runner(s) still connected)' }));
    expect(r.code).toBe(0);
    expect(r.err).toContain('the deadline was reached');
  });

  it('fails when the old host never logged its drain (stopped, not drained)', () => {
    systemdHost();
    const r = provision(flip({ log: 'host stopping' }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("never logged 'legacy drain: exiting'");
    expect(r.out).not.toContain('PLAIN-RESTART');
  });

  it('fails when the host came back without SP_LAUNCH=podman, and stops no runner', () => {
    systemdHost();
    const r = provision(flip({ launch: 'systemd' }));
    expect(r.code).toBe(1);
    expect(r.err).toContain('SP_LAUNCH=systemd, not podman');
    expect(r.stopped).toBe('');
  });

  it('restarts the host and fails when it did not leave in time', () => {
    systemdHost();
    tsxHost(300, { SP_LAUNCH: 'podman' });
    writeFileSync(state('after-restart'), '300\n');
    const r = provision(''); // the signal changes nothing
    expect(r.restarted).toBe(true);
    expect(r.err).toContain('did not leave in 3 s');
    expect(r.code).toBe(1);
  });
});
