#!/usr/bin/env bash
# The release bundle: HEAD of this checkout as a git bundle whose only ref is
# main, with the oc-modelproxy binary CI built committed on top of HEAD as
# modelproxy/oc-modelproxy (work 077). Computers never compile the proxy: they
# install that file from the release (deploy/vm/modelproxy.sh). One artifact
# per release, so every path that fetches a bundle (deploy/update.sh,
# azure-computer-boot.sh, self-update.sh) carries the binary without knowing.
#
#   deploy/bundle.sh <out.bundle> <oc-modelproxy>    prints the release commit
#
# The release commit is HEAD plus one file, so its sha (the release's version,
# what `releases/<sha>` and calvin-latest.version say) is not on main; its
# message names the main commit it was made from. The binary is content-
# addressed by git, so a bundle that fetches is a bundle whose binary is intact.
set -euo pipefail
out="${1:?usage: bundle.sh <out.bundle> <oc-modelproxy>}"
bin="${2:?usage: bundle.sh <out.bundle> <oc-modelproxy>}"
[[ -r $bin ]] || { echo "no binary at $bin" >&2; exit 1; }
cd "$(dirname "$0")/.."
out="$(realpath -m "$out")"; bin="$(realpath "$bin")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
git init -q --bare "$repo"
git -C "$repo" fetch -q "$PWD" "+HEAD:refs/heads/main"
base="$(git -C "$repo" rev-parse refs/heads/main)"
blob="$(git -C "$repo" hash-object -w "$bin")"
export GIT_INDEX_FILE="$tmp/index"
git -C "$repo" read-tree refs/heads/main
git -C "$repo" update-index --add --cacheinfo "100755,$blob,modelproxy/oc-modelproxy"
tree="$(git -C "$repo" write-tree)"
unset GIT_INDEX_FILE
commit="$(git -C "$repo" -c user.name=calvin-deploy -c user.email=deploy@calvin.invalid \
  commit-tree "$tree" -p "$base" -m "release: $base with oc-modelproxy built by CI")"
git -C "$repo" update-ref refs/heads/main "$commit"
git -C "$repo" bundle create -q "$out" refs/heads/main
echo "$commit"
