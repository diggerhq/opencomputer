// The variables a runner gets from the host, and how a runner reads them
// (host/launch.ts sets them; runner/clean-env.ts reads them first).
//
// A runner started with systemd-run --user also inherits the user manager's
// environment, which any session can change (`systemctl --user
// set-environment`, ~/.config/environment.d) for every runner after it. So
// the host sets every variable here on every launch, from its own
// environment: one it lacks is set empty, and a runner treats empty as unset
// (it deletes them before anything reads them). No session can choose
// another runner's model socket, Codex binary or PATH.
//
// Invariants:
// - every name in RUNNER_ENV is in every launch's variables, empty or not;
// - no credential is among them (those go over the runner's socket);
// - SP_CODEX_PEER_CHECK is `off` only when the host itself runs with `off`,
//   else `on`: a session can never turn the check off for a runner.

export const RUNNER_ENV = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'SP_RUN', 'SP_DATA', 'SP_DEFINITION', 'SP_VERSION',
  'SP_COMMITTER_NAME', 'SP_COMMITTER_EMAIL', 'SP_REAL_GH', 'SP_REAL_OPENCOMPUTER', 'SP_FAKE_SLACK', 'SP_SLACK_API_URL', 'MODEL', 'FOLD_AT', 'WORKDIR',
  'PERMISSION_MODE', 'DISABLE_AUTOUPDATER', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'SP_REGION', 'SP_SUBSTRATE',
  'SP_PROMPT_CACHE_TTL', 'SP_CONTEXT_WINDOW', 'SP_COMPACT_AT', 'SP_PROMPT_GUARD', 'SP_MODEL_SOCKET', 'SP_CODEX_BIN', 'SP_CODEX_PEER_CHECK',
  // Unset on a computer's host, but inherited each would run a session's code in, or route the traffic of,
  // another session's runner. The host's own value when it has one (a laptop's proxy).
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
] as const;

/** The Codex CLI a runner launches (provision.sh installs it there): SP_CODEX_BIN, else the provisioned path. */
export function codexBin(env: NodeJS.ProcessEnv): string {
  return env.SP_CODEX_BIN || '/usr/local/lib/codex/bin/codex';
}

/** Every RUNNER_ENV variable, from the host's environment: absent ones empty, the peer check `on` unless the host's is `off`. */
export function runnerVars(env: NodeJS.ProcessEnv): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const k of RUNNER_ENV) vars[k] = env[k] ?? '';
  vars.SP_CODEX_PEER_CHECK = env.SP_CODEX_PEER_CHECK === 'off' ? 'off' : 'on';
  return vars;
}

/** A runner's side: RUNNER_ENV variables set empty are unset. */
export function dropEmpty(env: NodeJS.ProcessEnv) {
  for (const k of RUNNER_ENV) if (env[k] === '') delete env[k];
}
