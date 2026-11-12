// What a `podman` host refuses for a session in a container until the step
// that builds it lands (work 103, "Build order"). Each of these still acts on
// the host today: a preview probes and proxies the host's ports, and a
// terminal and `/files` run as the runners' user in the host's file tree.
// None of that is the session's container, and a terminal on the host is
// outside the sandbox altogether.
//
// Invariant: every such feature asks here, and only here, before it does
// anything for a sandboxed session. The step that makes a feature work in the
// container deletes its entry and its call:
// - `preview`, `terminal`, `files`: step 9.

const WHAT = {
  preview: 'A preview is',
  terminal: 'A terminal is',
  files: 'Workspace files are',
} as const;

export type NotYet = keyof typeof WHAT;

/** The one-line refusal of `what` for a session that runs in a container; undefined for one that does not. */
export const notYet = (what: NotYet, sandboxed: boolean): string | undefined =>
  sandboxed ? `${WHAT[what]} not available yet for a session that runs in a container.` : undefined;
