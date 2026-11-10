// Which commit this process is running. `npm start` is plain tsx (no watch:
// agents edit this repo while turns run, and a reload would kill them), so a
// fix committed after boot isn't live until a restart. Footers and !status say
// so instead of letting old code pass for new.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

// `import.meta.dirname`, not `import.meta.url`: the runner bundle rewrites only
// the former to the source directory (scripts/bundle-runner.mjs), so the url
// would point into dist/ and reach the root by depth alone.
const root = path.dirname(import.meta.dirname);
const head = () => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};

// Deployed processes (gateway image, VM releases) carry their version in SP_VERSION
// and have no usable checkout; releases replace the stale-checkout check there.
const deployed = process.env.SP_VERSION;
export const bootCommit = deployed ?? head();
let checked = { at: 0, now: bootCommit };

/** `restart to load 1a2b3c4` once the checkout has moved past the running commit. */
export function staleNote(): string | undefined {
  if (deployed) return undefined;
  if (Date.now() - checked.at > 10_000) checked = { at: Date.now(), now: head() };
  return bootCommit && checked.now && checked.now !== bootCommit ? `running ${bootCommit} · restart to load ${checked.now}` : undefined;
}

/**
 * The release a newly started runner would get, on a host with versioned
 * releases (`<root>/releases/<sha>`, newest behind `<root>/current`); else undefined.
 */
export function latestRelease(): string | undefined {
  if (path.basename(path.dirname(root)) !== 'releases') return undefined;
  try {
    return path.basename(realpathSync(path.join(root, '..', '..', 'current')));
  } catch {
    return undefined;
  }
}
