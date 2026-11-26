#!/bin/sh
# Tests ci/install.sh against a local stand-in for GitHub: picking the latest
# opc release among other components' releases (falling back to the newest
# pre-release while there is no full one), a pinned OPC_VERSION, and a
# checksum mismatch.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'kill "$srv" 2>/dev/null || true; rm -rf "$work"' EXIT

uname_s=$(uname -s); uname_m=$(uname -m)
case "$uname_m" in x86_64|amd64) a=x86_64 ;; *) a=aarch64 ;; esac
case "$uname_s" in Linux) target="$a-unknown-linux-musl" ;; *) target="$a-apple-darwin" ;; esac

site="$work/site"
release() { # version, version text; the release's tag is opc-<version>
  name="opc-$1-$target"
  d="$site/diggerhq/opencomputer/releases/download/opc-$1"
  mkdir -p "$d" "$work/build/$name"
  printf '#!/bin/sh\necho "opc %s"\n' "$2" > "$work/build/$name/opc"
  chmod 755 "$work/build/$name/opc"
  tar -C "$work/build" -czf "$d/$name.tar.gz" "$name"
  (cd "$d" && { command -v sha256sum >/dev/null && sha256sum "$name.tar.gz" || shasum -a 256 "$name.tar.gz"; } > SHA256SUMS)
}
release v0.1.0-rc.2 0.1.0-rc.2
release v0.1.0-rc.1 0.1.0-rc.1
mkdir -p "$site/repos/diggerhq/opencomputer"
releases() { printf '%s' "$1" > "$site/repos/diggerhq/opencomputer/releases"; }
# Listed by date, not version, as the API does; a different component's release first.
release v0.1.0-rc.10 0.1.0-rc.10
releases '[{"tag_name": "v0.6.0.51", "prerelease": false}, {"tag_name": "opc-v0.1.0-rc.2", "prerelease": true}, {"tag_name": "opc-v0.1.0-rc.10", "prerelease": true}, {"tag_name": "opc-v0.1.0-rc.1", "prerelease": true}]'

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
(cd "$site" && exec python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1) &
srv=$!
i=0; until curl -fs "http://127.0.0.1:$port/repos/diggerhq/opencomputer/releases" >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 50 ] || { echo "server did not start"; exit 1; }; sleep 0.1; done

export OPC_GITHUB_URL="http://127.0.0.1:$port" OPC_GITHUB_API="http://127.0.0.1:$port"
fail() { echo "FAIL: $*"; exit 1; }

out=$(OPC_INSTALL_DIR="$work/bin1" sh "$here/install.sh" 2>&1) || fail "latest fallback: $out"
[ "$("$work/bin1/opc")" = "opc 0.1.0-rc.10" ] || fail "latest fallback installed the wrong build: $out"
echo "ok - latest falls back to the highest pre-release, skipping other components"

releases '[{"tag_name": "v0.6.0.51", "prerelease": false}, {"tag_name": "opc-v0.1.0-rc.2", "prerelease": true}, {"tag_name": "opc-v0.1.0-rc.1", "prerelease": false}]'
out=$(OPC_INSTALL_DIR="$work/bin4" sh "$here/install.sh" 2>&1) || fail "latest: $out"
[ "$("$work/bin4/opc")" = "opc 0.1.0-rc.1" ] || fail "latest did not prefer the full release: $out"
echo "ok - latest prefers the newest full release"

out=$(OPC_VERSION=v0.1.0-rc.1 OPC_INSTALL_DIR="$work/bin2" sh "$here/install.sh" 2>&1) || fail "pinned: $out"
[ "$("$work/bin2/opc")" = "opc 0.1.0-rc.1" ] || fail "OPC_VERSION was not honoured: $out"
echo "ok - OPC_VERSION pins a pre-release"

out=$(OPC_VERSION=opc-v0.1.0-rc.1 OPC_INSTALL_DIR="$work/bin5" sh "$here/install.sh" 2>&1) || fail "pinned tag: $out"
[ "$("$work/bin5/opc")" = "opc 0.1.0-rc.1" ] || fail "OPC_VERSION as a tag was not honoured: $out"
echo "ok - OPC_VERSION takes the tag too"

echo "0000000000000000000000000000000000000000000000000000000000000000  opc-v0.1.0-rc.1-$target.tar.gz" > "$site/diggerhq/opencomputer/releases/download/opc-v0.1.0-rc.1/SHA256SUMS"
if out=$(OPC_VERSION=v0.1.0-rc.1 OPC_INSTALL_DIR="$work/bin3" sh "$here/install.sh" 2>&1); then fail "a bad checksum installed: $out"; fi
case "$out" in *"checksum mismatch"*) ;; *) fail "unexpected error: $out" ;; esac
[ ! -e "$work/bin3/opc" ] || fail "a bad checksum left a binary"
echo "ok - a checksum mismatch installs nothing"
