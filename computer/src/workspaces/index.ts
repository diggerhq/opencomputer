// Workspaces and housekeeping on a host (work 045, item S4). Other items
// import personRoot, ensureWorkspace, forkSession, startHousekeeping and
// fetchRepo; the rest is exported for the host agent and the dev check.
//
// <SP_DATA>/people/<dir>/
//   ws/AGENTS.md, ws/<repo>/    clones from the workspace definition. Sessions never edit them:
//                               they are each repository's object store and fetch target.
//   sessions/<key>/             a session's fork: AGENTS.md, .fork.json, and one git worktree per
//                               repository on branch sp/<key>, from origin/<default>: fetched at fork
//                               time unless already fresh (fetch-schedule.ts).
//
// The definition is the gateway's if it sent one, else the JSON file named by
// SP_DEFINITION (definitions/computer.json); see definition.ts.
// No session waits on a clone (work 056): a fork gets the clones that exist,
// eager repositories are cloned in the background, lazy ones (partially) when
// a session checks them out with checkoutRepos, and the fork's AGENTS.md
// lists everything the definition grants (repo-index.ts).
// Remotes are plain HTTPS; git authenticates through the credential helper configured
// globally on the host (bin/git-credential-slack-presence), never through tokens in
// remotes. Worktree operations on one clone are serialized, and so are its
// fetches, in a separate lane (fetch-schedule.ts); at most HOUSEKEEPING_FETCHES
// housekeeping fetches run at once on the host.
//
// Split by concept (work 103): clones.ts (layout, git, locks, cloning),
// fork.ts (a session's fork), housekeep.ts (the periodic pass and fetches
// after a push), prune.ts (idle forks). This file is what others import.
// The git sequences themselves are the scripts bin/ws-*.sh (script-runner.ts).

export * from './definition.js';
export { configureAsRunner, mkdir as mkdirAsRunner } from './as-runner.js';
export {
  ensureWorkspace, type FetchTrigger, forkDir, observeWorkspaces, personRoot, prepareInBackground, safeKey, workspaceDir, type WorkspaceObserver,
  workspacePrepared,
} from './clones.js';
export { checkoutRepos, type ForkInfo, forkInfo, forkSession, touchFork } from './fork.js';
export { fetchRepo, housekeep, markPushed, oldestFetchAgeS, startHousekeeping } from './housekeep.js';
export { pruneFork } from './prune.js';
