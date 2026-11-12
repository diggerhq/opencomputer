// A thread's workspace when the thread runs in a container (work 103,
// "Sequences"): which repositories it gets, the directories its mounts need,
// its worktrees and root files (`prepare`), and repositories added later
// (`checkout`). The sandbox record is the fork record: it says which
// repositories the thread has, and `.fork.json` in the workspace is a copy the
// session reads, never read back.
//
// Invariants:
// - The host runs no git and writes no file in a workspace, a clone or a
//   registry: worktrees are added by bin/ws-add.sh inside the thread's
//   container, as the session's user, and root files reach the workspace as a
//   tar stream on that script's stdin. The host only makes the empty
//   directories the mounts need, as the runners' user, before anything is
//   mounted.
// - A repository's name comes from the definition or the record, never from a
//   session: `checkout` resolves what the session asked for against the
//   definition before it names a path.
// - A record has `repos` only once the workspace was prepared whole (worktrees
//   added, root files unpacked): a start that finds none prepares it again,
//   and ws-add.sh leaves what is already there as it is.
// - One clone, one worktree operation at a time (clones.ts `serial`), all of
//   a thread's clones held for the one run that adds its worktrees.
// - A repository that cannot be added is left out with a warning, not fatal.

import { readFileSync } from 'node:fs';
import { log } from '../../log.js';
import type { CheckoutResult, Person } from '../../protocol.js';
import {
  cloneRepo, errText, fetchedAt, forkFetchFresh, freshness, isClone, prepareInBackground, safeKey, serial, workspacePrepared,
} from '../../workspaces/clones.js';
import { type Definition, isLazy, loadDefinition, workspacesEnabled } from '../../workspaces/definition.js';
import { findRepo, type ForkInfo } from '../../workspaces/fork.js';
import { FORK_FILE } from '../../workspaces/idle.js';
import { repoIndex } from '../../workspaces/repo-index.js';
import { rows, type ScriptRunner } from '../../workspaces/script-runner.js';
import { CLONES, type Mounts, WORKSPACE } from './mounts.js';
import type { AsRunner } from './podman.js';
import type { Bind } from './podman-args.js';
import type { Records, SandboxRecord } from './records.js';
import { type TarFile, tarOf } from './tar.js';

/** ws-add.sh in a session, in all (the spec's "Exec `ws-add.sh`"); each of its fetches has 5 s inside the script. */
export const ADD_TIMEOUT_MS = 60_000;
const MKDIR_TIMEOUT_MS = 10_000;
export const NO_DEFINITION = 'this host has no workspace definition; there is nothing to check out';

type Repos = NonNullable<SandboxRecord['repos']>;

export interface WorkspaceDeps {
  as: AsRunner;
  records: Records;
  mounts: Mounts;
  /** `sandboxScripts.sessionScripts`: the scripts in a thread's running container. */
  scripts(id: string): ScriptRunner;
  /** `containers.pid`: the running container's first process. */
  pid(id: string): Promise<number>;
}

export type SandboxWorkspace = ReturnType<typeof sandboxWorkspaces>;

/** `fn` with every one of these clones' worktree locks held, taken in one order whoever asks. */
const holding = <T>(clones: string[], fn: () => Promise<T>): Promise<T> =>
  [...new Set(clones)].sort().reduceRight<() => Promise<T>>((inner, c) => () => serial(c, inner), fn)();

/** AGENTS.md and the other root files of the definition, as text, with the repository index when some repository is not checked out. */
function rootFiles(def: Definition, checkedOut: string[]): TarFile[] {
  const files = new Map<string, string>();
  for (const [target, source] of Object.entries(def.rootFiles)) {
    try {
      files.set(target, readFileSync(source, 'utf8'));
    } catch (e) {
      log.warn(`workspaces: root file ${target}: ${errText(e)}`);
    }
  }
  const index = repoIndex(def.repos, new Set(checkedOut));
  if (index) files.set('AGENTS.md', `${files.get('AGENTS.md') ?? ''}\n${index}`);
  return [...files].map(([name, text]) => ({ name, text }));
}

export function sandboxWorkspaces(d: WorkspaceDeps) {
  const { mounts: m } = d;
  const branchOf = (r: SandboxRecord) => `sp/${safeKey(r.key)}`;
  const need = (id: string) => {
    const r = d.records.get(id);
    if (!r) throw new Error(`no sandbox record ${id}`);
    return r;
  };
  const cloned = (person: string, name: string) => {
    try {
      return isClone(m.clone(person, name));
    } catch {
      return false; // not a name for a path
    }
  };

  /** The repositories a start mounts: the record's once it has any, else the definition's; only those whose clone is there. */
  function repos(r: SandboxRecord): string[] {
    const names = r.repos ? Object.keys(r.repos) : workspacesEnabled() ? loadDefinition().repos.filter((x) => !x.unpublished).map((x) => x.name) : [];
    return names.filter((name) => cloned(r.person, name));
  }

  /**
   * The thread's workspace, the person's clones (which every helper container mounts, also one that only reads the
   * workspace of a thread with no repository) and the thread's registry for each of these repositories, made as the
   * runners' user. Safe to repeat.
   */
  async function dirs(r: SandboxRecord, names: string[]): Promise<void> {
    await d.as.run(['/bin/mkdir', '-p', '--', m.workspace(r), m.clones(r.person), ...names.map((name) => m.registry(r, name))], { timeoutMs: MKDIR_TIMEOUT_MS });
  }

  /** What a start mounts, in order (mounts.ts). */
  const binds = (r: SandboxRecord, names: string[], journalDir?: string): Bind[] => m.bindsFor(r, names, journalDir);
  const mount = (id: string, pid: number, person: string, b: Bind[]) => m.applyMounts(id, pid, person, b);

  /** One run of ws-add.sh in the thread's container for all of `names`: what was added, and why the rest was not. */
  async function add(r: SandboxRecord, id: string, names: string[], def: Definition): Promise<{ added: Repos; failed: Map<string, string> }> {
    const added: Repos = {};
    const failed = new Map<string, string>();
    if (!names.length) return { added, failed };
    const clones = new Map(names.map((name) => [name, m.clone(r.person, name)] as const));
    await holding([...clones.values()], async () => {
      // One flag for the run: fetched unless every clone's refs are fresh (fetch-schedule.ts).
      const fetch = [...clones.values()].some((c) => !freshness.fresh(c, forkFetchFresh()));
      const started = Date.now();
      // The branch forks start from, when the definition names it; the script finds origin/HEAD otherwise.
      const args = names.map((name) => {
        const b = def.repos.find((x) => x.name === name)?.branch;
        return b ? `${name}=${b}` : name;
      });
      const out = rows(await d.scripts(id).run('ws-add.sh', [CLONES, WORKSPACE, branchOf(r), fetch ? '1' : '0', ...args], { timeoutMs: ADD_TIMEOUT_MS }));
      for (const name of names) {
        const [status, ...f] = out.get(name) ?? [];
        if (status !== 'ok') {
          failed.set(name, status === 'failed' ? f[0] || 'failed' : `no result for ${name}`);
          continue;
        }
        const [branch, base, head, fetchError] = f;
        added[name] = { branch, from: `origin/${base}`, base: head, ...(fetchError && { fetchError }) };
        if (fetch && !fetchError) {
          fetchedAt.set(clones.get(name)!, new Date().toISOString());
          freshness.fetchedFrom(clones.get(name)!, started);
        }
      }
    });
    return { added, failed };
  }

  /** The session's copy of the record, in the shape a fork's record has always had. */
  const forkFile = (r: SandboxRecord, all: Repos, ms: number): TarFile => {
    const info: ForkInfo = { key: r.key, owner: r.person, createdAt: r.createdAt, ms, repos: all };
    return { name: FORK_FILE, text: JSON.stringify(info, null, 2) + '\n' };
  };
  /** Files into the workspace's root: unpacked in the thread's container, as the session's user. */
  const unpack = (id: string, r: SandboxRecord, files: TarFile[]) =>
    d.scripts(id).run('ws-add.sh', [CLONES, WORKSPACE, branchOf(r), '0'], { stdin: tarOf(files), timeoutMs: ADD_TIMEOUT_MS });

  /**
   * Make the workspace of a thread whose record has no `repos` yet, in its running container: a worktree of each of
   * `names` (those `repos` gave this start, mounted already), then `.fork.json` and the root files. Resolves with the
   * record, now with `repos`, and the time the worktrees took. Rejects when the root files could not be written.
   */
  async function prepare(id: string, names: string[]): Promise<{ record: SandboxRecord; addMs: number }> {
    return serial(`sandbox:${id}`, async () => {
      const r = need(id);
      const def = loadDefinition();
      const person = { dir: r.person } as Person;
      // Nothing here waits on a clone (work 056): eager repositories still missing are cloned in the background.
      if (!workspacePrepared(person) || def.repos.some((x) => !x.unpublished && !isLazy(x) && !cloned(r.person, x.name))) prepareInBackground(person);
      const t0 = Date.now();
      const { added, failed } = await add(r, id, names, def).catch((e) => ({ added: {} as Repos, failed: new Map(names.map((name) => [name, errText(e)])) }));
      const addMs = Date.now() - t0;
      for (const [name, why] of failed) log.warn(`workspaces: ${name} left out of ${r.key}: ${why}`);
      await unpack(id, r, [forkFile(r, added, addMs), ...rootFiles(def, Object.keys(added))]);
      const record = { ...need(id), repos: added };
      d.records.write(record);
      log.info(`workspaces: ${Object.keys(added).length} repos in the container of ${r.key} (${r.person}) in ${addMs} ms`);
      for (const [name, x] of Object.entries(added)) if (x.fetchError) log.warn(`workspaces: ${name} from cached ${x.from} (${x.base.slice(0, 8)}); fetch failed: ${x.fetchError}`);
      return { record, addMs };
    });
  }

  /**
   * Check repositories out into a running thread (the session's `checkout_repo`): clone each if missing, in a helper
   * container, then mount it and its registry and add its worktree. `wanted` holds definition names or `owner/name`.
   * Each repository succeeds or fails on its own; the record gains the ones checked out.
   */
  async function checkout(id: string, wanted: string[]): Promise<CheckoutResult[]> {
    if (!workspacesEnabled()) throw new Error(NO_DEFINITION);
    const r = need(id);
    const def = loadDefinition();
    const branch = branchOf(r);
    const results = new Map<string, CheckoutResult>();
    const fail = (name: string, error: string) => void results.set(name, { name, dir: name, branch, from: '', base: '', error });
    const names: string[] = [];
    await Promise.all(
      [...new Set(wanted.map((w) => w.trim()).filter(Boolean))].map(async (want) => {
        const repo = findRepo(def.repos, want);
        if (!repo) return fail(want, `no repository ${want} in this workspace; the list is in AGENTS.md`);
        if (repo.unpublished) return fail(repo.name, `${repo.name} is not published yet`);
        try {
          const t0 = Date.now();
          if (await cloneRepo(m.clone(r.person, repo.name), repo)) log.info(`workspaces: ${repo.name} cloned on demand for ${r.key} in ${Date.now() - t0} ms`);
          if (!names.includes(repo.name)) names.push(repo.name);
        } catch (e) {
          fail(repo.name, errText(e));
        }
      }),
    );
    if (names.length)
      await serial(`sandbox:${id}`, async () => {
        try {
          await dirs(r, names);
          await mount(id, await d.pid(id), r.person, m.repoBinds(r, names));
          const { added, failed } = await add(r, id, names, def);
          for (const [name, why] of failed) fail(name, why);
          if (!Object.keys(added).length) return;
          // The record first read may be older than a checkout that ran meanwhile.
          const now = need(id);
          const all = { ...now.repos, ...added };
          await unpack(id, now, [forkFile(now, all, 0)]);
          d.records.write({ ...need(id), repos: all });
          for (const [name, x] of Object.entries(added)) results.set(name, { name, dir: name, ...x });
        } catch (e) {
          for (const name of names) if (!results.has(name)) fail(name, errText(e));
        }
      });
    return [...results.values()];
  }

  /** Mark the thread as used now (a delivery): what pruning counts from. */
  function touch(id: string) {
    const r = d.records.get(id);
    if (r) d.records.write({ ...r, usedAt: new Date().toISOString() });
  }

  return { repos, dirs, binds, mount, prepare, checkout, touch };
}
