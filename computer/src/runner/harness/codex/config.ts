// Where a session's Codex keeps its state, what it is configured with, and
// the environment it runs in (work 082, contract sections 1 and 5). Codex
// reaches the model only through Calvin's loopback (loopback.ts) as a custom
// provider in API-key mode, with a placeholder the proxy replaces.
//
// Invariants:
// - one CODEX_HOME per session, named by a hash of its key, mode 0700, under
//   a root the runner's user owns (its HOME: runner/main.ts): its threads
//   survive a runner restart, and no session reads another's;
// - HOME stays the runner user's own (git, gh and the shell read it); only
//   CODEX_HOME points into the session's directory (a contract deviation:
//   section 5 named HOME);
// - no auth.json is ever written;
// - the child's environment is an allow-list (CHILD_ENV): what launch.ts
//   passes a runner that commands need, and what Calvin's bin/ shims read.
//   No credential, no runner-internal socket (SP_TOKEN_SOCKET,
//   SP_MODEL_SOCKET) and nothing that would change Codex's auth or endpoint
//   (`OPENAI_*`, `CODEX_*`) reaches Codex or the commands it runs;
// - the placeholder never reaches commands Codex runs (shell policy excludes
//   it);
// - every string in config.toml is a TOML basic string written as JSON,
//   which TOML reads the same, except DEL (escaped here).

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** What Codex sends as its key; the proxy replaces it (as for Claude, work 077). */
export const PLACEHOLDER = 'ssh-placeholder';
/** The variable Codex reads its provider key (the placeholder) from. */
export const KEY_VAR = 'CALVIN_MODEL_KEY';
export const PROVIDER = 'calvin';

/**
 * The runner's variables a Codex child inherits. The first line is host/launch.ts's
 * PASS_ENV that a command needs (and the locale and terminal, when set); then the
 * git identity runner/main.ts sets; then what bin/ reads: gh's and opencomputer's
 * real binaries, the token socket's directory (git-credential-slack-presence), and
 * the files socket (calvin-send-file). SP_SESSION_KEY and the git author come with
 * the session's secrets (BASH_ENV), as for Claude.
 */
export const CHILD_ENV = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'TMPDIR',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'SP_REAL_GH', 'SP_REAL_OPENCOMPUTER', 'SP_RUN', 'SP_FILES_SOCKET',
];

export { codexHome } from '../../../codex-home.js';

const str = (s: string) => JSON.stringify(s).replace(/\x7f/g, '\\u007f');

export interface CodexConfig {
  model: string;
  /** The loopback's port. */
  port: number;
  /** The session's fork, trusted as a project. */
  cwd: string;
}

/**
 * config.toml for a session. Commands Codex runs see the environment Claude
 * Code's Bash does (`ignore_default_excludes`: Codex would otherwise drop
 * every *KEY*, *TOKEN* and *SECRET* variable, the session's own secrets
 * included), minus the placeholder; the runner's credentials never reach them, as
 * spawnEnv leaves them out of Codex's own environment. Login shells stay allowed
 * (Codex's default), as Claude Code's Bash sources the profile too.
 * `supports_websockets`: Codex keeps one Responses WebSocket per session,
 * warms it at thread start and sends each request as only its new input;
 * oc-modelproxy tunnels it (modelproxy/websocket.go), and when it answers 426
 * Codex goes on over HTTP.
 */
export function configToml(c: CodexConfig) {
  return `# Written by Calvin for one session; rewritten at every start.
model = ${str(c.model)}
model_provider = ${str(PROVIDER)}
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.${PROVIDER}]
name = "Calvin"
base_url = ${str(`http://127.0.0.1:${c.port}/v1`)}
env_key = ${str(KEY_VAR)}
wire_api = "responses"
supports_websockets = true

[projects.${str(c.cwd)}]
trust_level = "trusted"

[shell_environment_policy]
inherit = "all"
ignore_default_excludes = true
exclude = [${str(KEY_VAR)}]

[history]
persistence = "none"
`;
}

/** Make `home` (0700) with `toml` as its config.toml (0600), and no auth.json. */
export function writeHome(home: string, toml: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  rmSync(path.join(home, 'auth.json'), { force: true });
  writeFileSync(path.join(home, 'config.toml'), toml, { mode: 0o600 });
}

/**
 * The child's environment: CHILD_ENV from this runner's, with its home, the
 * placeholder, Codex's log level, and the session's secrets sourced before each
 * command Codex runs through bash (as CLAUDE_ENV_FILE does for Claude).
 */
export function spawnEnv(base: NodeJS.ProcessEnv, o: { home: string; envFile?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV) if (base[k] !== undefined) env[k] = base[k];
  env.CODEX_HOME = o.home;
  env[KEY_VAR] = PLACEHOLDER;
  env.RUST_LOG = 'warn';
  if (o.envFile) env.BASH_ENV = o.envFile;
  return env;
}
