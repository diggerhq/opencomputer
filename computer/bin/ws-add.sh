#!/bin/sh
# ws-add.sh <clones> <workspace> <branch> <fetch 0/1> <repo[=base]>…
#
# Give the workspace a git worktree of each repository, <workspace>/<repo>, on
# <branch> (forkRepo in src/workspaces/fork.ts): the branch if the clone has
# it, else a new one from origin/<base>, not tracking it (the session pushes
# its own branch). <base> is the branch forks start from; not given, origin/HEAD
# (ws-lib.sh). With <fetch> 1, origin/<base> is fetched first; a fetch that
# fails is reported and the worktree is made from what the clone has.
#
# A destination that is already this clone's worktree is left as it is; one
# that is anything else is an error and is not touched. A worktree that could
# not be made completely is removed.
#
# Prints `<repo> ok <branch> <base> <HEAD> <fetch error>` (the last field empty
# unless a fetch failed), or `<repo> failed <message>`.
set -eu
. "$(dirname "$0")/ws-lib.sh"
[ $# -ge 4 ] || { echo "usage: ws-add.sh <clones> <workspace> <branch> <fetch 0/1> <repo[=base]>…" >&2; exit 2; }
clones=$1 workspace=$2 branch=$3 fetch=$4
shift 4

adding=
ws_cleanup() {
  [ -n "$adding" ] || return 0
  rm -rf -- "$adding"
  (cd "$clone" && git worktree prune) >/dev/null 2>&1 || :
}

# True when <dir> is a worktree of the clone: both name the same git directory.
is_worktree_of() {
  common=$(ws_q "$1" git rev-parse --git-common-dir) || return 1
  [ -n "$common" ] || return 1
  a=$(cd "$1" && cd "$common" && pwd -P) || return 1
  b2=$(cd "$2/.git" && pwd -P) || return 1
  [ "$a" = "$b2" ]
}

add() {
  repo=${1%%=*}
  base=
  case $1 in *=*) base=${1#*=} ;; esac
  clone=$clones/$repo
  dest=$workspace/$repo
  if [ -z "$base" ]; then
    ws_base "$clone" || { ws_failed "$repo" "$(ws_why 'no default branch')"; return 0; }
    base=$ws_b
  fi
  fetch_error=
  if [ "$fetch" = 1 ]; then
    ws_in "$clone" git fetch --quiet --no-tags origin "$base" >/dev/null ||
      fetch_error=$(ws_why "Command failed: git fetch --quiet --no-tags origin $base")
  fi
  if [ ! -e "$dest" ]; then
    # A worktree whose directory the session deleted is still registered; forget it so it can be added again.
    ws_q "$clone" git worktree prune >/dev/null || { ws_failed "$repo" "$(ws_why 'Command failed: git worktree prune')"; return 0; }
    adding=$dest
    # On a partial clone this downloads the checkout's file contents.
    if ws_q "$clone" git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
      ws_in "$clone" git worktree add --quiet "$dest" "$branch" >/dev/null && added=1 || added=0
    else
      ws_in "$clone" git worktree add --quiet --no-track -b "$branch" "$dest" "origin/$base" >/dev/null && added=1 || added=0
    fi
    if [ "$added" = 0 ]; then
      why=$(ws_why "Command failed: git worktree add --quiet $dest")
      ws_cleanup
      adding=
      ws_failed "$repo" "$why"
      return 0
    fi
    adding=
  elif ! is_worktree_of "$dest" "$clone"; then
    ws_failed "$repo" "./$(basename "$dest") exists but is not a worktree of this workspace's $repo; move it away and check out again"
    return 0
  fi
  head=$(ws_q "$dest" git rev-parse HEAD) || { ws_failed "$repo" "$(ws_why 'Command failed: git rev-parse HEAD')"; return 0; }
  ws_ok "$repo" "$branch" "$base" "$head" "$fetch_error"
}

for r in "$@"; do add "$r"; done
