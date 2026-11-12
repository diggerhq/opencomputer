#!/bin/sh
# ws-inspect.sh [--only=state|ignored] <clones> <workspace> <worktree>…
#
# What the host asks of a workspace's worktrees before it removes anything
# (pruneFork in src/workspaces/prune.ts, pruneArtifacts in idle.ts). Each
# <worktree> is a path below <workspace>: a repository's name, or `.wt/<name>`
# for one an agent added. Read-only: nothing here writes to a worktree, not
# even its index (--no-optional-locks: a refreshed index would look like use).
#
# state:   whether it has uncommitted changes (`dirty`, also when git cannot
#          say), the number of commits on no remote (-1: cannot count; not
#          counted, `-`, when dirty), its branch (empty when detached) and its
#          clone's git directory as git names it.
# ignored: of the directories named on stdin, one `<worktree><TAB><path below
#          it>` per line, the ones git ignores (tracked files are never ignored).
#
# Prints `<worktree> ok <dirty|clean> <unpushed> <branch> <git dir> <ignored path>…`;
# with --only=ignored the four state fields are `-`, with --only=state stdin is not read.
set -eu
. "$(dirname "$0")/ws-lib.sh"
only=
case ${1:-} in --only=*) only=${1#--only=}; shift ;; esac
[ $# -ge 2 ] || { echo "usage: ws-inspect.sh [--only=state|ignored] <clones> <workspace> <worktree>…" >&2; exit 2; }
workspace=$2
shift 2
if [ "$only" = state ]; then : >"$ws_tmp/dirs"; else cat >"$ws_tmp/dirs"; fi

for repo in "$@"; do
  wt=$workspace/$repo
  state=- unpushed=- branch=- common=-
  if [ "$only" != ignored ]; then
    state=dirty
    if changes=$(ws_q "$wt" git --no-optional-locks status --porcelain) && [ -z "$changes" ]; then
      state=clean
      unpushed=$(ws_q "$wt" git rev-list --count HEAD --not --remotes) || unpushed=-1
    fi
    branch=$(ws_q "$wt" git symbolic-ref --quiet --short HEAD) || branch=
    common=$(ws_q "$wt" git rev-parse --git-common-dir) || common=
  fi
  set -- "$state" "$unpushed" "$branch" "$common"
  while IFS=$ws_tab read -r r rel; do
    [ "$r" = "$repo" ] && [ -n "$rel" ] || continue
    # check-ignore exits 0 only for an ignored path.
    if ws_q "$wt" git check-ignore -q "$rel"; then set -- "$@" "$rel"; fi
  done <"$ws_tmp/dirs"
  ws_ok "$repo" "$@"
done
