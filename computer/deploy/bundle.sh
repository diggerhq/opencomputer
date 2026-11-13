#!/usr/bin/env bash
# The release bundle: this checkout's committed computer/ tree as a git bundle
# whose only ref is main, with oc-modelproxy built from it and committed as
# modelproxy/oc-modelproxy. Computers never compile the proxy: they install
# that file from the release (deploy/vm/modelproxy.sh). One artifact per
# release, so every path that fetches a bundle (azure-computer-boot.sh,
# self-update.sh) carries the binary without knowing.
#
#   deploy/bundle.sh <out.bundle>    prints the release commit
#
# The bundle's root is computer/, not the repository's, since a computer runs
# deploy/vm/provision.sh from the root of what it fetches. Its one commit has
# no parent, a fixed author and HEAD's date, so one HEAD gives one release
# commit; the message names HEAD, and the proxy reports HEAD as its version.
# Built from HEAD, not the working tree: uncommitted changes are not shipped.
# The binary is for linux/amd64 (the computers' VMs).
set -euo pipefail
out="${1:?usage: bundle.sh <out.bundle>}"
cd "$(dirname "$0")/.."
out="$(realpath -m "$out")"
head="$(git rev-parse HEAD)"
date="$(git log -1 --format=%ct HEAD)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
tree="$tmp/tree"
mkdir "$tree"
git archive HEAD | tar -x -C "$tree"   # in a subdirectory: that directory, as the root

(cd "$tree/modelproxy" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -buildvcs=false -ldflags "-X main.version=$head" -o oc-modelproxy .)

export GIT_AUTHOR_NAME=opencomputer-release GIT_AUTHOR_EMAIL=release@opencomputer.invalid
export GIT_COMMITTER_NAME=opencomputer-release GIT_COMMITTER_EMAIL=release@opencomputer.invalid
export GIT_AUTHOR_DATE="@$date +0000" GIT_COMMITTER_DATE="@$date +0000"
git -C "$tree" init -q -b main
git -C "$tree" -c core.autocrlf=false -c core.fileMode=true add -A -f .
git -C "$tree" -c commit.gpgsign=false commit -q \
  -m "release: computer/ at $head, with oc-modelproxy built from it"
git -C "$tree" bundle create -q "$out" refs/heads/main
git -C "$tree" rev-parse HEAD
