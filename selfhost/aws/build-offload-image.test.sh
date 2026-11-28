#!/usr/bin/env bash
# The zip step of build-offload-image.sh in time zones on both sides of UTC,
# with zip(1) and with the python3 fallback: each run must succeed, and every
# run must make the same zip (its sha256 is in the "builder" line). Uses
# --dry-run, so it makes no AWS call. Also the clientTokens: the same inputs
# give the same tokens, another build role (a re-created stack) other ones,
# and each is at most 64 characters.
#
#   selfhost/aws/build-offload-image.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/build-offload-image.sh"
ARGS=(--dry-run --region ap-northeast-2 --bucket oc-offload-test-bucket
  --build-role-arn arn:aws:iam::123456789012:role/test-build
  --session-image "ghcr.io/diggerhq/computer-session@sha256:$(printf '0%.0s' {1..64})")

# A PATH without zip, so the script takes its python3 fallback.
NOZIP="$(mktemp -d)"
trap 'rm -rf "$NOZIP"' EXIT
IFS=: read -ra dirs <<<"$PATH"
for d in "${dirs[@]}"; do
  for f in "$d"/*; do
    n="${f##*/}"
    [[ -x $f && ! -e $NOZIP/$n && $n != zip ]] && ln -s "$f" "$NOZIP/$n"
  done
done

fail=0 sums=()
for tool in zip python3; do
  [[ $tool == python3 ]] && path="$NOZIP" || path="$PATH"
  if [[ $tool == zip ]] && ! command -v zip >/dev/null; then echo "skip: no zip here"; continue; fi
  for tz in UTC America/Los_Angeles Pacific/Auckland; do
    if out="$(TZ=$tz PATH=$path "$SCRIPT" "${ARGS[@]}" 2>&1)"; then
      sum="$(sed -n 's/.*zip sha256 \([0-9a-f]*\)).*/\1/p' <<<"$out")"
      echo "ok   $tool TZ=$tz zip $sum"; sums+=("$tool:$sum")
    else
      echo "FAIL $tool TZ=$tz:"; tail -3 <<<"$out"; fail=1
    fi
  done
done
for tool in zip python3; do
  n="$(printf '%s\n' "${sums[@]}" | sed -n "s/^$tool://p" | sort -u | wc -l)"
  ((n <= 1)) || { echo "FAIL $tool: the zip differs between time zones"; fail=1; }
done
tokens() { "$SCRIPT" "${ARGS[@]}" "$@" 2>&1 | grep -o 'clientToken\\":\\"[^\\]*' | sed 's/.*"//' | sort -u; }
a="$(tokens)" a2="$(tokens)" b="$(tokens --build-role-arn arn:aws:iam::123456789012:role/test-build-2)"
if [[ -z $a || $a != "$a2" ]]; then echo "FAIL clientToken: not stable: $a / $a2"; fail=1
elif [[ $(comm -12 <(echo "$a") <(echo "$b")) ]]; then echo "FAIL clientToken: the same for another build role"; fail=1
elif awk 'length > 64 { bad = 1 } END { exit !bad }' <<<"$a"$'\n'"$b"; then echo "FAIL clientToken: over 64 characters"; fail=1
else echo "ok   clientToken: $(wc -l <<<"$a") per role, $(awk '{ print length }' <<<"$a" | sort -n | tail -1) chars, new for another role"; fi

((fail == 0)) && echo "PASS" || { echo "FAIL"; exit 1; }
