// ONE-TIME systemd->podman migration (work 103). Delete together with the systemd launch path in step 11.
//
// deploy/vm/sp-host.sh's `launch` verb (the per-computer switch of the podman rollout), sourced against a
// fake /proc and stub systemctl, runuser and podman: the marker, `apply`'s drop-in line, when it refuses,
// and that it restarts the way provision.sh does, under provision.sh's lock.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, '../../../deploy/vm/sp-host.sh');

let dir: string;
const at = (...p: string[]) => path.join(dir, ...p);
const read = (f: string) => (existsSync(at('state', f)) ? readFileSync(at('state', f), 'utf8') : '');

/** A process in the fake /proc. */
function ps(pid: number, ppid: number, argv: string[], env: Record<string, string> = {}, drain = false) {
  const d = at('proc', String(pid));
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'cmdline'), `${argv.join('\0')}\0`);
  writeFileSync(path.join(d, 'stat'), `${pid} (${path.basename(argv[0])}) S ${ppid} ${pid} ${pid} 0 -1`);
  writeFileSync(path.join(d, 'environ'), `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0')}\0`);
  if (drain) {
    mkdirSync(path.join(d, 'cwd/src/host/legacy-migration'), { recursive: true });
    writeFileSync(path.join(d, 'cwd/src/host/legacy-migration/drain.ts'), '');
  }
}

/** The host as the unit runs it, MainPID `main`, with a token in its environment that must never be printed. */
function host(main: number, launch?: string, drain = true) {
  const env: Record<string, string> = { SP_HOST_TOKEN: 'sekrit-token', ...(launch ? { SP_LAUNCH: launch } : {}) };
  ps(main, 1, ['node', 'node_modules/.bin/tsx', 'src/host/main.ts'], env, drain);
  ps(main + 1, main, ['/usr/bin/node', '--import', 'tsx/loader', 'src/host/main.ts'], env);
  writeFileSync(at('state', 'mainpid'), `${main}\n`);
}

function stub(name: string, body: string) {
  const f = at('bin', name);
  writeFileSync(f, `#!/usr/bin/env bash\nS=${JSON.stringify(at('state'))}\n${body}\n`);
  chmodSync(f, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sp-host-launch-'));
  for (const d of ['proc', 'state', 'bin', 'etc', 'data/state/sandboxes']) mkdirSync(at(d), { recursive: true });
  writeFileSync(at('etc', 'host-user-sp-host'), '');
  stub('id', 'echo 0');
  stub('systemctl', `
case "$1 $2 $3" in
  "show -p MainPID") cat "$S/mainpid" ;;
  "show -p Environment") cat "$S/environment" 2>/dev/null; echo ;;
  "show -p EnvironmentFiles") echo ;;
  "show -p DropInPaths") cat "$S/dropins" 2>/dev/null; echo ;;
  "show -p InvocationID") echo inv-1 ;;
  restart*) echo restarted >> "$S/restarted"; cat "$S/after-restart" > "$S/mainpid" ;;
esac`);
  stub('runuser', 'while [[ $1 != -- ]]; do shift; done; shift; exec "$@"');
  stub('journalctl', '[[ $* == *_SYSTEMD_INVOCATION_ID=inv-1* ]] && cat "$S/journal" 2>/dev/null; exit 0');
  stub('podman', '[[ $1 == ps ]] && cat "$S/containers" 2>/dev/null; exit 0');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * `sp-host.sh launch <args>`, sourced, with `apply` and the drain as functions: `apply` writes the marker into the
 * unit's environment (`extraEnv` after it, as a later drop-in would), and records whether provision.sh's lock was held.
 */
function launch(args: string, opts: { applyFails?: boolean; extraEnv?: string; drain?: string; dropin?: boolean } = {}) {
  const S = JSON.stringify(at('state'));
  const lock = JSON.stringify(at('state', 'provision.lock'));
  const driver = `
source ${JSON.stringify(SCRIPT)}
sleep() { :; }
launch_apply() {
  ${opts.applyFails ? 'return 1' : ''}
  if flock -n ${lock} true; then echo unlocked >> ${S}/apply; else echo locked >> ${S}/apply; fi
  echo "HOME=/x $(launch_env | sed 's/^Environment=//') ${opts.extraEnv ?? ''}" > ${S}/environment
}
${opts.drain === undefined ? '' : `legacy_drain_restart() { echo drain >> ${S}/drained; ${opts.drain}; }`}
DROPIN=${JSON.stringify(at('etc', '20-sp-host.conf'))}
${opts.dropin ? 'echo "[Service]" > "$DROPIN"' : ''}
new_apply() { ${opts.applyFails ? 'return 1' : `echo applied >> ${S}/apply`}; }
run_dirs_as_is() { if [[ -f $MARK ]]; then echo sp-host >> ${S}/run-dirs; else echo agent >> ${S}/run-dirs; fi; }
case $1 in status) launch_status ;; env) launch_env ;; note) launch_note ;; new) new_computer ;; *) launch "$1" ;; esac`;
  const r = spawnSync('bash', ['-c', driver, 'sp-host.sh', args], {
    env: {
      ...process.env, PATH: `${at('bin')}:${process.env.PATH}`, LEGACY_PROC: at('proc'), SP_ETC: at('etc'), SP_DATA: at('data'),
      SP_PROVISION_LOCK: at('state', 'provision.lock'), AGENT_USER: 'agent', AGENT_UID: '1500',
    },
    encoding: 'utf8',
  });
  const marker = existsSync(at('etc', 'sp-launch')) ? readFileSync(at('etc', 'sp-launch'), 'utf8').trim() : undefined;
  return { code: r.status, out: r.stdout, err: r.stderr, marker, apply: read('apply').trim(), drained: !!read('drained'), restarted: !!read('restarted') };
}

/** The drain as legacy-drain.sh ends it: the host is back under MainPID 300 as podman. */
const flipped = () => `${JSON.stringify(at('bin', 'flip'))}`;
function flipScript() {
  host(300, 'podman');
  writeFileSync(at('state', 'mainpid'), '100\n');
  stub('flip', 'echo 300 > "$S/mainpid"');
}

describe('sp-host.sh apply: the SP_LAUNCH line', () => {
  it('is none without a marker, and the marker otherwise', () => {
    expect(launch('env').out).toBe('');
    writeFileSync(at('etc', 'sp-launch'), 'podman\n');
    expect(launch('env').out).toBe('Environment=SP_LAUNCH=podman\n');
    writeFileSync(at('etc', 'sp-launch'), 'systemd');
    expect(launch('env').out).toBe('Environment=SP_LAUNCH=systemd\n');
  });

  it('ignores a marker that is neither, with a warning', () => {
    writeFileSync(at('etc', 'sp-launch'), 'docker\n');
    const r = launch('env');
    expect(r.out).toBe('');
    expect(r.err).toContain("'docker' is not podman or systemd");
  });
});

describe('sp-host.sh new: a new computer (provision.sh, before its host has ever run)', () => {
  beforeEach(() => rmSync(at('etc', 'host-user-sp-host')));

  it('is migrated to sp-host and podman', () => {
    const r = launch('new');
    expect(r.code).toBe(0);
    expect(existsSync(at('etc', 'host-user-sp-host'))).toBe(true);
    expect(r.marker).toBe('podman');
    expect(r.apply).toBe('applied');
    expect(launch('env').out).toBe('Environment=SP_LAUNCH=podman\n');
  });

  it('keeps a marker that is already there', () => {
    writeFileSync(at('etc', 'sp-launch'), 'systemd\n');
    expect(launch('new').marker).toBe('systemd');
  });

  it('starts unmigrated and systemd when apply fails: podman needs the host as sp-host', () => {
    const r = launch('new', { applyFails: true, dropin: true });
    expect(r.code).toBe(0);
    expect(r.err).toContain('it runs as agent, under systemd');
    expect(existsSync(at('etc', 'host-user-sp-host'))).toBe(false);
    expect(existsSync(at('etc', '20-sp-host.conf'))).toBe(false);
    expect(r.marker).toBeUndefined();
    expect(read('run-dirs').trim()).toBe('agent');
  });
});

describe('sp-host.sh apply: a host with no marker (an existing computer)', () => {
  it('stays systemd, with a note: its runners need the drain of `launch podman`', () => {
    host(100);
    expect(launch('env').out).toBe('');
    expect(launch('note').err).toContain('this host stays systemd; `sp-host.sh launch podman` switches it, drained');
    writeFileSync(at('etc', 'sp-launch'), 'podman\n');
    expect(launch('note').err).toBe('');
  });
});

describe('sp-host.sh launch podman', () => {
  it('writes the marker, applies it under the provision lock, drains, and checks the host came back as podman', () => {
    host(100);
    flipScript();
    const r = launch('podman', { drain: flipped() });
    expect(r.code).toBe(0);
    expect(r.marker).toBe('podman');
    expect(r.apply).toBe('locked');
    expect(r.drained).toBe(true);
    expect(r.restarted).toBe(false);
    expect(r.out).toContain('the host agent runs as podman (pid 301)');
    expect(r.out).toContain('launch running: podman');
  });

  it("says how the drain ended, from the old host's journal", () => {
    host(100);
    flipScript();
    writeFileSync(at('state', 'journal'), 'legacy drain: telling every runner\nlegacy drain: exiting after 42 s (no runner left)\n');
    expect(launch('podman', { drain: flipped() }).out).toContain('launch: drain clean in 42 s\n');
  });

  it('says when the drain hit its deadline and how many turns it cut', () => {
    host(100);
    flipScript();
    writeFileSync(at('state', 'journal'), 'legacy drain: deadline, 2 runner(s) told to exit now: a b\nlegacy drain: exiting after 601 s (no runner left)\n');
    const r = launch('podman', { drain: flipped() });
    expect(r.code).toBe(0);
    expect(r.out).toContain('launch: drain hit the 10-min deadline, 2 runner(s) cut mid-turn');
  });

  it('skips a host not migrated to sp-host, and changes nothing', () => {
    host(100);
    rmSync(at('etc', 'host-user-sp-host'));
    const r = launch('podman', { drain: 'exit 9' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('== sp-host: launch: skipped: host not migrated to sp-host');
    expect(r.marker).toBeUndefined();
    expect(r.apply).toBe('');
    expect(r.drained).toBe(false);
  });

  it('skips when the running systemd host has no drain: a plain restart would orphan its runners', () => {
    host(100, undefined, false);
    const r = launch('podman', { drain: 'exit 9' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('== sp-host: launch: skipped: running release has no drain');
    expect(r.marker).toBeUndefined();
    expect(r.drained).toBe(false);
  });

  it('puts the marker back and does not restart when apply fails', () => {
    host(100);
    writeFileSync(at('etc', 'sp-launch'), 'systemd\n');
    const r = launch('podman', { applyFails: true, drain: 'exit 9' });
    expect(r.code).toBe(1);
    expect(r.marker).toBe('systemd');
    expect(r.drained).toBe(false);
  });

  it('names the drop-in that overrides SP_LAUNCH, puts the marker back, re-applies it, and does not restart', () => {
    host(100);
    writeFileSync(at('etc', 'sp-launch'), 'systemd\n');
    writeFileSync(at('etc', '30-other.conf'), '[Service]\nEnvironment=SP_LAUNCH=systemd\n');
    writeFileSync(at('state', 'dropins'), `/etc/systemd/system/slack-presence-host.service.d/20-sp-host.conf ${at('etc', '30-other.conf')}`);
    const r = launch('podman', { extraEnv: 'SP_LAUNCH=systemd', drain: 'exit 9' });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`the unit's SP_LAUNCH is 'systemd', not podman, set by ${at('etc', '30-other.conf')}`);
    expect(r.err).toContain("the marker is back to 'systemd'");
    expect(r.marker).toBe('systemd');
    expect(r.apply).toBe('locked\nlocked');
    expect(read('environment')).toContain('HOME=/x SP_LAUNCH=systemd ');
    expect(r.drained).toBe(false);
    expect(r.restarted).toBe(false);
  });

  it('only records the marker on a host already podman (the hand-written drop-in of a canary)', () => {
    host(100, 'podman');
    const r = launch('podman', { drain: 'exit 9' });
    expect(r.code).toBe(0);
    expect(r.marker).toBe('podman');
    expect(r.out).toContain('already podman');
    expect(r.drained).toBe(false);
    expect(r.restarted).toBe(false);
  });
});

describe('sp-host.sh launch systemd', () => {
  it('is a plain restart (no drain back), warns about the containers left, and checks the host came back as systemd', () => {
    host(100, 'podman');
    host(300);
    writeFileSync(at('state', 'mainpid'), '100\n');
    writeFileSync(at('state', 'after-restart'), '300\n');
    const r = launch('systemd');
    expect(r.code).toBe(0);
    expect(r.marker).toBe('systemd');
    expect(r.restarted).toBe(true);
    expect(r.err).toContain('podman stop -a');
    expect(r.out).toContain('the host agent runs as systemd (pid 301)');
  });

  it('fails when the host came back as something else', () => {
    host(100, 'podman');
    host(300, 'podman');
    writeFileSync(at('state', 'mainpid'), '100\n');
    writeFileSync(at('state', 'after-restart'), '300\n');
    const r = launch('systemd');
    expect(r.code).toBe(1);
    expect(r.err).toContain('came back with SP_LAUNCH=podman, not systemd');
  });
});

describe('sp-host.sh launch status', () => {
  it("prints the running host's SP_LAUNCH and nothing else of its environment, containers by kind, and unmigrated threads", () => {
    host(100, 'podman');
    writeFileSync(at('state', 'environment'), 'HOME=/x SP_LAUNCH=podman');
    writeFileSync(at('etc', 'sp-launch'), 'podman\n');
    writeFileSync(at('state', 'containers'), 'aaa\nbbb\nccc\n');
    const rec = (id: string, person: string, key: string, more = {}) =>
      writeFileSync(at('data/state/sandboxes', `${id}.json`), JSON.stringify({ id, person, key, ...more }));
    rec('aaa', 'U1', 'C1:1700000000.0001');
    rec('bbb', 'U1', 'C1:1700000000.0002', { unclaimed: true });
    rec('zzz', 'U2', 'web:abc'); // a thread with no container now
    for (const f of ['U1/sessions/C1-1700000000-0001', 'U1/sessions/C1-1700000000-0003', 'U2/sessions/web-abc', 'U2/sessions/old']) {
      mkdirSync(at('data/people', f), { recursive: true });
    }
    const r = launch('status');
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        'launch running: podman',
        'launch configured: podman',
        'launch marker: podman',
        'host user migrated: yes',
        'containers: 3 (1 threads, 2 spares)',
        'unmigrated threads: 2 of 4',
        '',
      ].join('\n'),
    );
    expect(r.out + r.err).not.toContain('sekrit');
  });

  it('says so when the host is not running or the defaults apply', () => {
    writeFileSync(at('state', 'mainpid'), '0\n');
    const r = launch('status');
    expect(r.out).toContain('launch running: none');
    expect(r.out).toContain('launch configured: systemd (unset)');
    expect(r.out).toContain('launch marker: none');
    expect(r.out).toContain('unmigrated threads: 0 of 0');
  });
});
