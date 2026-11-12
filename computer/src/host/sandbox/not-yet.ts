// What a `podman` host refuses for a session in a container until the step
// that builds it lands (work 103, "Build order"). What is listed here still
// acts on the host today: `checkout` adds worktrees by host paths, which is
// not the session's container.
//
// Invariant: every such feature asks here, and only here, before it does
// anything for a sandboxed session. The step that makes a feature work in the
// container deletes its entry and its call:
// - `checkout`: step 7 (workspaces in the container).
// (`preview`, `terminal` and `files` went with step 9: previews.ts,
// terminal.ts and workspace-files.ts reach the container.)

const WHAT = {
  checkout: 'Checking out a repository is',
} as const;

export type NotYet = keyof typeof WHAT;

/** The one-line refusal of `what` for a session that runs in a container; undefined for one that does not. */
export const notYet = (what: NotYet, sandboxed: boolean): string | undefined =>
  sandboxed ? `${WHAT[what]} not available yet for a session that runs in a container.` : undefined;
