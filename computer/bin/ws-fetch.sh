#!/bin/sh
# ws-fetch.sh <clones> <repo> <ref>…
#
# Fetch these refs of origin into <clones>/<repo>, and nothing else: no tags,
# no prune, as fast as a fetch gets (forkFetch in src/workspaces/fork.ts, which
# asks for the branch a fork starts from). With no <ref>, what the remote's
# refspec names.
#
# Prints `<repo> ok` or `<repo> failed <message>`.
set -eu
. "$(dirname "$0")/ws-lib.sh"
[ $# -ge 2 ] || { echo "usage: ws-fetch.sh <clones> <repo> <ref>…" >&2; exit 2; }
clones=$1 repo=$2
shift 2
if ws_in "$clones/$repo" git fetch --quiet --no-tags origin "$@" >/dev/null; then
  ws_ok "$repo"
else
  ws_failed "$repo" "$(ws_why "Command failed: git fetch --quiet --no-tags origin $*")"
fi
