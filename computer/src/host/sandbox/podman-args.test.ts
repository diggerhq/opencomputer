import { describe, expect, it } from 'vitest';
import {
  createArgs, emptyRunArgs, execArgs, filesHelperArgs, terminalArgs, terminalHangUpArgs, inventoryArgs, logsArgs, pidArgs, recreateRemoveArgs, removeArgs, startArgs, stopArgs, unshareRmArgs,
} from './podman-args.js';

const id = '0123456789abcdef';
const run = `/run/slack-presence/sandbox/${id}`;

describe('podman argv (work 103, "Podman commands")', () => {
  it('create is the specified command, word for word', () => {
    expect(createArgs({ id, run, dataDir: '/data', image: 'ghcr.io/diggerhq/computer-session:abc', abi: '1' }).join('\n')).toBe(`create
--name
sp-runner-${id}
--hostname
session
--label
sp.runner=${id}
--label
sp.abi=1
--cgroups=split
--userns=keep-id:uid=1500,gid=1500
--user
1500:1500
--network=pasta
--pids-limit=4096
--sysctl
net.ipv4.ip_unprivileged_port_start=0
--sysctl
net.ipv4.ping_group_range=0 65536
--security-opt
unmask=/proc/*
--device
/dev/fuse
--device
/dev/net/tun
--log-driver=k8s-file
--log-opt
max-size=10m
--stop-timeout=10
--env
SP_RUN=${run}
--env
SP_DATA=/data
--env
SP_DEFINITION=${run}/definition.json
--env
SP_TOKEN_SOCKET=${run}/tokens/${id}.sock
--env
SP_PREVIEW_SOCKET=${run}/runners/${id}.preview.sock
-v
sp-home-${id}:/home/agent
-v
${run}:${run}
-v
/run/oc-modelproxy/api:/run/oc-modelproxy/api
-v
/opt/slack-presence:/opt/slack-presence:ro
ghcr.io/diggerhq/computer-session:abc`);
  });

  it('create mounts no workspace, no clone and nothing else of the model proxy', () => {
    const binds = createArgs({ id, run, dataDir: '/data', image: 'i', abi: '2' }).flatMap((a, i, all) => (all[i - 1] === '-v' ? [a] : []));
    expect(binds).toHaveLength(4);
    expect(binds.some((b) => /people|sessions|control\.sock|bindings/.test(b))).toBe(false);
  });

  it('start, pid, stop', () => {
    expect(startArgs(id)).toEqual(['start', '--attach', `sp-runner-${id}`]);
    expect(pidArgs(id)).toEqual(['inspect', '--format', '{{.State.Pid}}', `sp-runner-${id}`]);
    expect(stopArgs(id, 10)).toEqual(['stop', '--time', '10', `sp-runner-${id}`]);
    expect(stopArgs(id, 0)).toEqual(['stop', '--time', '0', `sp-runner-${id}`]);
  });

  it('exec runs as the session user in a directory, with no environment of its own', () => {
    expect(execArgs(id, ['sh', '-c', 'true'], { dir: '/workspace' })).toEqual(['exec', '--user', '1500:1500', '--workdir', '/workspace', `sp-runner-${id}`, 'sh', '-c', 'true']);
    expect(execArgs(id, ['cat'], { dir: '/', interactive: true }).slice(0, 2)).toEqual(['exec', '--interactive']);
    expect(execArgs(id, ['x'], { dir: '/' })).not.toContain('--env');
  });

  it('remove takes the home volume, recreate keeps it', () => {
    expect(removeArgs(id)).toEqual([['rm', '--force', '--volumes', `sp-runner-${id}`], ['volume', 'rm', '--force', `sp-home-${id}`]]);
    expect(recreateRemoveArgs(id)).toEqual(['rm', '--force', `sp-runner-${id}`]);
  });

  it('inventory lists by label and by volume name', () => {
    expect(inventoryArgs()).toEqual({
      containers: ['ps', '--all', '--filter', 'label=sp.runner', '--format', 'json'],
      volumes: ['volume', 'ls', '--filter', 'name=sp-home-', '--format', 'json'],
    });
  });

  it('session-made files are removed inside the user namespace', () => {
    expect(unshareRmArgs(['/a', '/b c'])).toEqual(['unshare', 'rm', '-rf', '--', '/a', '/b c']);
    expect(emptyRunArgs(run)).toEqual(['unshare', 'find', `${run}/runners`, `${run}/secrets`, '-mindepth', '1', '-delete']);
    expect(logsArgs(id)).toEqual(['logs', '--tail', '50', `sp-runner-${id}`]);
  });

  it('a terminal is the PTY helper in the container: as the session, in the workspace, TERM and nothing else', () => {
    expect(terminalArgs(id, '/workspace', 'xterm-256color', ['python3', '/opt/slack-presence/releases/r1/src/host/terminal-pty.py', 'sp-term-ab12'])).toEqual([
      'exec', '--interactive', '--user', '1500:1500', '--workdir', '/workspace', '--env', 'TERM=xterm-256color', `sp-runner-${id}`,
      'python3', '/opt/slack-presence/releases/r1/src/host/terminal-pty.py', 'sp-term-ab12',
    ]);
  });

  it('hanging a terminal up signals its own helper, not every terminal of the session', () => {
    const args = terminalHangUpArgs(id, 'sp-term-ab12');
    expect(args).toEqual(['exec', '--user', '1500:1500', `sp-runner-${id}`, 'pkill', '-HUP', '-f', 'terminal-pty\\.py sp-term-ab12$']);
    const pattern = new RegExp(args.at(-1) as string);
    expect(pattern.test('python3 /opt/slack-presence/releases/r1/src/host/terminal-pty.py sp-term-ab12')).toBe(true);
    expect(pattern.test('python3 /opt/slack-presence/releases/r1/src/host/terminal-pty.py sp-term-ab123')).toBe(false);
  });

  it('a files helper mounts the workspace and nothing else, read-only unless it writes, without a network', () => {
    const h = { person: 'U1', workspace: '/data/people/U1/sessions/C1-1-2', image: 'img:tag' };
    expect(filesHelperArgs(h, '/workspace', ['/bin/sh', '-c', 'cat -- "$1"', 'sh', 'a b'])).toEqual([
      'run', '--rm', '--label', 'sp.helper=U1', '--cgroups=split', '--userns=keep-id:uid=1500,gid=1500', '--user', '1500:1500',
      '--network=none', '--pids-limit=1024', '--log-driver=none', '--env', 'HOME=/tmp', '--workdir', '/workspace',
      '-v', '/data/people/U1/sessions/C1-1-2:/workspace:ro', '--entrypoint', '/bin/sh', 'img:tag', '-c', 'cat -- "$1"', 'sh', 'a b',
    ]);
    const w = filesHelperArgs({ ...h, write: true, interactive: true }, '/workspace', ['/bin/sh']);
    expect(w).toContain('--interactive');
    expect(w).toContain('/data/people/U1/sessions/C1-1-2:/workspace');
    expect(w.filter((a) => a === '-v')).toHaveLength(1);
  });
});
