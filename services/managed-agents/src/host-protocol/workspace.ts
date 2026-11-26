// The organization's workspace definition: the repositories a host clones.

/** One repository of a workspace definition (calvin `WorkspaceRepo`). */
export interface WorkspaceRepo {
  name: string;
  /** HTTPS clone URL, no credentials. */
  remote: string;
  branch?: string;
  /**
   * Calvin work 056: `lazy` is cloned only when a session checks it out
   * (`checkout_repo`); `eager` (the default) in the background. Older hosts
   * ignore it and the metadata below, which feeds the fork's repository index.
   */
  clone?: "eager" | "lazy";
  /**
   * Work tracking: the organization's knowledge repository, at most one per
   * definition. The host clones it eagerly, installs its git hooks (Session
   * trailer, unique item numbers) and names it in each fork's AGENTS.md. Older
   * hosts ignore it and treat it as any other eager repository.
   */
  role?: "knowledge";
  description?: string;
  language?: string;
  pushedAt?: string;
}

/**
 * The organization's workspace definition, sent in `welcome` (calvin
 * `WorkspaceDefinition`, the shape of definitions/opencomputer.json). The host
 * uses it instead of SP_DEFINITION; absent means "no change".
 */
export interface WorkspaceDefinition {
  name?: string;
  about?: string;
  repos: WorkspaceRepo[];
  /** Workspace-root path → source path relative to the release's definitions/ directory. */
  rootFiles?: Record<string, string>;
}
