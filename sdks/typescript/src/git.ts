import { Commands, type ProcessResult } from "./commands";

export interface RepoInfo {
  id: string;
  name: string;
  slug: string;
  cloneUrl?: string;
  description: string;
  defaultBranch: string;
  createdAt: string;
}

export interface GitInitOpts {
  /** Repository name (defaults to sandbox ID). */
  name?: string;
  /** Default branch name (defaults to "main"). */
  defaultBranch?: string;
}

export interface GitPushOpts {
  /** Commit message (defaults to "update"). */
  message?: string;
  /** Branch to push (defaults to current branch). */
  branch?: string;
}

export interface GitCloneOpts {
  /** Target directory (defaults to "/workspace"). */
  path?: string;
  /** Branch to check out after cloning. */
  branch?: string;
}

export class Git {
  private credentialsInjected = false;
  private repoSlug: string | null = null;

  constructor(
    private apiUrl: string,
    private apiKey: string,
    private sandboxId: string,
    private token: string,
    private commands: Commands,
    private gitDomain: string,
    private orgSlug: string,
  ) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      h["X-API-Key"] = this.apiKey;
    }
    return h;
  }

  /**
   * Inject git credentials into the sandbox so git push/pull/clone
   * works transparently against the OpenSandbox git server.
   */
  private async ensureCredentials(): Promise<void> {
    if (this.credentialsInjected) return;
    // Write .netrc for the git server domain (host without port for .netrc)
    const host = this.gitDomain.replace(/:\d+$/, "");
    const netrc = `machine ${host}\\nlogin ${this.apiKey}\\npassword x`;
    await this.commands.run(
      `printf "${netrc}\\n" > ~/.netrc && chmod 600 ~/.netrc`,
      { timeout: 10 },
    );
    // Configure git defaults
    await this.commands.run(
      'git config --global init.defaultBranch main && git config --global user.email "sandbox@opensandbox.ai" && git config --global user.name "OpenSandbox"',
      { timeout: 10 },
    );
    this.credentialsInjected = true;
  }

  /** Build the clone URL for a repo on the OpenSandbox git server. */
  private remoteUrl(repoSlug: string): string {
    return `http://${this.gitDomain}/${this.orgSlug}/${repoSlug}.git`;
  }

  /**
   * Initialize a git repo in /workspace and create the backing repository
   * on the git server. After this, push/pull will work.
   */
  async init(opts: GitInitOpts = {}): Promise<RepoInfo> {
    await this.ensureCredentials();

    const name = opts.name ?? this.sandboxId;
    const defaultBranch = opts.defaultBranch ?? "main";

    // Create repo on the server via control plane API
    const resp = await fetch(`${this.apiUrl}/repos`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ name, description: `Created from sandbox ${this.sandboxId}` }),
    });

    if (!resp.ok && resp.status !== 409) {
      const text = await resp.text();
      throw new Error(`Failed to create repository: ${resp.status} ${text}`);
    }

    const repo: RepoInfo = resp.status === 409
      ? { id: "", name, slug: name.toLowerCase().replace(/\s+/g, "-"), description: "", defaultBranch, createdAt: "" }
      : await resp.json();

    this.repoSlug = repo.slug;

    // Initialize git in workspace and set remote
    const url = this.remoteUrl(repo.slug);
    await this.commands.run(
      `cd /workspace && git init -b ${defaultBranch} && git remote add origin ${url}`,
      { timeout: 15 },
    );

    return repo;
  }

  /**
   * Stage all changes, commit, and push to the remote repository.
   */
  async push(opts: GitPushOpts = {}): Promise<ProcessResult> {
    await this.ensureCredentials();
    const message = opts.message ?? "update";
    const branchArg = opts.branch ? `origin ${opts.branch}` : "--all";

    return this.commands.run(
      `cd /workspace && git add -A && git commit -m "${message}" --allow-empty && git push -u ${branchArg}`,
      { timeout: 120 },
    );
  }

  /**
   * Pull latest changes from the remote repository.
   */
  async pull(): Promise<ProcessResult> {
    await this.ensureCredentials();
    return this.commands.run("cd /workspace && git pull", { timeout: 60 });
  }

  /**
   * Clone a repository into the sandbox.
   * Accepts a repo name (from OpenSandbox git server) or any git URL.
   */
  async clone(repo: string, opts: GitCloneOpts = {}): Promise<ProcessResult> {
    await this.ensureCredentials();

    const path = opts.path ?? "/workspace";
    const url = repo.includes("://") || repo.includes("@")
      ? repo
      : this.remoteUrl(repo);

    const branchArg = opts.branch ? `-b ${opts.branch}` : "";
    this.repoSlug = repo.includes("://") ? null : repo;

    return this.commands.run(
      `git clone ${branchArg} ${url} ${path}`.trim(),
      { timeout: 120 },
    );
  }

  /**
   * Get the current git status of /workspace.
   */
  async status(): Promise<ProcessResult> {
    return this.commands.run("cd /workspace && git status", { timeout: 10 });
  }

  /**
   * Get the git log of /workspace.
   */
  async log(maxCount: number = 10): Promise<ProcessResult> {
    return this.commands.run(
      `cd /workspace && git log --oneline -n ${maxCount}`,
      { timeout: 10 },
    );
  }

  /**
   * Get the current diff of /workspace.
   */
  async diff(): Promise<ProcessResult> {
    return this.commands.run("cd /workspace && git diff", { timeout: 10 });
  }

  /**
   * Create and checkout a new branch.
   */
  async branch(name: string): Promise<ProcessResult> {
    return this.commands.run(
      `cd /workspace && git checkout -b ${name}`,
      { timeout: 10 },
    );
  }

  /**
   * Checkout an existing branch.
   */
  async checkout(name: string): Promise<ProcessResult> {
    return this.commands.run(
      `cd /workspace && git checkout ${name}`,
      { timeout: 10 },
    );
  }
}
