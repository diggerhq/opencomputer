#!/usr/bin/env bash
# Which session image a release may run (work 103): the one this repository's
# default branch built for a tree of deploy/image, named by digest.
#
#   image-pin.sh <tree> [<git ref>]    prints ghcr.io/diggerhq/computer-session@sha256:<digest>,
#                                      or fails and prints nothing
#
# <tree> is `git rev-parse <commit>:computer/deploy/image`. The release
# pipeline runs this for the commit it releases and writes the line into the
# release as deploy/image.pin; a computer pulls exactly that digest
# (deploy/vm/sandbox.sh). No image, or one that fails a check below, means no
# pin and so no release. <git ref> defaults to refs/heads/main; another ref
# names the test image that ref's push built (the tag branch-<tree>), and is
# how computer-image.yml checks a branch's own build.
#
# Why not the tag: a tag proves nothing. Every workflow run of this
# repository, on any branch, holds a token that can push any tag of the
# package, and the workflow file is not part of the tree, so a branch can
# publish anything under the tag of a clean tree. What a branch cannot make is
# GitHub's provenance attestation saying "computer-image.yml, running on
# refs/heads/main, built this digest": it is signed with the run's own
# identity. The checks, in order:
#   1. the tag (<tree> on main, branch-<tree> elsewhere) names a digest in the registry;
#   2. that digest has an attestation from .github/workflows/computer-image.yml
#      of this repository, run on <git ref>, on a GitHub-hosted runner;
#   3. the commit that run built has <tree> at computer/deploy/image (an older
#      image of main pushed again under this tree's tag fails here).
#
# Needs curl, jq and gh with a token (GH_TOKEN) that can read this public
# repository. The package is public: the registry is read without credentials.
set -euo pipefail

REPOSITORY=ghcr.io/diggerhq/computer-session
SOURCE=diggerhq/opencomputer
WORKFLOW=.github/workflows/computer-image.yml
CONTEXT=computer/deploy/image
MAIN=refs/heads/main

die() { echo "image-pin: $*" >&2; exit 1; }

tree="${1:-}" ref="${2:-$MAIN}"
[[ $tree =~ ^[0-9a-f]{40}$ ]] || { echo "usage: image-pin.sh <tree of $CONTEXT> [<git ref>]" >&2; exit 2; }
tag="$tree"
[[ $ref == "$MAIN" ]] || tag="branch-$tree"

registry="${REPOSITORY%%/*}" name="${REPOSITORY#*/}"
token="$(curl -fsS -m 30 --retry 3 "https://$registry/token?scope=repository:$name:pull" | jq -r .token)" \
  || die "no pull token from $registry"
accept='application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'
digest="$(curl -fsS -m 30 --retry 3 -I -H @<(printf 'Authorization: Bearer %s\nAccept: %s\n' "$token" "$accept") \
  "https://$registry/v2/$name/manifests/$tag" | tr -d '\r' | sed -n 's/^docker-content-digest: *//Ip')" \
  || die "$REPOSITORY:$tag is not in the registry (has $WORKFLOW run on $ref for this tree?)"
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || die "the registry gave no digest for $REPOSITORY:$tag"

attested="$(gh attestation verify "oci://$REPOSITORY@$digest" --repo "$SOURCE" --source-ref "$ref" \
  --signer-workflow "$SOURCE/$WORKFLOW" --deny-self-hosted-runners --format json)" \
  || die "$REPOSITORY:$tag is $digest, which $WORKFLOW did not build on $ref: no release may run it"

while read -r commit; do
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || continue
  built="$(gh api "repos/$SOURCE/contents/${CONTEXT%/*}?ref=$commit" --jq ".[] | select(.name == \"${CONTEXT##*/}\") | .sha")" \
    || die "could not read $CONTEXT of $SOURCE at $commit"
  if [[ $built == "$tree" ]]; then
    echo "$REPOSITORY@$digest"
    exit 0
  fi
done < <(jq -r '.[].verificationResult.signature.certificate.sourceRepositoryDigest' <<<"$attested")
die "$REPOSITORY:$tag is $digest, built on $ref from another tree than $tree"
