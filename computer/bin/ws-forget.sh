#!/bin/sh
# ws-forget.sh <clones> <branch> <repo>…
#
# Delete <branch> from each clone <clones>/<repo>, merged or not (pruneFork in
# src/workspaces/prune.ts, once the branch's worktree is gone). A clone that
# has no such branch is `ok`: there is nothing left to forget.
#
# Prints `<repo> ok` or `<repo> failed <message>`.
set -eu
. "$(dirname "$0")/ws-lib.sh"
[ $# -ge 2 ] || { echo "usage: ws-forget.sh <clones> <branch> <repo>…" >&2; exit 2; }
clones=$1 branch=$2
shift 2
for repo in "$@"; do
  clone=$clones/$repo
  if ! ws_q "$clone" git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && [ -d "$clone" ]; then
    ws_ok "$repo"
  elif ws_q "$clone" git branch -D "$branch" >/dev/null; then
    ws_ok "$repo"
  else
    ws_failed "$repo" "$(ws_why "Command failed: git branch -D $branch")"
  fi
done
