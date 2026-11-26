#!/bin/sh
# ws-add.sh <clones> <workspace> <branch> <fetch 0/1> [<repo[=base]>…]
#
# Give the workspace a git worktree of each repository, <workspace>/<repo>, on
# <branch> (forkRepo in src/workspaces/fork.ts; a thread's container, work 103):
# the branch if the clone has it, else a new one from origin/<base>, not
# tracking it (the session pushes its own branch). <base> is the branch forks
# start from; not given, origin/HEAD (ws-lib.sh). With <fetch> 1, origin/<base>
# is fetched, for at most 5 s; a fetch that fails or runs out of time is
# reported and the worktree is made from what the clone has.
#
# A new branch whose origin/<base> the clone already has does not wait for the
# fetch: the worktree is checked out from that commit while the fetch runs, then
# moved to what the fetch brought, if anything (`reset --keep`, which writes
# only the files that changed). The checkout, CPU-bound on a large repository,
# and the fetch, bound by the network, then cost the longer of the two rather
# than their sum. The result is the same worktree as fetching first; one whose
# catch-up failed is removed, with the branch this run made. Both steps want
# CPU (on 2 or 4 CPUs, 11 repositories took as long overlapped, and longer when
# there was something to catch up), so this is done only when the idle CPUs
# (CPUs less the 1-minute load) are at least one per repository; WS_ADD_OVERLAP
# 1 or 0 decides instead.
#
# The repositories are worked on at the same time, each on its own clone; the
# lines come out in the order of the arguments.
#
# A destination that is already this clone's worktree is left as it is; one
# that is anything else is an error and is not touched. A worktree that could
# not be made completely is removed, with the branch this run made for it.
#
# Stdin, when it is not empty, is a tar stream of files for the workspace's
# root (.fork.json, AGENTS.md): unpacked last, over what is there. With no
# repository that is all the script does.
#
# Prints `<repo> ok <branch> <base> <HEAD> <fetch error> <fetch ms> <checkout ms>
# <catch-up ms> <overlapped 0/1>` (the fetch error empty unless a fetch failed;
# a step not taken is 0 ms), or `<repo> failed <message>`. The last four are the
# only fields a second run may answer differently.
set -eu
. "$(dirname "$0")/ws-lib.sh"
[ $# -ge 4 ] || { echo "usage: ws-add.sh <clones> <workspace> <branch> <fetch 0/1> [<repo[=base]>…]" >&2; exit 2; }
clones=$1 workspace=$2 branch=$3 fetch=$4
shift 4
FETCH_SECONDS=5
# Before anything else could read it.
cat >"$ws_tmp/root.tar"

overlap=${WS_ADD_OVERLAP:-}
if [ "$fetch" = 1 ] && [ -z "$overlap" ]; then
  cpus=$(nproc 2>/dev/null) || cpus=1
  load=$(cut -d . -f 1 /proc/loadavg 2>/dev/null) || load=$cpus
  [ $((cpus - ${load:-$cpus})) -ge $# ] && overlap=1 || overlap=0
fi

adding=
made=
fetching=
add_cleanup() {
  if [ -n "$fetching" ]; then
    # `$!` until fetch_pid is set: a signal may come between the two.
    kill "${fetch_pid:-$!}" 2>/dev/null || :
    wait "${fetch_pid:-$!}" 2>/dev/null || :
  fi
  [ -n "$adding" ] || return 0
  rm -rf -- "$adding"
  (cd "$clone" && git worktree prune) >/dev/null 2>&1 || :
  # A branch this run made, which a next run would otherwise take as the session's.
  [ -z "$made" ] || (cd "$clone" && git branch -D "$made") >/dev/null 2>&1 || :
}

# fetch_start: fetch origin/$base in the background, with its own stderr; its
# status and time end up in $ws_tmp/fetch.rc for fetch_wait. Stopped, it stops
# its fetch (timeout passes the signal on to git).
fetch_start() {
  fetching=1
  fetch_pid=
  (
    t=$(ws_ms)
    p=
    trap '[ -z "$p" ] || kill "$p" 2>/dev/null; exit 143' TERM INT HUP
    cd "$clone" || exit 1
    timeout "$FETCH_SECONDS" git fetch --quiet --no-tags origin "$base" >/dev/null 2>"$ws_tmp/fetch.err" </dev/null &
    p=$!
    rc=0
    wait "$p" || rc=$?
    echo "$rc $(($(ws_ms) - t))" >"$ws_tmp/fetch.rc"
  ) &
  fetch_pid=$!
}

# fetch_wait: wait for fetch_start's fetch; sets fetch_error and fetch_ms.
fetch_wait() {
  wait "$fetch_pid" 2>/dev/null || :
  fetching=
  read -r rc fetch_ms 2>/dev/null <"$ws_tmp/fetch.rc" || { rc=1 fetch_ms=0; }
  fetch_result "$rc" "$ws_tmp/fetch.err"
}

# fetch_result <status> <stderr file>: sets fetch_error.
fetch_result() {
  if [ "$1" = 124 ]; then fetch_error='timed out'
  elif [ "$1" != 0 ]; then fetch_error=$(ws_why "Command failed: git fetch --quiet --no-tags origin $base" "$2"); fi
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
  fetch_ms=0 checkout_ms=0 catchup_ms=0
  from=
  if [ ! -e "$dest" ]; then
    # A worktree whose directory the session deleted is still registered; forget it so it can be added again.
    ws_q "$clone" git worktree prune >/dev/null || { ws_failed "$repo" "$(ws_why 'Command failed: git worktree prune')"; return 0; }
    if [ "$fetch" = 1 ] && [ "$overlap" = 1 ] && ! ws_q "$clone" git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
      from=$(ws_q "$clone" git rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}") || from=
    fi
  fi
  if [ -n "$from" ]; then
    fetch_start
  elif [ "$fetch" = 1 ]; then
    t=$(ws_ms)
    rc=0
    ws_in "$clone" timeout "$FETCH_SECONDS" git fetch --quiet --no-tags origin "$base" >/dev/null || rc=$?
    fetch_ms=$(($(ws_ms) - t))
    fetch_result "$rc" "$ws_tmp/err"
  fi
  if [ ! -e "$dest" ]; then
    adding=$dest
    t=$(ws_ms)
    # On a partial clone this downloads the checkout's file contents.
    if [ -n "$from" ]; then
      made=$branch
      ws_in "$clone" git worktree add --quiet --no-track -b "$branch" "$dest" "$from" >/dev/null && added=1 || added=0
    elif ws_q "$clone" git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
      ws_in "$clone" git worktree add --quiet "$dest" "$branch" >/dev/null && added=1 || added=0
    else
      made=$branch
      ws_in "$clone" git worktree add --quiet --no-track -b "$branch" "$dest" "origin/$base" >/dev/null && added=1 || added=0
    fi
    checkout_ms=$(($(ws_ms) - t))
    if [ "$added" = 0 ]; then
      why=$(ws_why "Command failed: git worktree add --quiet $dest")
      add_cleanup
      adding= made=
      ws_failed "$repo" "$why"
      return 0
    fi
    if [ -n "$from" ]; then
      fetch_wait
      to=$(ws_q "$clone" git rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}") || to=$from
      if [ -z "$fetch_error" ] && [ "$to" != "$from" ]; then
        t=$(ws_ms)
        if ! ws_in "$dest" git reset --quiet --keep "$to" >/dev/null; then
          why=$(ws_why "Command failed: git reset --quiet --keep origin/$base")
          add_cleanup
          adding= made=
          ws_failed "$repo" "$why"
          return 0
        fi
        catchup_ms=$(($(ws_ms) - t))
      fi
    fi
    adding= made=
  elif ! is_worktree_of "$dest" "$clone"; then
    ws_failed "$repo" "./$(basename "$dest") exists but is not a worktree of this workspace's $repo; move it away and check out again"
    return 0
  fi
  head=$(ws_q "$dest" git rev-parse HEAD) || { ws_failed "$repo" "$(ws_why 'Command failed: git rev-parse HEAD')"; return 0; }
  ws_ok "$repo" "$branch" "$base" "$head" "$fetch_error" "$fetch_ms" "$checkout_ms" "$catchup_ms" "$([ -n "$from" ] && echo 1 || echo 0)"
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
