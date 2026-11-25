#!/bin/sh
# opc installer: curl -fsSL https://raw.githubusercontent.com/diggerhq/opencomputer/main/opc/ci/install.sh | sh
#
# Detects the platform, downloads the matching release from GitHub, checks
# its SHA-256 against the release's SHA256SUMS and installs it to
# ~/.local/bin/opc (or $OPC_INSTALL_DIR). Never uses sudo, never edits shell
# startup files.
#
#   OPC_VERSION=v0.1.0-rc.3   install this release (pre-releases included);
#                             the tag opc-v0.1.0-rc.3 works too
#   OPC_INSTALL_DIR=/opt/bin  install there instead of ~/.local/bin
#
# Without OPC_VERSION it installs the latest release, or the newest
# pre-release while there is no full release yet.
#
# opc lives in diggerhq/opencomputer, whose releases it shares with other
# components: its tags are opc-v*, and its assets are named after the version
# without the prefix (opc-v0.1.0-<target>.tar.gz in the release opc-v0.1.0).
set -eu

repo=diggerhq/opencomputer
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
  # /releases/latest may be another component's, so list the releases and
  # take the highest opc-v* version that is not a pre-release, or the highest
  # pre-release while there is no full release. The API orders releases by
  # date, not version, and puts "prerelease" after "tag_name" in each.
  version=$(curl -fsSL "$api/repos/$repo/releases?per_page=100" 2>/dev/null \
    | tr "," "\n" \
    | sed -n -e 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/t \1/p' \
             -e 's/.*"prerelease"[[:space:]]*:[[:space:]]*\([a-z]*\).*/p \1/p' \
    | awk '
      # A key that sorts as the version does: 0.1.0-rc.9 < 0.1.0-rc.10 < 0.1.0.
      function key(v,   core, pre, i, n, a, k) {
        sub(/^opc-v/, "", v); core = v; pre = ""
        if ((i = index(v, "-")) > 0) { core = substr(v, 1, i - 1); pre = substr(v, i + 1) }
        n = split(core, a, "."); k = ""
        for (i = 1; i <= 3; i++) k = k sprintf("%06d.", a[i] + 0)
        if (pre == "") return k "~"
        n = split(pre, a, ".")
        for (i = 1; i <= n; i++) k = k (a[i] ~ /^[0-9]+$/ ? sprintf("%06d", a[i]) : a[i]) "."
        return k
      }
      $1 == "t" { tag = $2; next }
      $1 == "p" && tag ~ /^opc-v/ {
        k = key(tag)
        if ($2 != "true" && k > fullk) { full = tag; fullk = k }
        if (k > anyk) { any = tag; anyk = k }
        tag = ""
      }
      END { print (full != "" ? full : any) }') || version=
  [ -n "$version" ] || fail "could not find a release of opc; set OPC_VERSION (see https://github.com/$repo/releases)"
fi
version=${version#opc-}
tag="opc-$version"

name="opc-$version-$target"
base="$gh/$repo/releases/download/$tag"
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
