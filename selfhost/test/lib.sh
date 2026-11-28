# shellcheck shell=bash disable=SC2034  # sourced; its variables are for the test files
# Shared by selfhost/test/*.test.sh: plain bash asserts, no framework.
# Each test file sources this, calls `check` per case and ends with `finish`.
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELFHOST="$(dirname "$TEST_DIR")"
FAILS=0 PASSES=0

ok()   { PASSES=$((PASSES + 1)); printf 'ok   %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL %s\n' "$1"; shift; printf '     %s\n' "$@"; }

# check <name> <expected> <actual>
check() { if [[ $2 == "$3" ]]; then ok "$1"; else fail "$1" "expected: $2" "actual:   $3"; fi; }
# check_has <name> <needle> <haystack>
check_has() { if [[ $3 == *"$2"* ]]; then ok "$1"; else fail "$1" "expected to contain: $2" "actual: $3"; fi; }
check_lacks() { if [[ $3 != *"$2"* ]]; then ok "$1"; else fail "$1" "expected not to contain: $2" "actual: $3"; fi; }

# unit_execs <unit file> <key>: the unit's <key>= commands, one per line, without systemd's - prefix.
unit_execs() { sed -n "s/^$2=-\{0,1\}//p" "$1"; }

# A fresh fake iptables state; puts selfhost/test/bin first in PATH.
fake_iptables() {
  FAKE_IPT="$(mktemp -d)"; export FAKE_IPT
  export PATH="$TEST_DIR/bin:$PATH"
}

finish() {
  printf '%s: %d passed, %d failed\n' "$(basename "$0")" "$PASSES" "$FAILS"
  [[ $FAILS == 0 ]]
}
