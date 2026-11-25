#!/bin/sh
# Checks that schema/computer-api.v1.json, which the fake server in tests/
# validates every object against, is the server's schema in
# ../computer/schema/. The computer CI checks that file against its generator
# (scripts/api-schema.mjs --check), so equal files mean opc tests against the
# API the server serves. To update: cp ../computer/schema/computer-api.v1.json schema/
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
ours="$here/schema/computer-api.v1.json"
theirs="$here/../computer/schema/computer-api.v1.json"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

norm() { python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), indent=1, sort_keys=True))' "$1"; }
norm "$ours" > "$tmp/a"
norm "$theirs" > "$tmp/b"
if ! diff -u "$tmp/a" "$tmp/b" > "$tmp/diff"; then
  echo "schema-check: schema/computer-api.v1.json differs from computer/schema/computer-api.v1.json:" >&2
  head -200 "$tmp/diff" >&2
  echo "schema-check: copy the server's file over and make the fake in tests/support/ emit what it requires" >&2
  exit 1
fi
echo "schema-check: matches computer/schema/computer-api.v1.json"
