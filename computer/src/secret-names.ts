// Which names a secret may have (work 046). Shared by the gateway, which
// refuses bad names when a person sets one, and the runner, which drops any
// that slip through before they reach a session's environment.

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Names that would change how the session itself runs (shell, Claude Code, git, the runner, interpreters) or where its traffic goes (proxies, CA bundles); any case. */
const RESERVED =
  /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|LANG|TERM|TMPDIR|IFS|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|RUNNER_SPEC|PS[1-4]|PROMPT_COMMAND|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|(HTTPS?|ALL|NO|FTP)_PROXY)$|^(SP_|CLAUDE|ANTHROPIC_|GIT_|LD_|DYLD_|BASH_FUNC)/i;

/** Why `name` cannot be a secret's name, or undefined when it can. */
export function secretNameProblem(name: string): string | undefined {
  if (!NAME.test(name)) return 'use letters, digits and _, not starting with a digit (at most 64)';
  if (RESERVED.test(name)) return `\`${name}\` is reserved: it would change how the session itself runs`;
}
