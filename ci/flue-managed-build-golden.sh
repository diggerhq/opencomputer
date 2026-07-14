#!/usr/bin/env bash
set -euo pipefail

# Cross-repository contract fixture for `oc agent build`.
#
# The default coordinate is intentionally immutable. To review a fixture
# update before changing this pin, run for example:
#   STARTER_REF=<commit> ./ci/flue-managed-build-golden.sh
STARTER_REPO="${STARTER_REPO:-https://github.com/diggerhq/oc-flue-starter.git}"
STARTER_REF="${STARTER_REF:-5c51d7edbbf2472fbe48386c4f9b192279330c9b}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NODE_VERSION="$(node -p 'process.versions.node')"
if [[ ! "$NODE_VERSION" =~ ^22\.19\. ]]; then
  echo "managed-build golden requires Node 22.19.x (found $NODE_VERSION)" >&2
  exit 1
fi

echo "Building current oc source"
CGO_ENABLED=0 go build \
  -ldflags "-s -w -X github.com/opensandbox/opensandbox/cmd/oc/internal/commands.Version=ci-golden" \
  -o "$TMP/oc" \
  "$ROOT/cmd/oc"

echo "Checking out managed-build fixture $STARTER_REPO@$STARTER_REF"
git init -q "$TMP/starter"
git -C "$TMP/starter" remote add origin "$STARTER_REPO"
git -C "$TMP/starter" fetch -q --depth=1 origin "$STARTER_REF"
git -C "$TMP/starter" checkout -q --detach FETCH_HEAD
test "$(git -C "$TMP/starter" rev-parse HEAD)" = "$STARTER_REF"

(
  cd "$TMP/starter"
  npm ci --no-audit --no-fund
  OC_BIN="$TMP/oc" npm run test:fixtures
)
