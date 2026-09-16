#!/usr/bin/env bash
# Build the guest artifact once and publish EVERY image tier from it.
#
# The drift this prevents, in the shape it took: the guest gained /oc/secrets,
# /oc/envs and /oc/stats on 2026-09-01. Nothing rebuilt the published images, so
# the control plane called routes its own guests did not serve. A JSON POST to
# an unregistered path falls through to the agent's gRPC listener, which answers
# 415 with an empty body — so it surfaced as an unexplained "failed to start the
# sandbox" weeks later, to the first customer whose create carried a secret.
#
# The tier half is the same defect one level down: memory is a property of the
# image, so N sizes means N images, and republishing only the default leaves the
# rest behind.
#
# So: one build, every image in images.json, or nothing.
#
#   ./deploy/microvm/release.sh dev
#   ./deploy/microvm/release.sh prod
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$HERE/manifest.py"
ENVIRONMENT="${1:-}"
if [[ -z "$ENVIRONMENT" ]]; then
  echo "usage: $0 <environment>" >&2
  exit 2
fi

# The ownership guard lives in manifest.py and runs on every read, so an
# environment naming another product's runtime fails here, before any build.
read -r REGION BUCKET KEY <<<"$("$MANIFEST" config "$ENVIRONMENT")"
DEST="s3://${BUCKET}/${KEY}"
export AWS_REGION="$REGION"

echo "environment : $ENVIRONMENT"
echo "artifact    : $DEST"
echo
echo "=== memory tiers (publishing may change code, never size) ==="
"$MANIFEST" check-memory "$ENVIRONMENT"

# Stamped onto every image so drift is an exact comparison later, not a guess.
#
# Taken from the environment when the caller already computed it. The hash is
# derived from `go list -deps`, whose answer depends on the state of the module
# cache, so computing it twice in one run does not reliably give the same value
# twice: CI's drift check saw 733b02f8629c93d4 and this stamp said
# d8348d77e993a933, three seconds apart on one machine at one commit. The check
# then failed against the stamp it had just caused to be written, every run,
# forever. One value per run, computed once, passed down.
GUEST_HASH="${MICROVM_GUEST_HASH:-$("$MANIFEST" guest-hash "$ENVIRONMENT")}"
GIT_SHA="$(git -C "$HERE/../.." rev-parse --short HEAD 2>/dev/null || echo unknown)"
export MICROVM_IMAGE_DESCRIPTION="guest=${GUEST_HASH} git=${GIT_SHA}"
echo "stamp       : $MICROVM_IMAGE_DESCRIPTION"

echo
"$HERE/build.sh" "$DEST"

# Every image, from the one artifact just uploaded. set -e makes a failure here
# fatal: a half-published set is the drift this exists to prevent.
while read -r NAME MEM; do
  echo
  echo "=== publishing $NAME (${MEM}MiB) ==="
  MICROVM_IMAGE_NAME="$NAME" MICROVM_IMAGE_MEMORY_MB="$MEM" "$HERE/publish.sh" "$DEST"
done < <("$MANIFEST" images "$ENVIRONMENT")

echo
echo "=== published. Control-plane configuration for $ENVIRONMENT ==="
"$MANIFEST" cp-config "$ENVIRONMENT"
