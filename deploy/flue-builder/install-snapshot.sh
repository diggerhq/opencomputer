#!/usr/bin/env bash
set -euo pipefail

# This script is embedded into the image manifest by snapshot.py. Keep every
# downloaded input immutable and verified: the resulting checkpoint is trusted
# to execute arbitrary repository lifecycle code without receiving credentials.

SNAPSHOT_NAME="flue-build-node22-19-0-oc-c39b315-r3"
BASE_IMAGE="base"
OS_ID="ubuntu"
OS_VERSION_ID="22.04"
ARCHITECTURE="x86_64"

NODE_VERSION="22.19.0"
NODE_ARCHIVE_SHA256="c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
NPM_VERSION="10.9.3"

GO_VERSION="1.25.0"
GO_ARCHIVE_SHA256="2852af0cb20a13139b3448992e69b868e50ed0f8a1e5940ee1de9e19a123b613"
GO_URL="https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"

OC_SOURCE_COMMIT="c39b31560cb78e0d5708a9eda4cfb30ec372eed9"
OC_SOURCE_ARCHIVE_SHA256="5aaa929e33c54474bfca774c78d6f422168cb0bf24f4ea445b3b0c1bd2a2840e"
OC_SOURCE_URL="https://github.com/diggerhq/opencomputer/archive/${OC_SOURCE_COMMIT}.tar.gz"
OC_BINARY_SHA256="7f7286095aefe78c3027efb79465442070370c6dcf3cda67c9b1315949a42bc1"
OC_VERSION="oc@${OC_SOURCE_COMMIT}"

NODE_ROOT="/opt/opencomputer/node-v${NODE_VERSION}"
OC_BIN="/opt/opencomputer/bin/oc"
ATTESTATION="/opt/opencomputer/agent-build-snapshot.json"

die() {
  echo "flue builder snapshot: $*" >&2
  exit 1
}

require_root() {
  [[ "$(id -u)" == "0" ]] || die "this operation must run as root"
}

assert_platform() {
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "$OS_ID" ]] || die "expected OS $OS_ID, found ${ID:-unknown}"
  [[ "${VERSION_ID:-}" == "$OS_VERSION_ID" ]] || die "expected OS version $OS_VERSION_ID, found ${VERSION_ID:-unknown}"
  [[ "$(uname -m)" == "$ARCHITECTURE" ]] || die "expected architecture $ARCHITECTURE, found $(uname -m)"
}

download_verified() {
  local url="$1"
  local expected_sha="$2"
  local output="$3"

  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
    --retry 3 --retry-all-errors --output "$output" "$url"
  printf '%s  %s\n' "$expected_sha" "$output" | sha256sum --check --status \
    || die "digest mismatch for $url"
}

write_attestation() {
  local output="$1"
  mkdir -p "$(dirname "$output")"
  cat >"$output" <<EOF
{
  "schemaVersion": 1,
  "snapshotName": "$SNAPSHOT_NAME",
  "baseImage": "$BASE_IMAGE",
  "platform": {
    "osId": "$OS_ID",
    "osVersionId": "$OS_VERSION_ID",
    "architecture": "$ARCHITECTURE"
  },
  "node": {
    "version": "$NODE_VERSION",
    "archiveSha256": "$NODE_ARCHIVE_SHA256"
  },
  "npm": {
    "version": "$NPM_VERSION"
  },
  "oc": {
    "version": "$OC_VERSION",
    "sourceCommit": "$OC_SOURCE_COMMIT",
    "sourceArchiveSha256": "$OC_SOURCE_ARCHIVE_SHA256",
    "binarySha256": "$OC_BINARY_SHA256"
  },
  "buildToolchain": {
    "goVersion": "$GO_VERSION",
    "goArchiveSha256": "$GO_ARCHIVE_SHA256"
  }
}
EOF
}

install_node() {
  require_root
  assert_platform

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git iproute2 util-linux xz-utils

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  download_verified "$NODE_URL" "$NODE_ARCHIVE_SHA256" "$tmp/node.tar.xz"

  rm -rf "$NODE_ROOT"
  mkdir -p "$NODE_ROOT"
  tar -xJf "$tmp/node.tar.xz" --strip-components=1 -C "$NODE_ROOT"

  ln -sfn "$NODE_ROOT/bin/node" /usr/local/bin/node
  ln -sfn "$NODE_ROOT/bin/npm" /usr/local/bin/npm
  ln -sfn "$NODE_ROOT/bin/npx" /usr/local/bin/npx

  [[ "$(node --version)" == "v${NODE_VERSION}" ]] || die "installed Node version mismatch"
  [[ "$(npm --version)" == "$NPM_VERSION" ]] || die "installed npm version mismatch"

  rm -rf /var/lib/apt/lists/*
  trap - EXIT
  rm -rf "$tmp"
}

build_oc() {
  require_root
  assert_platform

  local tmp go_root source_root cache_root
  tmp="$(mktemp -d)"
  go_root="$tmp/go"
  source_root="$tmp/source"
  cache_root="$tmp/cache"
  trap 'rm -rf "$tmp"' EXIT

  download_verified "$GO_URL" "$GO_ARCHIVE_SHA256" "$tmp/go.tar.gz"
  mkdir -p "$go_root"
  tar -xzf "$tmp/go.tar.gz" --strip-components=1 -C "$go_root"
  [[ "$($go_root/bin/go version)" == "go version go${GO_VERSION} linux/amd64" ]] \
    || die "Go builder version mismatch"

  download_verified "$OC_SOURCE_URL" "$OC_SOURCE_ARCHIVE_SHA256" "$tmp/opencomputer.tar.gz"
  mkdir -p "$source_root"
  tar -xzf "$tmp/opencomputer.tar.gz" --strip-components=1 -C "$source_root"

  mkdir -p /opt/opencomputer/bin "$cache_root/mod" "$cache_root/build"
  (
    cd "$source_root"
    env \
      CGO_ENABLED=0 \
      GOARCH=amd64 \
      GOOS=linux \
      GOMODCACHE="$cache_root/mod" \
      GOCACHE="$cache_root/build" \
      GOTOOLCHAIN=local \
      "$go_root/bin/go" build \
        -trimpath \
        -buildvcs=false \
        -ldflags "-s -w -X github.com/opensandbox/opensandbox/cmd/oc/internal/commands.Version=${OC_SOURCE_COMMIT}" \
        -o "$OC_BIN" \
        ./cmd/oc
  )

  printf '%s  %s\n' "$OC_BINARY_SHA256" "$OC_BIN" | sha256sum --check --status \
    || die "built oc binary digest mismatch"
  chmod 0755 "$OC_BIN"

  trap - EXIT
  rm -rf "$tmp"
}

attest() {
  require_root
  write_attestation "$ATTESTATION"
  chmod 0644 "$ATTESTATION"
}

verify() {
  local expected_attestation
  assert_platform
  [[ "$(node --version)" == "v${NODE_VERSION}" ]] || die "Node verification failed"
  [[ "$(npm --version)" == "$NPM_VERSION" ]] || die "npm verification failed"
  printf '%s  %s\n' "$OC_BINARY_SHA256" "$OC_BIN" | sha256sum --check --status \
    || die "oc digest verification failed"
  [[ -f "$ATTESTATION" ]] || die "snapshot attestation is missing"
  expected_attestation="$(mktemp)"
  write_attestation "$expected_attestation"
  if ! cmp -s "$ATTESTATION" "$expected_attestation"; then
    rm -f "$expected_attestation"
    die "snapshot attestation does not match the installer contract"
  fi
  rm -f "$expected_attestation"
}

case "${1:-}" in
  coordinate)
    write_attestation /dev/stdout
    ;;
  node)
    install_node
    ;;
  oc)
    build_oc
    ;;
  attest)
    attest
    ;;
  verify)
    verify
    ;;
  *)
    die "usage: $0 {coordinate|node|oc|attest|verify}"
    ;;
esac
