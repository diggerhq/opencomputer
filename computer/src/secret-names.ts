// Which names a secret may have (work 046). Shared by the gateway, which
// refuses bad names when a person sets one, and the runner, which drops any
// that slip through before they reach a session's environment.

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Names that would change how the session itself runs (shell, Claude Code, git, the runner, interpreters) or where its traffic goes (proxies, CA bundles); any case. */
const RESERVED =
  /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|LANG|TERM|TMPDIR|IFS|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|RUNNER_SPEC|PS[1-4]|PROMPT_COMMAND|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|(HTTPS?|ALL|NO|FTP)_PROXY)$|^(SP_|CLAUDE|ANTHROPIC_|GIT_|LD_|DYLD_|BASH_FUNC)/i;

/** Names that change where tools fetch code or send traffic: package indexes, Java and pager hooks, config dirs. Same list as managed-agents'. */
const REDIRECTING =
  /^(LESSOPEN|LESSCLOSE|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|UV_INDEX_URL|GOPROXY|DOCKER_HOST)$|^(XDG_|NPM_CONFIG_)/i;
/**
 * Base URLs: a secret `OPENAI_BASE_URL` would send the session's real key to whoever set it,
 * unseen. Only as a variable, whose value everyone can see (and, at session scope, only the
 * session's owner may set: variables-ui.ts).
 */
const BASE_URL = /(_BASE_URL|_API_BASE)$/i;

/** True for a name that points a tool's traffic somewhere (`*_BASE_URL`, `*_API_BASE`). */
export const isBaseUrlName = (name: string) => BASE_URL.test(name);

/** Why `name` cannot be a secret's (or, with `variable`, a variable's) name, or undefined when it can. */
export function secretNameProblem(name: string, opts: { variable?: boolean } = {}): string | undefined {
  if (!NAME.test(name)) return 'use letters, digits and _, not starting with a digit (at most 64)';
  if (RESERVED.test(name) || REDIRECTING.test(name)) return `\`${name}\` is reserved: it would change how the session itself runs`;
  if (!opts.variable && BASE_URL.test(name)) return `\`${name}\` is a base URL: set it as a variable (\`!var\`), so everyone can see where it points`;
}
