import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * A GitHub installation token the computer holds and when GitHub stops
 * honouring it. `expiresAt` is what GitHub returned when the token was
 * minted, an ISO timestamp about an hour out.
 */
export interface GitHubCredential {
  token: string;
  expiresAt: string;
}

/**
 * How much earlier than the command's allowed duration a token must still be
 * valid. Covers clock skew between the computer and GitHub and the moment
 * between the refresh decision and the command's first authenticated call.
 */
export const GITHUB_CREDENTIAL_REFRESH_MARGIN_SECONDS = 60;

/**
 * Whether a token expiring at `expiresAt` outlives a command allowed
 * `timeoutSeconds`, with the margin. A token whose expiry cannot be read is
 * treated as expired so a malformed timestamp forces a refresh rather than
 * an authenticated call that fails halfway through a push.
 */
export function gitHubCredentialCovers(
  credential: GitHubCredential,
  timeoutSeconds: number,
  now: number,
  marginSeconds = GITHUB_CREDENTIAL_REFRESH_MARGIN_SECONDS,
): boolean {
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - now > (timeoutSeconds + marginSeconds) * 1_000;
}

/**
 * The variables a command receives so `gh`, and anything else that reads the
 * conventional names, uses the token the computer currently holds.
 */
function gitHubTokenVariables(credential: GitHubCredential): Record<string, string> {
  return { GH_TOKEN: credential.token, GITHUB_TOKEN: credential.token };
}

/**
 * The computer's GitHub credential: the token file the Git credential helper
 * reads and the variables `gh` reads, refreshed before a command is
 * dispatched when the token would expire within the command's allowed
 * duration.
 *
 * Git and `gh` get the token by different routes, so a refresh has to reach
 * both. Git asks the `GIT_ASKPASS` helper at the moment it authenticates; the
 * helper reads a file, so rewriting the file refreshes every `git` process on
 * the computer, including ones not spawned by the dispatch. `gh` reads
 * `GH_TOKEN` from its own environment at start, so the dispatch spreads the
 * variables this returns into the command's environment.
 */
export class GitHubCredentialHolder {
  readonly #directory: string;
  readonly #refresh: () => Promise<GitHubCredential | null>;
  readonly #now: () => number;
  readonly #marginSeconds: number;
  readonly #log: (line: string) => void;
  #credential: GitHubCredential | null = null;
  #refreshing: Promise<void> | null = null;

  constructor(options: {
    /** Where the token file and the askpass helper live; runtime-owned, outside the workspace. */
    directory: string;
    /** Mints a fresh token through the edge; `null` when the session has no GitHub connection any more. */
    refresh: () => Promise<GitHubCredential | null>;
    now?: () => number;
    marginSeconds?: number;
    log?: (line: string) => void;
  }) {
    this.#directory = options.directory;
    this.#refresh = options.refresh;
    this.#now = options.now ?? Date.now;
    this.#marginSeconds =
      options.marginSeconds ?? GITHUB_CREDENTIAL_REFRESH_MARGIN_SECONDS;
    this.#log = options.log ?? (() => undefined);
  }

  /** The credential currently held, without its token. */
  get expiresAt(): string | null {
    return this.#credential?.expiresAt ?? null;
  }

  get tokenFile(): string {
    return resolve(this.#directory, "github-token");
  }

  get askPassFile(): string {
    return resolve(this.#directory, "github-askpass.sh");
  }

  /**
   * Places the credential minted when the computer was initialized: the
   * token file and the askpass helper that reads it. Returns the variables
   * every process on the computer needs so Git uses the helper; the token
   * variables themselves come from `environmentForCommand` at dispatch.
   * With `null` the computer holds no GitHub credential and nothing is
   * written.
   */
  async install(credential: GitHubCredential | null): Promise<Record<string, string>> {
    this.#credential = credential;
    if (!credential) return {};
    await mkdir(this.#directory, { recursive: true });
    await this.#writeTokenFile(credential.token);
    await writeFile(
      this.askPassFile,
      `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) cat ${shellQuote(this.tokenFile)} ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
    return {
      ...gitHubTokenVariables(credential),
      GIT_ASKPASS: this.askPassFile,
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  /**
   * The seam a command dispatch calls with the command's allowed duration.
   * Refreshes the token when it would expire within that duration plus the
   * margin, rewrites the token file for Git, and returns the variables the
   * command must receive for `gh`. Returns `{}` when the computer holds no
   * GitHub credential.
   *
   * A refresh that fails keeps the current token: it is what the command
   * would have used anyway, and GitHub, not this computer, decides whether
   * it still works. The failure is logged so a push that then fails can be
   * read back to its cause.
   */
  async environmentForCommand(timeoutSeconds: number): Promise<Record<string, string>> {
    const held = this.#credential;
    if (!held) return {};
    if (!gitHubCredentialCovers(held, timeoutSeconds, this.#now(), this.#marginSeconds)) {
      this.#refreshing ??= this.#refreshOnce().finally(() => {
        this.#refreshing = null;
      });
      await this.#refreshing;
    }
    return this.#credential ? gitHubTokenVariables(this.#credential) : {};
  }

  async #refreshOnce(): Promise<void> {
    const previous = this.#credential;
    try {
      const fresh = await this.#refresh();
      if (!fresh) {
        this.#log(
          "managed-agent supervisor: the session no longer has a GitHub connection; the held token is kept until it expires",
        );
        return;
      }
      await this.#writeTokenFile(fresh.token);
      this.#credential = fresh;
      this.#log(
        `managed-agent supervisor: GitHub installation token refreshed; the previous one expired at ${previous?.expiresAt ?? "unknown"}, the new one expires at ${fresh.expiresAt}`,
      );
    } catch (error) {
      this.#log(
        `managed-agent supervisor: GitHub installation token refresh failed (${error instanceof Error ? error.message : String(error)}); the held token expiring at ${previous?.expiresAt ?? "unknown"} is kept`,
      );
    }
  }

  /**
   * The file is replaced by rename so a `git` process reading it mid-refresh
   * sees the whole old token or the whole new one, never a partial write.
   */
  async #writeTokenFile(token: string): Promise<void> {
    const staging = `${this.tokenFile}.${String(process.pid)}.tmp`;
    await writeFile(staging, `${token}\n`, { mode: 0o600 });
    await rename(staging, this.tokenFile);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
