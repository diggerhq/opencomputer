// boot.env (work 103, C4): what a start may change for a runner in a
// container, written by the host before every start and sourced by the image's
// entrypoint (deploy/image/sp-session-init). `podman start` cannot change a
// container's environment, and a resumed runner needs a new RUNNER_SPEC and
// possibly a new release.
//
// Invariants:
// - One `NAME='value'` per line, in the order of BOOT_ENV after SP_ROOT and
//   RUNNER_SPEC; a name whose value is empty is left out.
// - No credential (the invariant of runner-env.ts stands), and no name in
//   HOST_ONLY: those are host paths, loader settings, or owned by the image
//   or by Create.
// - Every name in RUNNER_ENV is in exactly one of BOOT_ENV and HOST_ONLY.

import type { RunnerSpec } from '../../protocol.js';

/** The runner variables a start passes on, in the file's order. */
export const BOOT_ENV = [
  'SP_VERSION', 'SP_COMMITTER_NAME', 'SP_COMMITTER_EMAIL', 'SP_FAKE_SLACK', 'SP_SLACK_API_URL', 'MODEL', 'FOLD_AT', 'PERMISSION_MODE',
  'SP_REGION', 'SP_SUBSTRATE', 'SP_PROMPT_CACHE_TTL', 'SP_CONTEXT_WINDOW', 'SP_COMPACT_AT', 'SP_PROMPT_GUARD', 'SP_CODEX_PEER_CHECK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
] as const;

/** Never written: the value is a host path, a loader setting, or owned by the image or the Create command. */
export const HOST_ONLY = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'SP_RUN', 'SP_DATA', 'SP_DEFINITION', 'SP_REAL_GH', 'SP_REAL_OPENCOMPUTER',
  'SP_MODEL_SOCKET', 'SP_CODEX_BIN', 'SP_PREVIEW_SOCKET', 'DISABLE_AUTOUPDATER', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'WORKDIR',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV',
] as const;

/** A value for a POSIX shell's `.`: single-quoted, `'` written as `'\''`. */
const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

export interface BootVars {
  /** The release the runner starts from: the host's own. */
  root: string;
  spec: RunnerSpec;
  /** `runnerVars(env)` (runner-env.ts). */
  vars: Record<string, string>;
}

/** The file's text. */
export function bootEnv(b: BootVars): string {
  const out: [string, string][] = [['SP_ROOT', b.root], ['RUNNER_SPEC', JSON.stringify(b.spec)]];
  for (const k of BOOT_ENV) if (b.vars[k]) out.push([k, b.vars[k]]);
  return out.map(([k, v]) => `${k}=${quote(v)}\n`).join('');
}
