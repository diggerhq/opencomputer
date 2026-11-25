#!/bin/sh
# opc installer: curl -fsSL https://raw.githubusercontent.com/diggerhq/opc/main/ci/install.sh | sh
#
# Detects the platform, downloads the matching release from GitHub, checks
# its SHA-256 against the release's SHA256SUMS and installs it to
# ~/.local/bin/opc (or $OPC_INSTALL_DIR). Never uses sudo, never edits shell
# startup files.
#
#   OPC_VERSION=v0.1.0-rc.3   install this release (pre-releases included)
#   OPC_INSTALL_DIR=/opt/bin  install there instead of ~/.local/bin
#
# Without OPC_VERSION it installs the latest release, or the newest
# pre-release while there is no full release yet.
set -eu

repo=diggerhq/opc
# Test hooks (ci/install-test.sh); the defaults are GitHub's.
gh=${OPC_GITHUB_URL:-https://github.com}
api=${OPC_GITHUB_API:-https://api.github.com}
dir=${OPC_INSTALL_DIR:-$HOME/.local/bin}
version=${OPC_VERSION:-latest}

fail() { echo "opc install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs $1"; }
need curl
need tar
need uname

os=$(uname -s)
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x86_64 ;;
  arm64|aarch64) arch=aarch64 ;;
  *) fail "no build for $arch" ;;
esac
case "$os" in
  Linux) target="$arch-unknown-linux-musl" ;;
  Darwin) target="$arch-apple-darwin" ;;
  *) fail "no build for $os; on Windows use WSL 2" ;;
esac

if [ "$version" = latest ]; then
  # The redirect of /releases/latest names the tag, with no API rate limit.
  # While only pre-releases exist it is a 404 or a redirect to /releases:
  # then ask the API for the newest.
  version=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$gh/$repo/releases/latest" 2>/dev/null | sed 's#.*/##') || version=
  case "$version" in v*) ;; *) version= ;; esac
  if [ -z "$version" ]; then
    version=$(curl -fsSL "$api/repos/$repo/releases?per_page=1" 2>/dev/null \
      | tr "," "\n" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) || version=
  fi
  [ -n "$version" ] || fail "could not find a release of opc; set OPC_VERSION (see https://github.com/$repo/releases)"
fi

name="opc-$version-$target"
base="$gh/$repo/releases/download/$version"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading opc $version for $target"
curl -fsSL -o "$tmp/$name.tar.gz" "$base/$name.tar.gz" || fail "download failed: $base/$name.tar.gz"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download SHA256SUMS"

want=$(awk -v f="$name.tar.gz" '$2 == f || $2 == "*"f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || fail "$name.tar.gz is not in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$name.tar.gz" | awk '{print $1}')
else
  got=$(shasum -a 256 "$tmp/$name.tar.gz" | awk '{print $1}')
fi
[ "$want" = "$got" ] || fail "checksum mismatch for $name.tar.gz"

tar -C "$tmp" -xzf "$tmp/$name.tar.gz"
mkdir -p "$dir"
mv -f "$tmp/$name/opc" "$dir/opc.new"
chmod 755 "$dir/opc.new"
mv -f "$dir/opc.new" "$dir/opc"
echo "Installed $("$dir/opc" --version) to $dir/opc"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "$dir is not on your PATH. Add this line to your shell's startup file:"
     echo "  export PATH=\"$dir:\$PATH\"" ;;
esac
echo "Run opc to start."
