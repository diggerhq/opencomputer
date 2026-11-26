// The workspace definition (definitions/computer.json): which repositories a
// person's workspace holds and how each is cloned. The gateway sends it to a
// host in its `welcome`; protocol.ts re-exports everything here, and it is part of
// the same contract (the backend's copy of the protocol mirrors it).

/** One repository of a workspace definition. */
export interface WorkspaceRepo {
  /** Directory name in the workspace. */
  name: string;
  /** HTTPS clone URL, no credentials. */
  remote: string;
  /** Default branch; otherwise origin/HEAD. */
  branch?: string;
  /** Shell commands run once in the clone after cloning. */
  setup?: string[];
  /** Listed but not cloned (the remote doesn't exist yet). */
  unpublished?: boolean;
  /**
   * `eager` (the default): cloned in the background when the workspace is
   * prepared and kept fetched. `lazy`: cloned (partially, blobs on demand) only
   * when a session checks it out. No session ever waits on an eager clone.
   */
  clone?: 'eager' | 'lazy';
  /**
   * `knowledge`: the organization's knowledge repository (work tracking, at
   * most one per definition). Always cloned eagerly whatever `clone` says; the
   * host installs its git hooks in the clone (knowledge-hooks.ts) and names it
   * in each fork's AGENTS.md (knowledge.ts).
   */
  role?: 'knowledge';
  /** For the repository index in a fork's AGENTS.md: GitHub's description, main language, last push (ISO). */
  description?: string;
  language?: string;
  pushedAt?: string;
}

/**
 * A workspace definition: the shape of definitions/computer.json. On disk
 * (SP_DEFINITION) rootFiles sources are relative to the file; from the gateway
 * they are relative to the release's definitions/ directory.
 */
export interface WorkspaceDefinition {
  name?: string;
  about?: string;
  repos: WorkspaceRepo[];
  /** Target path in the workspace root → source file. */
  rootFiles?: Record<string, string>;
}
