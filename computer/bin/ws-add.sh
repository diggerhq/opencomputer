#!/bin/sh
# ws-add.sh <clones> <workspace> <branch> <fetch 0/1> [<repo[=base]>…]
#
# Give the workspace a git worktree of each repository, <workspace>/<repo>, on
# <branch> (forkRepo in src/workspaces/fork.ts; a thread's container, work 103):
# the branch if the clone has it, else a new one from origin/<base>, not
# tracking it (the session pushes its own branch). <base> is the branch forks
# start from; not given, origin/HEAD (ws-lib.sh). With <fetch> 1, origin/<base>
# is fetched first, for at most 5 s; a fetch that fails or runs out of time is
# reported and the worktree is made from what the clone has.
#
# The repositories are worked on at the same time, each on its own clone; the
# lines come out in the order of the arguments.
#
# A destination that is already this clone's worktree is left as it is; one
# that is anything else is an error and is not touched. A worktree that could
# not be made completely is removed.
#
# Stdin, when it is not empty, is a tar stream of files for the workspace's
# root (.fork.json, AGENTS.md): unpacked last, over what is there. With no
# repository that is all the script does.
#
# Prints `<repo> ok <branch> <base> <HEAD> <fetch error>` (the last field empty
# unless a fetch failed), or `<repo> failed <message>`.
set -eu
. "$(dirname "$0")/ws-lib.sh"
[ $# -ge 4 ] || { echo "usage: ws-add.sh <clones> <workspace> <branch> <fetch 0/1> [<repo[=base]>…]" >&2; exit 2; }
clones=$1 workspace=$2 branch=$3 fetch=$4
shift 4
FETCH_SECONDS=5
# Before anything else could read it.
cat >"$ws_tmp/root.tar"

adding=
add_cleanup() {
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
    rc=0
    ws_in "$clone" timeout "$FETCH_SECONDS" git fetch --quiet --no-tags origin "$base" >/dev/null || rc=$?
    if [ "$rc" = 124 ]; then fetch_error='timed out'
    elif [ "$rc" != 0 ]; then fetch_error=$(ws_why "Command failed: git fetch --quiet --no-tags origin $base"); fi
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
      add_cleanup
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

# Each repository in its own subshell, with its own stderr file and its own
# half-made worktree to remove when stopped; a stopped script stops them all.
jobs=
ws_cleanup() {
  [ -n "$jobs" ] || return 0
  # shellcheck disable=SC2086
  kill $jobs 2>/dev/null || :
  wait
}
n=0
for r in "$@"; do
  n=$((n + 1))
  (
    ws_tmp=$ws_tmp/$n
    mkdir "$ws_tmp"
    ws_cleanup() { add_cleanup; }
    trap ws_stop TERM INT HUP
    add "$r"
  ) >"$ws_tmp/out.$n" &
  jobs="$jobs $!"
done
i=0
for j in $jobs; do
  i=$((i + 1))
  wait "$j" || :
  cat "$ws_tmp/out.$i"
done
jobs=

if [ -s "$ws_tmp/root.tar" ]; then
  tar -x -f "$ws_tmp/root.tar" -C "$workspace" --no-same-owner --no-same-permissions || exit 1
fi
