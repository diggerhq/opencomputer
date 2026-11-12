// Every Podman argv the host runs for a thread's sandbox (work 103, "Podman
// commands"), as pure functions: the arguments after `podman`. One container
// `sp-runner-<id>`, one volume `sp-home-<id>`, one run directory per runner id.
//
// Invariants:
// - Nothing here runs anything or reads the environment; containers.ts runs
//   these through podman.ts, as the runners' user.
// - Create is the same for a spare, a new thread and a recreation: what a
//   start may change goes through boot.env (boot-env.ts), never through argv.
// - The paths are the same inside and outside the container; the workspace is
//   the one exception and is not mounted here.

import path from 'node:path';
import { type RunRoot, previewSocketFor, tokenSocketFor } from '../../ipc.js';

/** The user every session runs as, inside and outside (the image's `agent`). */
export const SESSION_USER = '1500:1500';
/** The only directory of the model proxy a session sees: its API socket, nothing else. */
export const MODEL_PROXY_DIR = '/run/oc-modelproxy/api';
/** Where releases live, mounted read-only at the same path. */
export const RELEASES_DIR = '/opt/slack-presence';

export const containerName = (id: string) => `sp-runner-${id}`;
export const volumeName = (id: string) => `sp-home-${id}`;
/** The transient unit a container runs in; the model proxy tells sessions apart by it. */
export const unitName = (id: string) => `sp-runner-${id}.service`;

export interface CreateSpec {
  id: string;
  /** The runner's run root, `$SP_RUN/sandbox/<id>`. */
  run: RunRoot;
  /** The host's SP_DATA. */
  dataDir: string;
  /** SP_IMAGE and SP_IMAGE_ABI. */
  image: string;
  abi: string;
}

export function createArgs(c: CreateSpec): string[] {
  return [
    'create', '--name', containerName(c.id), '--hostname', 'session',
    '--label', `sp.runner=${c.id}`, '--label', `sp.abi=${c.abi}`,
    '--cgroups=split', '--userns=keep-id:uid=1500,gid=1500', '--user', SESSION_USER,
    '--network=pasta', '--pids-limit=4096',
    '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0',
    // An upper bound outside the user namespace's mapping fails every start (podman#28180).
    '--sysctl', 'net.ipv4.ping_group_range=0 65536',
    // These three are for containers inside the session (rootless Podman in Podman).
    '--security-opt', 'unmask=/proc/*',
    '--device', '/dev/fuse', '--device', '/dev/net/tun',
    '--log-driver=k8s-file', '--log-opt', 'max-size=10m',
    '--stop-timeout=10',
    '--env', `SP_RUN=${c.run}`, '--env', `SP_DATA=${c.dataDir}`,
    '--env', `SP_DEFINITION=${path.join(c.run, 'definition.json')}`,
    '--env', `SP_TOKEN_SOCKET=${tokenSocketFor(c.run, c.id)}`,
    '--env', `SP_PREVIEW_SOCKET=${previewSocketFor(c.run, c.id)}`,
    '-v', `${volumeName(c.id)}:/home/agent`,
    '-v', `${c.run}:${c.run}`,
    '-v', `${MODEL_PROXY_DIR}:${MODEL_PROXY_DIR}`,
    '-v', `${RELEASES_DIR}:${RELEASES_DIR}:ro`,
    c.image,
  ];
}

/** What the container's unit runs (launch.ts): attached, so the unit lives as long as the container. */
export const startArgs = (id: string) => ['start', '--attach', containerName(id)];

/** The container's first process as the host sees it; 0 while it has none. */
export const pidArgs = (id: string) => ['inspect', '--format', '{{.State.Pid}}', containerName(id)];

/** A command in the running container. No `--env`: the container's own environment is complete. */
export const execArgs = (id: string, argv: string[], o: { dir: string; interactive?: boolean }) =>
  ['exec', ...(o.interactive ? ['--interactive'] : []), '--user', SESSION_USER, '--workdir', o.dir, containerName(id), ...argv];

/**
 * A terminal's helper in the running container (terminal.ts): `helper` is `python3 <ROOT>/src/host/terminal-pty.py`
 * and the terminal's unit name, which the helper ignores and `terminalHangUpArgs` matches.
 */
export const terminalArgs = (id: string, dir: string, term: string, helper: string[]) =>
  ['exec', '--interactive', '--user', SESSION_USER, '--workdir', dir, '--env', `TERM=${term}`, containerName(id), ...helper];

/** SIGHUP to the helper of one terminal (`unit`: `sp-term-<hex>`), whose `podman exec` is gone. */
export const terminalHangUpArgs = (id: string, unit: string) =>
  ['exec', '--user', SESSION_USER, containerName(id), 'pkill', '-HUP', '-f', `terminal-pty\\.py ${unit}$`];

/** The scope a helper container runs in: Podman needs a delegated cgroup of the runners' user, and the host's own is not one. */
export const HELPER_SCOPE = ['/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--slice=slack-presence-runners.slice', '-p', 'Delegate=yes', '--'];

export interface FilesHelper {
  /** `person.dir`, the helper's label. */
  person: string;
  /** The thread's workspace on the host. */
  workspace: string;
  image: string;
  /** Mount the workspace writable; without it nothing the command does can change a file. */
  write?: boolean;
  /** Keep standard input open. */
  interactive?: boolean;
}

/**
 * A command over the workspace of a thread whose container is not running (workspace-exec.ts): a container that
 * lives as long as the command, with the workspace at `dir` and nothing else of the host's, and no network.
 */
export const filesHelperArgs = (h: FilesHelper, dir: string, argv: string[]) => [
  'run', '--rm', ...(h.interactive ? ['--interactive'] : []), '--label', `sp.helper=${h.person}`,
  '--cgroups=split', '--userns=keep-id:uid=1500,gid=1500', '--user', SESSION_USER,
  '--network=none', '--pids-limit=1024', '--log-driver=none', '--env', 'HOME=/tmp', '--workdir', dir,
  '-v', `${h.workspace}:${dir}${h.write ? '' : ':ro'}`,
  '--entrypoint', argv[0], h.image, ...argv.slice(1),
];

/** `seconds`: how long the runner gets after SIGTERM before SIGKILL. */
export const stopArgs = (id: string, seconds: number) => ['stop', '--time', String(seconds), containerName(id)];

/** The container with its anonymous volumes, then its home: two commands, in this order. */
export const removeArgs = (id: string) => [
  ['rm', '--force', '--volumes', containerName(id)],
  ['volume', 'rm', '--force', volumeName(id)],
];

/** The container alone; its home volume stays for the one created next (Recreate). */
export const recreateRemoveArgs = (id: string) => ['rm', '--force', containerName(id)];

export const inventoryArgs = () => ({
  containers: ['ps', '--all', '--filter', 'label=sp.runner', '--format', 'json'],
  volumes: ['volume', 'ls', '--filter', 'name=sp-home-', '--format', 'json'],
});

/** Files a session made belong to subordinate uids when it made them as root: removed inside the user namespace. */
export const unshareRmArgs = (paths: string[]) => ['unshare', 'rm', '-rf', '--', ...paths];

/** Empties what a session may write in its run directory (`up`, step 1). */
export const emptyRunArgs = (run: RunRoot) => ['unshare', 'find', path.join(run, 'runners'), path.join(run, 'secrets'), '-mindepth', '1', '-delete'];

/** The end of what the container wrote to its output, for a start that never became ready. */
export const logsArgs = (id: string, lines = 50) => ['logs', '--tail', String(lines), containerName(id)];
