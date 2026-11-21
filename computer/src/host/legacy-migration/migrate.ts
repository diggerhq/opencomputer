// ONE-TIME systemd->podman migration (work 103). Delete together with the systemd launch path in step 11.
//
// A thread made under the `systemd` launch, reaching a `podman` host: it has
// a fork in `<people>/<p>/sessions/<key>` and no sandbox record. Its first
// start on the `podman` host (sandbox/start.ts, in the thread's turn) asks
// `migrateLegacy` before it takes the thread for a new one. That gives it a
// home volume holding its transcript, its worktrees re-pointed at container
// paths, and a record, so the start resumes it under the session id the
// gateway sent.
//
// Invariants:
// - It runs only on a record miss, in the thread's turn (thread-lock.ts), and
//   only for a thread whose fork is there: a new thread is not touched.
// - The home volume is made first, so that the start finds it and resumes
//   with `sdkSessionId` (start.ts keeps it only for a home that was there).
// - The files move in one helper container (bin/legacy-migrate.mjs) as uid
//   1500 under `--userns=keep-id:uid=1500`: the host itself reads and writes
//   nothing of the person's.
// - The record is written last, with the repositories `.fork.json` named and
//   the script re-pointed. A thread with a record is never migrated again.
// - Any failure leaves the thread as a new one: its volume removed, its fork
//   moved to `<people>/<p>/sessions.pre-sandbox/<key>` (an earlier one there
//   kept as `<key>.~N~`), and the start goes on with no record and no
//   transcript. When the fork cannot be moved either, the start fails.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { codexHome } from '../../codex-home.js';
import type { RunRoot } from '../../ipc.js';
import { log } from '../../log.js';
import type { SessionSpec } from '../../protocol.js';
import { safeKey } from '../../workspaces/clones.js';
import type { Mounts } from '../sandbox/mounts.js';
import { type AsRunner, PODMAN } from '../sandbox/podman.js';
import { HELPER_SCOPE, helperArgs, homeArgs, volumeName } from '../sandbox/podman-args.js';
import type { Records, SandboxRecord } from '../sandbox/records.js';

/** The script's whole run, Podman's own bound; the host waits a little longer. */
export const MIGRATE_SECONDS = 300;
const STEP_MS = 60_000;

export interface LegacyDeps {
  as: AsRunner;
  records: Records;
  mounts: Pick<Mounts, 'people' | 'workspace' | 'clones'>;
  /** The host's release (bin/legacy-migrate.mjs), the image, the helpers' run directory. */
  root: string;
  image: string;
  helperRun: string;
  runRoot(id: string): RunRoot;
  /** The runners' user's HOME, where the `systemd` runners kept ~/.claude and ~/.calvin. */
  agentHome: string;
  /** True when the thread has a fork on this host (workspace.ts `there`). */
  there(person: string, key: string): boolean;
  newId?: () => string;
}

export interface LegacyResult {
  repos: NonNullable<SandboxRecord['repos']>;
  claude: boolean;
  codex: boolean;
  skipped: { repo: string; why: string }[];
}

/** The argv, for the runners' user, of the helper container that migrates one thread. */
export function migrateArgv(o: {
  root: string; image: string; helperRun: string; people: string; person: string; id: string; fork: string; clones: string; wt: string;
  claudeProjects?: string; codex?: string; harness: string; sdkSessionId?: string; codexName: string;
}): string[] {
  const binds = [
    ...(o.claudeProjects ? [{ src: o.claudeProjects, dst: '/legacy/claude-projects', ro: true }] : []),
    ...(o.codex ? [{ src: o.codex, dst: '/legacy/codex', ro: true }] : []),
    { src: volumeName(o.id), dst: '/home/agent' },
    { src: o.wt, dst: '/wt' },
    { src: o.fork, dst: '/workspace' },
  ];
  const script = path.join(o.root, 'bin', 'legacy-migrate.mjs');
  return [
    ...HELPER_SCOPE, PODMAN,
    ...helperArgs({ person: o.person, people: o.people, run: o.helperRun, image: o.image, network: false, timeoutS: MIGRATE_SECONDS, binds,
      sh: ['-c', 'exec node "$0" "$@"', script, o.fork, o.clones, o.harness, o.sdkSessionId || '-', o.codexName] }),
  ];
}

/** The last line of the script's output, as its result; throws when it is not one. */
export function parseResult(out: string): LegacyResult {
  const line = out.trim().split('\n').pop() ?? '';
  const r = JSON.parse(line) as LegacyResult;
  if (!r || typeof r.repos !== 'object' || r.repos === null || !Array.isArray(r.skipped)) throw new Error(`legacy-migrate printed ${line.slice(0, 200)}`);
  return r;
}

export function legacyMigration(d: LegacyDeps) {
  const newId = d.newId ?? (() => randomBytes(8).toString('hex'));
  const exists = (p: string) => d.as.run(['/usr/bin/test', '-d', p], { timeoutMs: STEP_MS }).then(() => true, () => false);

  /** The fork out of the way, so that the thread starts fresh; rejects when it could not be moved. */
  async function setAside(person: string, fork: string) {
    const aside = path.join(d.mounts.people, person, 'sessions.pre-sandbox');
    await d.as.run(['/bin/mkdir', '-p', '--', aside], { timeoutMs: STEP_MS });
    await d.as.run(['/bin/mv', '--backup=numbered', '-T', '--', fork, path.join(aside, path.basename(fork))], { timeoutMs: STEP_MS });
  }

  /**
   * The sandbox record of `spec`'s thread made from its `systemd` fork, or undefined: there is no fork (a new thread), or the
   * migration failed and the fork was set aside (a new thread now). Call it in the thread's turn, on a record miss.
   */
  return async function migrateLegacy(spec: SessionSpec): Promise<SandboxRecord | undefined> {
    const person = spec.owner.dir;
    const { key } = spec;
    if (!d.there(person, key)) return undefined;
    const fork = d.mounts.workspace({ person, key });
    const id = newId();
    const t0 = Date.now();
    try {
      await d.as.podman(homeArgs(id, d.runRoot(id)), { timeoutMs: STEP_MS, repeatable: true });
      const wt = path.join(d.mounts.people, person, 'wt', safeKey(key));
      const clones = d.mounts.clones(person);
      await d.as.run(['/bin/mkdir', '-p', '--', wt, clones], { timeoutMs: STEP_MS });
      const claudeProjects = path.join(d.agentHome, '.claude', 'projects');
      const codex = path.join(d.agentHome, '.calvin', 'codex');
      const argv = migrateArgv({
        root: d.root, image: d.image, helperRun: d.helperRun, people: d.mounts.people, person, id, fork, clones, wt,
        claudeProjects: (await exists(claudeProjects)) ? claudeProjects : undefined, codex: (await exists(codex)) ? codex : undefined,
        harness: spec.harness ?? 'claude', sdkSessionId: spec.sdkSessionId, codexName: path.basename(codexHome('/', key)),
      });
      await d.as.settled();
      const r = parseResult(await d.as.run(argv, { timeoutMs: (MIGRATE_SECONDS + 10) * 1000 }));
      const now = new Date().toISOString();
      const record: SandboxRecord = { id, person, key, createdAt: now, usedAt: now, repos: r.repos };
      d.records.write(record); // last: from here the thread is a sandboxed one
      for (const s of r.skipped) log.warn(`legacy migration: ${s.repo} left out of ${key}: ${s.why}`);
      log.info(`legacy migration: ${key} (${person}) is sandbox ${id} in ${Date.now() - t0} ms: ${Object.keys(r.repos).length} repos, transcript ${r.claude ? 'copied' : 'none'}, codex ${r.codex ? 'copied' : 'none'}`);
      return record;
    } catch (e) {
      log.warn(`legacy migration: ${key} (${person}) not migrated, starting fresh with its fork set aside: ${(e as Error)?.message ?? e}`);
      await d.as.podman(['volume', 'rm', '--force', volumeName(id)], { timeoutMs: STEP_MS, repeatable: true }).catch(() => {});
      await setAside(person, fork);
      return undefined;
    }
  };
}
