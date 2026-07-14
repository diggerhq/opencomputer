#!/usr/bin/env bash
set -euo pipefail

# This script is embedded into the image manifest by snapshot.py. Keep every
# downloaded input immutable and verified: the resulting checkpoint is trusted
# to execute arbitrary repository lifecycle code without receiving credentials.

SNAPSHOT_NAME="flue-build-node22-19-0-oc-c39b315-r2"
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
RUNTIME_VERIFIER="/opt/opencomputer/bin/verify-flue-builder-runtime"
RUNTIME_USER="sandbox"
RUNTIME_UID="1000"
RUNTIME_GID="1000"
WORKSPACE="/workspace"

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
  },
  "security": {
    "runtimeUser": "$RUNTIME_USER",
    "runtimeUid": $RUNTIME_UID,
    "runtimeGid": $RUNTIME_GID,
    "supplementaryGroups": [],
    "sudoPolicy": "binary-removed",
    "agentControl": "host-only",
    "toolchainOwner": "root",
    "workspace": "$WORKSPACE",
    "workspaceWritable": true
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
  assert_platform
  [[ "$(node --version)" == "v${NODE_VERSION}" ]] || die "Node verification failed"
  [[ "$(npm --version)" == "$NPM_VERSION" ]] || die "npm verification failed"
  printf '%s  %s\n' "$OC_BINARY_SHA256" "$OC_BIN" | sha256sum --check --status \
    || die "oc digest verification failed"
  [[ -f "$ATTESTATION" ]] || die "snapshot attestation is missing"
  cmp -s "$ATTESTATION" <(write_attestation /dev/stdout) \
    || die "snapshot attestation does not match the installer contract"
}

write_runtime_verifier() {
  local output="$1"
  local attestation_sha="$2"
  cat >"$output" <<EOF
#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "flue builder runtime verification failed: \$*" >&2
  exit 1
}

# shellcheck disable=SC1091
source /etc/os-release
[[ "\${ID:-}" == "$OS_ID" ]] || fail "OS changed"
[[ "\${VERSION_ID:-}" == "$OS_VERSION_ID" ]] || fail "OS version changed"
[[ "\$(uname -m)" == "$ARCHITECTURE" ]] || fail "architecture changed"
[[ "\$(id -u)" == "$RUNTIME_UID" ]] || fail "expected uid $RUNTIME_UID"
[[ "\$(id -un)" == "$RUNTIME_USER" ]] || fail "expected user $RUNTIME_USER"
[[ "\$(id -g)" == "$RUNTIME_GID" ]] || fail "expected gid $RUNTIME_GID"
[[ "\$(id -G)" == "$RUNTIME_GID" ]] || fail "supplementary groups are present"
[[ "\$(node --version)" == "v${NODE_VERSION}" ]] || fail "Node version changed"
[[ "\$(npm --version)" == "$NPM_VERSION" ]] || fail "npm version changed"
[[ "\$($OC_BIN --version)" == "oc version $OC_SOURCE_COMMIT" ]] || fail "oc version changed"
printf '%s  %s\n' "$OC_BINARY_SHA256" "$OC_BIN" | sha256sum --check --status \
  || fail "oc binary digest changed"
printf '%s  %s\n' "$attestation_sha" "$ATTESTATION" | sha256sum --check --status \
  || fail "snapshot attestation changed"
[[ ! -w "$OC_BIN" ]] || fail "oc binary is writable"
[[ ! -w "/opt/opencomputer/bin" ]] || fail "toolchain bin directory is writable"
[[ ! -w "$NODE_ROOT" ]] || fail "Node toolchain is writable"
[[ ! -e /usr/bin/sudo && ! -e /bin/sudo ]] || fail "sudo executable was restored"
[[ -z "\$(find / -xdev \( -type f -o -type l \) \( -name sudo -o -name sudoedit \) -print -quit 2>/dev/null)" ]] \
  || fail "a sudo executable entrypoint remains on the runtime root filesystem"
[[ -d "$WORKSPACE" && -w "$WORKSPACE" ]] || fail "workspace is not writable"
probe="\$(mktemp "$WORKSPACE/.flue-builder-write.XXXXXX")" \
  || fail "cannot create a workspace file"
rm -f "\$probe"
EOF
}

install_runtime_verifier() {
  require_root

  local attestation_sha
  attestation_sha="$(sha256sum "$ATTESTATION" | awk '{print $1}')"
  write_runtime_verifier "$RUNTIME_VERIFIER" "$attestation_sha"
  chown root:root "$RUNTIME_VERIFIER"
  chmod 0555 "$RUNTIME_VERIFIER"
}

remove_runtime_privilege_surfaces() {
  # Empty the complete supplementary-group list. This is intentionally not an
  # allow/deny list of familiar administrator groups: a base-image change must
  # not silently preserve privilege through a differently named group.
  usermod -G '' "$RUNTIME_USER"
  usermod --lock "$RUNTIME_USER"
  rm -rf "/run/sudo/ts/$RUNTIME_USER" "/var/run/sudo/ts/$RUNTIME_USER"

  # Sudoers is a rich policy language (aliases, groups, includes, commands).
  # Trying to prove every policy path denied is brittle, so the managed image
  # removes the setuid entrypoint itself after the last trusted sudo command.
  # Search the root filesystem rather than assuming one package path. Remove
  # regular files and symlinks named sudo/sudoedit, including alternate PATH
  # locations and the sudoedit entrypoint, while preserving inert package
  # directories such as /usr/share/doc/sudo and /usr/lib/*/sudo.
  find / -xdev \( -type f -o -type l \) \( -name sudo -o -name sudoedit \) \
    -exec rm -f -- {} + 2>/dev/null
  [[ -z "$(find / -xdev \( -type f -o -type l \) \( -name sudo -o -name sudoedit \) -print -quit 2>/dev/null)" ]] \
    || die "could not remove every sudo executable entrypoint"
}

harden_agent_transport_nodes() {
  local path

  # The root guest agent owns root exec, filesystem, and upgrade RPCs. QEMU's
  # virtio-serial device and the test-only Unix fallback must not be openable
  # by repository code. AF_VSOCK peer rejection is enforced by osb-agent and
  # exercised by the live substrate probe.
  for path in /dev/virtio-ports/agent /dev/vport0p1 /dev/vport1p1 /dev/vport2p1 \
    /tmp/osb-agent.sock; do
    if [[ -e "$path" || -S "$path" ]]; then
      chmod 0600 "$path"
    fi
  done
}

finalize() {
  require_root
  assert_platform
  verify
  install_runtime_verifier

  # Repository code must be able to write only its workspace. The trusted
  # toolchain and attestation remain root-owned and immutable to uid 1000.
  chown -R root:root /opt/opencomputer
  chmod -R go-w /opt/opencomputer
  chmod 0555 "$OC_BIN" "$RUNTIME_VERIFIER"
  chmod 0444 "$ATTESTATION"
  if [[ -d /home/sandbox ]]; then
    chown -R "$RUNTIME_USER:$RUNTIME_USER" /home/sandbox
  fi
  if [[ -d "$WORKSPACE" && ! -L "$WORKSPACE" ]]; then
    chown -R "$RUNTIME_USER:$RUNTIME_USER" "$WORKSPACE"
  fi

  harden_agent_transport_nodes
  remove_runtime_privilege_surfaces
  [[ "$(runuser -u "$RUNTIME_USER" -- id -G)" == "$RUNTIME_GID" ]] \
    || die "runtime user retains supplementary groups"

  # No later image-build operation needs privilege. Remove the root-capable
  # installer before returning to the non-root image builder.
  rm -f -- "$0"
}

case "${1:-}" in
  coordinate)
    write_attestation /dev/stdout
    ;;
  runtime-verifier)
    write_runtime_verifier /dev/stdout \
      0000000000000000000000000000000000000000000000000000000000000000
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
  finalize)
    finalize
    ;;
  *)
    die "usage: $0 {coordinate|runtime-verifier|node|oc|attest|verify|finalize}"
    ;;
esac
