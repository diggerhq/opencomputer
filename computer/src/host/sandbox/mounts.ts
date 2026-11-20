// What a thread's container gets mounted after every start (work 103, "Mount
// helper"): its workspace, the person's clones it uses, its own worktree
// registry over each clone's, and its journal directory. `bindsFor` is the
// ordered list; `applyMounts` hands it to bin/sandbox-mount.py, which runs as
// the runners' user inside Podman's user namespace.
//
// Invariants:
// - Every source is below the record's person directory, or is the journal
//   directory; the names in it come from the record and the definition, never
//   from a session. The helper checks the same again and follows no link.
// - Order: the workspace, every clone, then every registry (a registry is
//   mounted inside its clone), the journal last.
// - A thread sees only its own registry at `/clones/<r>/.git/worktrees`, so
//   `git worktree prune` in one thread cannot forget another's worktrees.
// - Mounts do not survive a stop: the caller applies them after every start.
//   A destination already mounted is left alone, so applying twice is safe.

import path from 'node:path';
import { safeKey } from '../../workspaces/clones.js';
import type { AsRunner } from './podman.js';
import { type Bind, mountArgs } from './podman-args.js';
import type { SandboxRecord } from './records.js';

/** The workspace and the clones, as a session and a helper container see them. */
export const WORKSPACE = '/workspace';
export const CLONES = '/clones';
const MOUNT_TIMEOUT_MS = 10_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface MountsDeps {
  as: AsRunner;
  /** The host's release, which holds bin/sandbox-mount.py. */
  root: string;
  /** The host's SP_DATA. */
  dataDir: string;
}

export type Mounts = ReturnType<typeof mounts>;

const named = (kind: string, name: string) => {
  if (!NAME.test(name) || name === '.git') throw new Error(`bad ${kind} name: ${name}`);
  return name;
};

export function mounts(d: MountsDeps) {
  const people = path.join(d.dataDir, 'people');
  const personDir = (person: string) => path.join(people, named('person', person));
  /** `<people>/<p>/ws`, a helper container's `/clones`. */
  const clones = (person: string) => path.join(personDir(person), 'ws');
  const clone = (person: string, repo: string) => path.join(clones(person), named('repository', repo));
  /** The thread's files on the host: its `/workspace`. */
  const workspace = (r: Pick<SandboxRecord, 'person' | 'key'>) => path.join(personDir(r.person), 'sessions', safeKey(r.key));
  /** The thread's own worktree registry for one clone. */
  const registry = (r: Pick<SandboxRecord, 'person' | 'key'>, repo: string) => path.join(personDir(r.person), 'wt', safeKey(r.key), named('repository', repo));

  /** The clone and the registry of each repository, clones first: what `checkout` adds to a running container. */
  const repoBinds = (r: Pick<SandboxRecord, 'person' | 'key'>, repos: string[]): Bind[] => [
    ...repos.map((name) => ({ src: clone(r.person, name), dst: `${CLONES}/${name}` })),
    ...repos.map((name) => ({ src: registry(r, name), dst: `${CLONES}/${name}/.git/worktrees` })),
  ];

  /** The ordered bind list of a thread's container. `journalDir`: the session's journal directory, when it has one. */
  const bindsFor = (r: Pick<SandboxRecord, 'person' | 'key'>, repos: string[], journalDir?: string): Bind[] => [
    { src: workspace(r), dst: WORKSPACE },
    ...repoBinds(r, repos),
    ...(journalDir ? [{ src: journalDir, dst: journalDir }] : []),
  ];

  /** Mount `binds` into the running container whose first process is `pid` (10 s). Rejects with the helper's own line. */
  async function applyMounts(id: string, pid: number, person: string, binds: Bind[]): Promise<void> {
    if (!binds.length) return;
    await d.as.podman(mountArgs(d.root, pid, id, named('person', person), binds), { timeoutMs: MOUNT_TIMEOUT_MS, env: { SP_DATA: d.dataDir } });
  }

  return { people, clones, clone, workspace, registry, repoBinds, bindsFor, applyMounts };
}
