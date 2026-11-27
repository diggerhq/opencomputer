#!/usr/bin/env bash
# Checks that the cloud instance metadata service is denied to every user but
# root (opencomputer-imds-deny.service). Read-only: it sends one request per
# user to the metadata address and changes nothing. Run it on the host:
#
#   sudo selfhost/check-imds.sh
#
# For root and for each of agent, sp-host, modelproxy, oc-gateway and
# oc-offload that exists, and inside one running session container, it asks
# the metadata service the way each cloud wants (AWS: IMDSv2 token PUT; Azure:
# Metadata: true; GCP: Metadata-Flavor: Google). Any HTTP answer, even an error,
# means "reachable"; a REJECT or a timeout means "denied". Root may reach it;
# oc-offload may, only where build offload is enabled; everyone else must not.
# Exit 0 when that holds, 1 otherwise. On a machine with no metadata service
# every probe is "denied" and the check says so.
set -uo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root (sudo $0)" >&2; exit 2; }
IMDS=169.254.169.254
FAILED=0

# probe: prints reachable or denied for the current user, trying all three clouds.
probe() {
  local code
  for args in "-X PUT -H X-aws-ec2-metadata-token-ttl-seconds:10 http://$IMDS/latest/api/token" \
              "-H Metadata:true http://$IMDS/metadata/instance?api-version=2021-02-01" \
              "-H Metadata-Flavor:Google http://$IMDS/computeMetadata/v1/"; do
    # shellcheck disable=SC2086  # args is a list of words
    code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' $args 2>/dev/null)"
    [[ $code == 000 || -z $code ]] || { echo reachable; return; }
  done
  echo denied
}
PROBE="$(declare -f probe); IMDS=$IMDS; probe"

as() { runuser -u "$1" -- bash -c "$PROBE" 2>/dev/null || echo "error"; }

report() {  # report <who> <result> <allowed: yes|no|optional>
  local verdict=ok
  if [[ $2 == reachable && $3 == no ]] || [[ $2 == error ]]; then verdict=FAIL; FAILED=1; fi
  printf '%-34s %-10s %s\n' "$1" "$2" "$verdict"
}

echo "== chain"
if iptables -S OC-IMDS 2>/dev/null; then :; else echo "no OC-IMDS chain: opencomputer-imds-deny.service is not active"; FAILED=1; fi
iptables -S OUTPUT 2>/dev/null | grep -- '-j OC-IMDS' || { echo "no jump to OC-IMDS from OUTPUT"; FAILED=1; }

echo "== probes"
root_result="$(probe)"
report root "$root_result" yes
[[ $root_result == reachable ]] || echo "(root cannot reach $IMDS either: no metadata service here, so the probes below prove little)"
for u in agent sp-host modelproxy oc-gateway; do
  id "$u" >/dev/null 2>&1 && report "$u" "$(as "$u")" no
done
if id oc-offload >/dev/null 2>&1; then
  report oc-offload "$(as oc-offload)" "$( [[ -f /etc/opencomputer/offload.enabled ]] && echo optional || echo no)"
fi

# One running session container, as the agent: its traffic leaves through pasta, as uid 1500.
if id agent >/dev/null 2>&1 && [[ -S /run/user/1500/bus ]]; then
  c="$(runuser -u agent -- env XDG_RUNTIME_DIR=/run/user/1500 podman ps -q 2>/dev/null | head -1)"
  if [[ -n $c ]]; then
    r="$(runuser -u agent -- env XDG_RUNTIME_DIR=/run/user/1500 podman exec "$c" bash -c "$PROBE" 2>/dev/null || echo error)"
    report "session container $c" "$r" no
  else
    echo "(no running session container to probe)"
  fi
fi

if [[ $FAILED == 0 ]]; then echo "PASS: the metadata service is denied to every non-root user"; else echo "FAIL"; fi
exit "$FAILED"
