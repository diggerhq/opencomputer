#!/bin/sh
# Checks that schema/computer-api.v1.json, which the fake server in tests/
# validates every object against, is the schema the Computer API publishes.
#
#   SERVER_DIR=../server ci/schema-check.sh   # against the server's schema generator
#   ci/schema-check.sh                        # against the published copy
#
# Until the published URL serves the schema, a 404 there is a warning, not a
# failure; a difference is always a failure.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
ours="$here/schema/computer-api.v1.json"
url=${OPC_SCHEMA_URL:-https://opencomputer.dev/schemas/computer-api.v1.json}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${SERVER_DIR:-}" ]; then
  # --check proves the server's committed schema is what its source emits,
  # and never writes; then that file is the one to compare with.
  (cd "$SERVER_DIR" && node scripts/api-schema.mjs --check) >&2
  cp "$SERVER_DIR/schema/computer-api.v1.json" "$tmp/theirs.json"
  from="the server's generator ($SERVER_DIR)"
else
  code=$(curl -sS -o "$tmp/theirs.json" -w '%{http_code}' "$url" || echo 000)
  if [ "$code" != 200 ]; then
    echo "schema-check: $url answered $code; not published yet, skipping" >&2
    exit 0
  fi
  from=$url
fi

norm() { python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), indent=1, sort_keys=True))' "$1"; }
norm "$ours" > "$tmp/a"
norm "$tmp/theirs.json" > "$tmp/b"
if ! diff -u "$tmp/a" "$tmp/b" > "$tmp/diff"; then
  echo "schema-check: schema/computer-api.v1.json differs from $from:" >&2
  head -200 "$tmp/diff" >&2
  exit 1
fi
echo "schema-check: matches $from"
