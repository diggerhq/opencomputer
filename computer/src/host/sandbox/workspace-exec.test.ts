import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { placeArgv, sandboxPlaces } from './workspace-exec.js';

const id = '0123456789abcdef';
const sb = { id, person: 'U1', workspace: '/data/people/U1/sessions/C1-1-2', running: true };

describe('where a sandboxed workspace is reached', () => {
  it('a running thread: podman exec in its container, as the session, in /workspace', () => {
    expect(placeArgv(sb, 'img:tag', ['/bin/sh', '-c', 'x'], {})).toEqual(
      ['/usr/bin/podman', 'exec', '--user', '1500:1500', '--workdir', '/workspace', `sp-runner-${id}`, '/bin/sh', '-c', 'x']);
    expect(placeArgv(sb, 'img:tag', ['/bin/sh'], { stdin: true })).toContain('--interactive');
  });

  it('a stopped thread: a helper container in a delegated scope, the workspace read-only unless the command writes', () => {
    const stopped = { ...sb, running: false };
    const read = placeArgv(stopped, 'img:tag', ['/bin/sh', '-c', 'x'], {});
    expect(read.slice(0, 10)).toEqual(['/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--slice=slack-presence-runners.slice', '-p', 'Delegate=yes', '--', '/usr/bin/podman', 'run']);
    expect(read).toContain(`${sb.workspace}:/workspace:ro`);
    expect(read).toContain('--network=none');
    expect(read.slice(-4)).toEqual(['/bin/sh', 'img:tag', '-c', 'x']);
    expect(read).not.toContain(`sp-runner-${id}`);
    const write = placeArgv(stopped, 'img:tag', ['/bin/sh', '-c', 'x'], { write: true, stdin: true });
    expect(write).toContain(`${sb.workspace}:/workspace`);
    expect(write).toContain('--interactive');
  });

  it("starts the command as the runners' user, with /workspace as the root the scripts see", () => {
    const started: string[][] = [];
    const place = sandboxPlaces({ sudo: ['/usr/bin/sudo', '-n', '-u', 'agent'], image: 'img:tag', spawn: (cmd, args) => (started.push([cmd, ...args]), {} as ChildProcess) })(sb);
    expect(place.root).toBe('/workspace');
    place.spawn(['/bin/sh', '-c', 'x'], {});
    expect(started[0].slice(0, 7)).toEqual(['/usr/bin/sudo', '-n', '-u', 'agent', '--', '/usr/bin/podman', 'exec']);
  });
});
