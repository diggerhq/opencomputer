#!/bin/sh
# ws-clone.sh <clones> <repo> <url> <filter> <branch> <setup>…
#
# Clone <url> as <clones>/<repo> (cloneRepo in src/workspaces/clones.ts): into
# <repo>.cloning, renamed when complete, so a clone that exists is whole. Then
# each <setup> command through `sh -c` in the clone, stopping at the first
# that fails. <filter> (`blob:none` for a partial clone) and <branch> may be
# empty. A clone already there is left as it is and its setup is not run again.
#
# Prints `<repo> ok cloned` or `<repo> ok present`; `<repo> failed <message>`
# when the clone or a setup command failed (after a failed setup the clone stays).
set -eu
. "$(dirname "$0")/ws-lib.sh"
[ $# -ge 5 ] || { echo "usage: ws-clone.sh <clones> <repo> <url> <filter> <branch> <setup>…" >&2; exit 2; }
clones=$1 repo=$2 url=$3 filter=$4 branch=$5
shift 5
clone=$clones/$repo
tmp=$clone.cloning

if [ -e "$clone/.git" ]; then
  ws_ok "$repo" present
  exit 0
fi
if [ -e "$clone" ] && ! rmdir -- "$clone" 2>/dev/null; then
  ws_failed "$repo" "$clone exists and is not a clone"
  exit 0
fi
ws_cleanup() { rm -rf -- "$tmp"; }
rm -rf -- "$tmp"
mkdir -p -- "$clones"
if ! ws_in "$clones" git clone --quiet ${filter:+"--filter=$filter"} ${branch:+-b "$branch"} "$url" "$tmp" >/dev/null; then
  ws_failed "$repo" "$(ws_why "Command failed: git clone --quiet $url $tmp")"
  exit 0
fi
mv -- "$tmp" "$clone"
ws_cleanup() { :; }
for cmd in "$@"; do
  if ! ws_in "$clone" sh -c "$cmd" >/dev/null; then
    ws_failed "$repo" "setup \`$cmd\`: $(ws_why "Command failed: sh -c $cmd")"
    exit 0
  fi
done
ws_ok "$repo" cloned
