#!/usr/bin/env node
// ONE-TIME systemd->podman migration (work 103). Delete together with the systemd launch path in step 11.
//
// Moves one thread made under the `systemd` launch into the shape a container
// expects, from inside a helper container (src/host/legacy-migration/migrate.ts
// runs it as uid 1500 under `--userns=keep-id:uid=1500`, so whatever it writes
// is the session's). Mounts it is given:
//   /legacy/claude-projects  ro  the runners' user's ~/.claude/projects (absent when there is none)
//   /legacy/codex            ro  the runners' user's ~/.calvin/codex (absent when there is none)
//   /home/agent                  the thread's new home volume
//   /clones                      the person's clones (`<people>/<p>/ws`)
//   /wt                          the thread's worktree registries (`<people>/<p>/wt/<key>`)
//   /workspace                   the thread's fork (`<people>/<p>/sessions/<key>`), in place
//
//   node legacy-migrate.mjs <fork on the host> <clones on the host> <harness> <sdkSessionId or -> <codex home name>
//
// Prints one JSON line: { repos, claude, codex, skipped }. Exits non-zero (the
// host then sets the fork aside and starts the thread fresh) when the fork has
// no `.fork.json` or the transcript it is to resume is not there.
//
// Invariants:
// - The person's files change only in the worktree step, which is last and is
//   safe to repeat: an admin directory already moved is found in /wt.
// - A transcript's absolute paths are rewritten: the fork -> /workspace, the
//   clones -> /clones. Nothing else in it changes, and the session id is kept.
// - No git runs: the worktree's `.git` file and its admin directory's
//   `gitdir` are written directly; `commondir` is left as it is.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const IN = {
  claudeProjects: '/legacy/claude-projects',
  codex: '/legacy/codex',
  home: '/home/agent',
  clones: '/clones',
  wt: '/wt',
  workspace: '/workspace',
};

/** Claude Code's project directory name for a cwd. */
export function claudeSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with the fork's host path made /workspace and the clones' made /clones; a longer name that only starts the same is left alone. */
export function rewritePaths(text, forkHost, clonesHost) {
  const fork = forkHost.replace(/\/+$/, '');
  const clones = clonesHost.replace(/\/+$/, '');
  return text
    .replace(new RegExp(`${escape(fork)}(?![A-Za-z0-9._-])`, 'g'), '/workspace')
    .replace(new RegExp(`${escape(clones)}/`, 'g'), '/clones/');
}

/** Copy `src` into `dst`, rewriting the text of .jsonl and .json files. */
function copyRewritten(src, dst, rewrite) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(src)) copyRewritten(path.join(src, name), path.join(dst, name), rewrite);
  } else if (st.isFile()) {
    if (/\.jsonl?$/.test(src)) writeFileSync(dst, rewrite(readFileSync(src, 'utf8')), { mode: st.mode & 0o777 });
    else cpSync(src, dst, { preserveTimestamps: true });
  }
}

/** The Claude project directory of `cwd` under `projects`, or undefined; Claude Code shortens a long name and adds a hash. */
function projectDir(projects, cwd) {
  const slug = claudeSlug(cwd);
  if (existsSync(path.join(projects, slug))) return path.join(projects, slug);
  if (slug.length <= 200 || !existsSync(projects)) return undefined;
  const found = readdirSync(projects).find((n) => n.startsWith(`${slug.slice(0, 200)}-`));
  return found && path.join(projects, found);
}

/** Rename, or copy and remove when the two are on different mounts. */
function move(src, dst) {
  try {
    renameSync(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    cpSync(src, dst, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    rmSync(src, { recursive: true, force: true });
  }
}

/**
 * One repository's worktree, re-pointed: its admin directory from the shared clone into the thread's registry under the
 * name ws-add.sh gives it (the repository's), `gitdir` naming /workspace, and the worktree's `.git` naming /clones. Returns
 * why it was left out, or undefined when it is done.
 */
function repoint(p, o, repo) {
  const dotGit = path.join(p.workspace, repo, '.git');
  if (!existsSync(dotGit)) return 'its worktree is not in the fork';
  if (!statSync(dotGit).isFile()) return 'its .git is not a worktree pointer';
  const target = path.join(p.wt, repo, repo);
  const want = `gitdir: ${IN.clones}/${repo}/.git/worktrees/${repo}`;
  const now = readFileSync(dotGit, 'utf8').trim();
  if (now === want && existsSync(target)) return undefined; // done by an earlier run
  const prefix = `gitdir: ${o.clonesHost.replace(/\/+$/, '')}/${repo}/.git/worktrees/`;
  if (!now.startsWith(prefix)) return `its .git names ${now.slice(8)}`;
  const name = now.slice(prefix.length);
  if (!name || name.includes('/') || name === '.' || name === '..') return `its .git names ${now.slice(8)}`;
  const admin = path.join(p.clones, repo, '.git', 'worktrees', name);
  if (!existsSync(admin)) {
    if (!existsSync(target)) return `no admin directory ${name} in the clone`;
  } else {
    const back = readFileSync(path.join(admin, 'gitdir'), 'utf8').trim();
    if (back !== path.join(o.forkHost, repo, '.git')) return `the clone's ${name} belongs to ${back}`;
    rmSync(target, { recursive: true, force: true }); // half of an earlier run
    mkdirSync(path.dirname(target), { recursive: true });
    move(admin, target);
  }
  writeFileSync(path.join(target, 'gitdir'), `${IN.workspace}/${repo}/.git\n`);
  writeFileSync(dotGit, `${want}\n`);
  return undefined;
}

/**
 * The migration, on paths `p` (IN in a helper container; a fixture in tests). `o`: the fork's and the clones' paths on the
 * host, the harness, the session id to resume (or none) and the name of the thread's CODEX_HOME.
 */
export function migrate(p, o) {
  const fork = JSON.parse(readFileSync(path.join(p.workspace, '.fork.json'), 'utf8'));
  const repos = fork.repos && typeof fork.repos === 'object' ? fork.repos : {};
  const rewrite = (t) => rewritePaths(t, o.forkHost, o.clonesHost);

  let claude = false;
  const project = projectDir(p.claudeProjects, o.forkHost);
  if (o.harness !== 'codex' && o.sdkSessionId && !(project && existsSync(path.join(project, `${o.sdkSessionId}.jsonl`))))
    throw new Error(`no transcript ${o.sdkSessionId}.jsonl for ${o.forkHost}`);
  if (project) {
    copyRewritten(project, path.join(p.home, '.claude', 'projects', claudeSlug(IN.workspace)), rewrite);
    claude = true;
  }

  let codex = false;
  const codexSrc = path.join(p.codex, o.codexName);
  if (existsSync(codexSrc)) {
    mkdirSync(path.join(p.home, '.calvin', 'codex'), { recursive: true, mode: 0o700 });
    cpSync(codexSrc, path.join(p.home, '.calvin', 'codex', o.codexName), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    codex = true;
  } else if (o.harness === 'codex' && o.sdkSessionId) throw new Error(`no Codex home ${o.codexName} for ${o.forkHost}`);

  const kept = {};
  const skipped = [];
  for (const [repo, info] of Object.entries(repos)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) || repo === '.git') {
      skipped.push({ repo, why: 'not a repository name' });
      continue;
    }
    const why = repoint(p, o, repo);
    if (why) skipped.push({ repo, why });
    else kept[repo] = info;
  }
  return { repos: kept, claude, codex, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [forkHost, clonesHost, harness, sdk, codexName] = process.argv.slice(2);
  if (!forkHost || !clonesHost || !harness || !sdk || !codexName) {
    console.error('usage: legacy-migrate.mjs <fork> <clones> <harness> <sdkSessionId|-> <codex name>');
    process.exit(2);
  }
  try {
    const out = migrate(IN, { forkHost, clonesHost, harness, sdkSessionId: sdk === '-' ? undefined : sdk, codexName });
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    console.error(`legacy-migrate: ${e?.message ?? e}`);
    process.exit(1);
  }
}
