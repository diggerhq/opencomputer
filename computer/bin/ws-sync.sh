#!/bin/sh
# ws-sync.sh [--only=base|fetch|forward] <clones> <repo> [<base>]
#
# Keep the clone <clones>/<repo> current (syncRepo and fastForward in
# src/workspaces/housekeep.ts, defaultBranch in clones.ts): fetch origin with
# --prune, then fast-forward the clone's own checkout of <base>. <base> is the
# branch forks start from; empty or absent, origin/HEAD (asked of the remote
# when the clone does not know it).
#
# The checkout is only ever fast-forwarded: never when it is on another
# branch, has local changes or has diverged. A fetch that fails does not stop
# the fast-forward to what was fetched before.
#
# The host runs the steps apart, because each holds a different lock there:
#   --only=base     prints `<repo> ok <base>`
#   --only=fetch    prints `<repo> ok`
#   --only=forward  prints `<repo> ok <moved|current|kept> <origin/base, short> <why kept>`
# With no --only all run and the line is that of `forward`, its last field
# also naming a failed fetch (`fetch: …; …`). `<repo> failed <message>` when a
# step that was asked for alone failed, or the base is not known.
set -eu
. "$(dirname "$0")/ws-lib.sh"
only=
case ${1:-} in --only=*) only=${1#--only=}; shift ;; esac
[ $# -ge 2 ] || { echo "usage: ws-sync.sh [--only=base|fetch|forward] <clones> <repo> [<base>]" >&2; exit 2; }
clones=$1 repo=$2 b=${3:-}
clone=$clones/$repo

if [ -z "$b" ] && [ "$only" != fetch ]; then
  ws_base "$clone" || { ws_failed "$repo" "$(ws_why 'no default branch')"; exit 0; }
  b=$ws_b
fi
[ "$only" != base ] || { ws_ok "$repo" "$b"; exit 0; }

problem=
if [ "$only" != forward ]; then
  if ! ws_in "$clone" git fetch --quiet --prune origin >/dev/null; then
    why=$(ws_why 'Command failed: git fetch --quiet --prune origin')
    [ "$only" != fetch ] || { ws_failed "$repo" "$why"; exit 0; }
    problem="fetch: $why"
  fi
  [ "$only" != fetch ] || { ws_ok "$repo"; exit 0; }
fi

# Sets state (moved, current, kept) and, when kept, why.
forward() {
  why=
  state=kept
  cur=$(ws_q "$clone" git symbolic-ref --quiet --short HEAD) || cur=
  if [ "$cur" != "$b" ]; then
    why="checkout is on ${cur:-a detached HEAD}, not $b; not fast-forwarded"
    return 0
  fi
  changes=$(ws_q "$clone" git status --porcelain) || { why="fast-forward: $(ws_why 'Command failed: git status --porcelain')"; return 0; }
  if [ -n "$changes" ]; then
    why='checkout has local changes; not fast-forwarded'
    return 0
  fi
  head=$(ws_q "$clone" git rev-parse HEAD) || { why="fast-forward: $(ws_why 'Command failed: git rev-parse HEAD')"; return 0; }
  remote=$(ws_q "$clone" git rev-parse "origin/$b") || { why="fast-forward: $(ws_why "Command failed: git rev-parse origin/$b")"; return 0; }
  if [ "$head" = "$remote" ]; then
    state=current
    return 0
  fi
  if ! ws_q "$clone" git merge-base --is-ancestor "$head" "$remote"; then
    why="$b has diverged from origin/$b; not fast-forwarded"
    return 0
  fi
  # Downloads file contents on a partial clone, so it can take as long as a fetch.
  ws_in "$clone" git merge --ff-only --quiet "origin/$b" >/dev/null || {
    why="fast-forward: $(ws_why "Command failed: git merge --ff-only --quiet origin/$b")"
    return 0
  }
  state=moved
}
forward
short=$(ws_q "$clone" git rev-parse --short "origin/$b") || short=
[ -z "$why" ] || problem=${problem:+$problem; }$why
ws_ok "$repo" "$state" "$short" "$problem"
