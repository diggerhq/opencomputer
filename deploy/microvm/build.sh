#!/usr/bin/env bash
# Package the MicroVM image artifact and upload it to S3.
#
# Lambda MicroVMs takes a ZIP containing a Dockerfile plus its build context,
# NOT a prebuilt container image — Lambda runs the Dockerfile itself on its own
# build infrastructure. So this script only cross-compiles the two binaries,
# zips them next to the Dockerfile, and uploads.
#
# Creating or updating the image resource is a separate step (CreateMicrovmImage
# / UpdateMicrovmImage) so that packaging stays safe to re-run and cannot touch
# any image resource by accident.
#
#   ./deploy/microvm/build.sh s3://my-bucket/microvm/agent-image.zip
set -euo pipefail

DEST="${1:-}"
if [[ -z "$DEST" ]]; then
  echo "usage: $0 s3://bucket/key.zip" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Lambda MicroVMs is ARM-only: CreateMicrovmImage's cpu-configurations accepts
# exactly one architecture, ARM_64. An amd64 artifact fails the build before the
# Dockerfile ever runs, which surfaces as a bare CREATE_FAILED with no
# stateReason and no CloudWatch log group — so pin the arch here rather than
# inheriting the developer's laptop and rediscovering that the hard way.
export CGO_ENABLED=0 GOOS=linux GOARCH=arm64

echo "building osb-agent + microvm-hooks (${GOOS}/${GOARCH})…"
go build -o "$STAGE/osb-agent"      "$REPO_ROOT/cmd/agent"
go build -o "$STAGE/microvm-hooks"  "$REPO_ROOT/cmd/microvm-hooks"
cp "$REPO_ROOT/deploy/microvm/Dockerfile" "$STAGE/Dockerfile"

ZIP="$STAGE/artifact.zip"
( cd "$STAGE" && zip -q -r "$ZIP" Dockerfile osb-agent microvm-hooks )
echo "artifact: $(du -h "$ZIP" | cut -f1)"

echo "uploading → $DEST"
aws s3 cp "$ZIP" "$DEST"

cat <<EOF

uploaded. Now publish the image resource:

  ./deploy/microvm/publish.sh $DEST

publish.sh carries the hook declaration and ARM_64 config that this artifact
assumes; publishing by hand without them fails the build.
EOF
