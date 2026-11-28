#!/usr/bin/env bash
# opencomputer-imds-deny.service against a fake iptables: the chain's rules and
# their order, one jump per metadata address, idempotent across restarts, and
# host-install.sh's removal. bash selfhost/test/imds-deny.test.sh
set -uo pipefail
# shellcheck source=selfhost/test/lib.sh
source "$(dirname "$0")/lib.sh"
UNITF="$SELFHOST/systemd/opencomputer-imds-deny.service"

fake_iptables
# The unit's commands are /bin/sh -c '<script>': run each script as systemd would.
start() {
  local c argv
  while IFS= read -r c; do
    eval "argv=(${c#/bin/sh })"   # -c '<script>'
    sh "${argv[@]}" || return 1
  done < <(unit_execs "$UNITF" ExecStart)
}

chain='-p udp --dport 53 -j RETURN
-p tcp --dport 53 -j RETURN
-p udp --dport 123 -j RETURN
-m owner --uid-owner 0 -j RETURN
-j REJECT'

start; check "first start succeeds" 0 $?
check "v4 chain: DNS, NTP, root, then REJECT" "$chain" "$(cat "$FAKE_IPT/iptables/OC-IMDS")"
check "v6 chain: the same" "$chain" "$(cat "$FAKE_IPT/ip6tables/OC-IMDS")"
check "v4 jump for 169.254.169.254" "-d 169.254.169.254 -j OC-IMDS" "$(cat "$FAKE_IPT/iptables/OUTPUT")"
check "v6 jumps for AWS and GCP addresses" $'-d fd20:ce::254 -j OC-IMDS\n-d fd00:ec2::254 -j OC-IMDS' "$(cat "$FAKE_IPT/ip6tables/OUTPUT")"

# The offload exception sits at the top; a restart flushes it, ExecStartPost restores it.
echo "-m owner --uid-owner oc-offload -j RETURN" >"$FAKE_IPT/iptables/OC-IMDS.tmp"
cat "$FAKE_IPT/iptables/OC-IMDS" >>"$FAKE_IPT/iptables/OC-IMDS.tmp"; mv "$FAKE_IPT/iptables/OC-IMDS.tmp" "$FAKE_IPT/iptables/OC-IMDS"
start; check "second start succeeds" 0 $?
check "restart: v4 chain refilled, nothing doubled" "$chain" "$(cat "$FAKE_IPT/iptables/OC-IMDS")"
check "restart: still one v4 jump" "-d 169.254.169.254 -j OC-IMDS" "$(cat "$FAKE_IPT/iptables/OUTPUT")"
check "restart: still two v6 jumps" 2 "$(wc -l <"$FAKE_IPT/ip6tables/OUTPUT")"
check "ExecStartPost restores the offload exception without blocking" \
  "/bin/systemctl --no-block try-restart opencomputer-offload-imds.service" "$(unit_execs "$UNITF" ExecStartPost)"
check_has "ordered before the host and every user manager" "Before=slack-presence-host.service opencomputer-offload.service user.slice" "$(cat "$UNITF")"

# Other OUTPUT rules (the agent's per-uid block) are left alone.
echo "-d 169.254.169.254 -m owner --uid-owner 1500 -j REJECT" >>"$FAKE_IPT/iptables/OUTPUT"
start
check_has "per-uid block kept" "--uid-owner 1500 -j REJECT" "$(cat "$FAKE_IPT/iptables/OUTPUT")"

# host-install.sh --uninstall: imds_deny_remove, lifted out of the script.
DRY_RUN=0   # read by imds_deny_remove
export DRY_RUN
run() { "$@"; }
warn() { echo "WARNING: $*" >&2; }
eval "$(sed -n '/^imds_deny_remove() {/,/^}/p' "$SELFHOST/host-install.sh")"
imds_deny_remove
check "uninstall: no v4 chain" "absent" "$( [[ -f $FAKE_IPT/iptables/OC-IMDS ]] && echo present || echo absent)"
check "uninstall: no v6 chain" "absent" "$( [[ -f $FAKE_IPT/ip6tables/OC-IMDS ]] && echo present || echo absent)"
check "uninstall: only the per-uid block is left" "-d 169.254.169.254 -m owner --uid-owner 1500 -j REJECT" "$(cat "$FAKE_IPT/iptables/OUTPUT")"
check "uninstall: no v6 jumps left" "" "$(cat "$FAKE_IPT/ip6tables/OUTPUT")"
imds_deny_remove; check "uninstall twice is a no-op" 0 $?

rm -rf "$FAKE_IPT"
finish
