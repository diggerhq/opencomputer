#!/usr/bin/env bash
# The tag of the gateway image built from a commit: src-<hash of the source
# trees selfhost/gateway/Dockerfile copies>. Commits that leave those trees
# alone share the tag, so the image CI pushed for the last change to them is
# the one every later commit pins (host-install.sh), whichever commit that is.
#
#   source-tag.sh [<commit>]    prints src-<40 hex>; <commit> defaults to HEAD
#
# .github/workflows/gateway-image.yml tags each image it pushes with this, and
# its path filters are these paths: keep the two lists in step.
set -euo pipefail

GATEWAY_SOURCE=(
  selfhost/gateway
  services/managed-agents
  cloudflare-workers/api-edge
  cloudflare-workers/shared
  web
  sdks/typescript/src/computer
)

commit="${1:-HEAD}" trees=""
cd "$(dirname "${BASH_SOURCE[0]}")"
for p in "${GATEWAY_SOURCE[@]}"; do
  tree="$(git -c safe.directory='*' rev-parse --verify -q "$commit:$p")" \
    || { echo "source-tag: no $p at $commit" >&2; exit 1; }
  trees+="$p $tree"$'\n'
done
hash="$(printf '%s' "$trees" | sha256sum)"
echo "src-${hash:0:40}"
