#!/usr/bin/env bash
# host-install.sh --enable-offload / --disable-offload under OC_ROOT (a temp
# directory standing in for /), with fake systemctl, systemd-run, user tools,
# curl and DMI: refuses off AWS and changes nothing; on "EC2 with a role" writes
# the user, units, env lines and marker; disable removes all of it even when
# the drain fails, and keeps the ledger; the oc-offload exception goes first in
# OC-IMDS, once. bash selfhost/test/offload-install.test.sh
set -uo pipefail
# shellcheck source=selfhost/test/lib.sh
source "$(dirname "$0")/lib.sh"

TOKEN=AQAEAFakeTokenForTests0123456789abcdef==
DOC='{"accountId":"123456789012","instanceId":"i-0123456789abcdef0","region":"eu-west-1"}'

# A fake / with an installed host, fakes first in PATH.
setup() {
  T="$(mktemp -d)"; export T OC_ROOT="$T/root" FAKE_CURL="$T/imds" OC_DMI="$T/dmi"
  export OC_CURL="$TEST_DIR/bin/fake-curl" OC_IMDS=http://169.254.169.254
  mkdir -p "$OC_ROOT/etc/opencomputer" "$OC_ROOT/etc/systemd/system" "$OC_ROOT/run" \
    "$OC_ROOT/opt/slack-presence/current/src/offload" "$FAKE_CURL" "$OC_DMI" "$T/bin"
  printf 'SP_GATEWAY_URL=ws://127.0.0.1:8080/v1/computer/host?organizationId=org_selfhost\nSP_HOST_TOKEN=sph_x\n' \
    >"$OC_ROOT/etc/opencomputer/selfhost.env"
  : >"$OC_ROOT/opt/slack-presence/current/src/offload/main.ts"
  printf 'sp-host\nagent\n' >"$T/users"; : >"$T/calls"; : >"$FAKE_CURL/calls"
  local f
  for f in systemctl systemd-run useradd userdel groupdel id getent chown sleep; do
    cat >"$T/bin/$f" <<'FAKE'
#!/usr/bin/env bash
me="$(basename "$0")"; echo "$me $*" >>"$T/calls"
last="${*: -1}"
case $me in
  systemctl) [[ $1 != restart || ! -f $T/fail-$2 ]] ;;
  systemd-run) exit "$(cat "$T/drain-rc" 2>/dev/null || echo 0)" ;;
  useradd) echo "$last" >>"$T/users" ;;
  userdel) grep -vx "$1" "$T/users" >"$T/u"; mv "$T/u" "$T/users" ;;
  id) grep -qx "$last" "$T/users" || exit 1
      case $1 in -u) echo 999 ;; -nG) echo "$last" ;; esac ;;
  getent) grep -qx "$last" "$T/users" ;;
esac
FAKE
    chmod +x "$T/bin/$f"
  done
  export PATH="$T/bin:$TEST_DIR/bin:$PATH" FAKE_IPT="$T/ipt"; mkdir -p "$FAKE_IPT"
}
ec2() {   # an EC2 metadata service with a role (or none)
  printf '%s\n' "Amazon EC2" >"$OC_DMI/sys_vendor"
  printf '%s' "$TOKEN" >"$FAKE_CURL/PUT_latest_api_token"
  printf '%s' "$DOC" >"$FAKE_CURL/GET_latest_dynamic_instance-identity_document"
  if [[ -n ${1-} ]]; then printf '%s' "$1" >"$FAKE_CURL/GET_latest_meta-data_iam_security-credentials_"; fi
}
hi() { OUT="$(bash "$SELFHOST/host-install.sh" "$@" 2>&1)"; RC=$?; }
tree() { (cd "$OC_ROOT" && find . -type f | sort | tr '\n' ' '); }
ENV() { cat "$OC_ROOT/etc/opencomputer/selfhost.env"; }

# Azure: refused, nothing written, no metadata request.
setup; printf 'Microsoft Corporation\n' >"$OC_DMI/sys_vendor"; before="$(tree)"
hi --enable-offload --bucket oc-offload-b --image-s img-s --image-m img-m
check "azure: refused" 1 "$RC"
check_has "azure: says why" "build offload is AWS-only" "$OUT"
check_has "azure: nothing changed" "Nothing was changed" "$OUT"
check "azure: no files" "$before" "$(tree)"
check "azure: no user, no units" "" "$(grep -E '^(useradd|systemctl (enable|restart))' "$T/calls")"
check "azure: no metadata request" "" "$(cat "$FAKE_CURL/calls")"
hi --enable-offload --dry-run --bucket oc-offload-b
check "azure dry run: refused" 1 "$RC"

# Bare metal: refused.
setup; hi --enable-offload --bucket oc-offload-b
check "bare metal: refused" "1" "$RC"
check_has "bare metal: reason" "no EC2 metadata service" "$OUT"
check_lacks "bare metal: no marker" "offload.enabled" "$(tree)"

# EC2 without a role: refused with the instance profile hint.
setup; ec2; before="$(tree)"
hi --enable-offload --bucket oc-offload-b
check "no role: refused" 1 "$RC"
check_has "no role: hint" "InstanceProfileArn" "$OUT"
check "no role: no files" "$before" "$(tree)"

# Flags: bad values, and flags without --enable-offload.
setup; ec2 oc-offload-role
hi --enable-offload --bucket Bad_Bucket
check_has "bad bucket refused" "not an S3 bucket name" "$OUT"
hi --bucket oc-offload-b
check_has "flag without enable refused" "go with --enable-offload" "$OUT"
hi --enable-offload
check_has "no bucket refused" "--bucket is required" "$OUT"
check_lacks "no bucket: no marker" "offload.enabled" "$(tree)"

# EC2 with a role, dry run: the plan, nothing written.
setup; ec2 oc-offload-role; before="$(tree)"
hi --enable-offload --dry-run --bucket oc-offload-b --image-s img-s --image-m=img-m
check "dry run: exit 0" 0 "$RC"
check_has "dry run: detection" "aws eu-west-1 i-0123456789abcdef0 oc-offload-role" "$OUT"
check_has "dry run: env plan" "SP_OFFLOAD_BACKEND=aws-microvm SP_OFFLOAD_BUCKET=oc-offload-b SP_OFFLOAD_REGION=eu-west-1 SP_OFFLOAD_IMAGE_S=img-s SP_OFFLOAD_IMAGE_M=img-m SP_OFFLOAD_CONTROL=" "$OUT"
check "dry run: no files" "$before" "$(tree)"
check "dry run: no calls" "" "$(grep -vE '^(id|getent) ' "$T/calls")"

# EC2 with a role: enabled.
hi --enable-offload --bucket oc-offload-b --image-s img-s --image-m img-m
check "enable: exit 0" 0 "$RC"
check "enable: user created" 1 "$(grep -c '^useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group oc-offload$' "$T/calls")"
check "enable: marker 0644" 644 "$(stat -c %a "$OC_ROOT/etc/opencomputer/offload.enabled")"
check "enable: env 0600" 600 "$(stat -c %a "$OC_ROOT/etc/opencomputer/selfhost.env")"
check "enable: env kept host lines" 1 "$(ENV | grep -c '^SP_HOST_TOKEN=sph_x$')"
check "enable: env lines" "SP_OFFLOAD_BACKEND=aws-microvm SP_OFFLOAD_BUCKET=oc-offload-b SP_OFFLOAD_REGION=eu-west-1 SP_OFFLOAD_IMAGE_S=img-s SP_OFFLOAD_IMAGE_M=img-m SP_OFFLOAD_CONTROL=/run/opencomputer-offload/control.sock" "$(ENV | grep '^SP_OFFLOAD' | tr '\n' ' ' | sed 's/ $//')"
for u in opencomputer-offload.service opencomputer-offload-reap.service opencomputer-offload-reap.timer opencomputer-offload-imds.service; do
  f="$OC_ROOT/etc/systemd/system/$u"
  check "enable: $u installed" yes "$([[ -f $f ]] && echo yes)"
  check "enable: $u filled" "" "$(grep -v '^#' "$f" | grep -o '@[A-Z_]*@')"
done
check_has "enable: service runs as oc-offload" "User=oc-offload" "$(cat "$OC_ROOT/etc/systemd/system/opencomputer-offload.service")"
UNIT="$(grep -v '^#' "$OC_ROOT/etc/systemd/system/opencomputer-offload.service")"
check_lacks "enable: no RuntimeDirectory (systemd re-applies it before each Exec*)" "RuntimeDirectory" "$UNIT"
check_has "enable: socket dir oc-offload:sp-host 2750" "ExecStartPre=+/usr/bin/install -d -o oc-offload -g sp-host -m 2750 /run/opencomputer-offload" "$UNIT"
check_has "enable: socket dir writable under ProtectSystem" "ReadWritePaths=/run/opencomputer-offload" "$UNIT"
check_has "enable: socket removed on stop" "ExecStopPost=+/bin/rm -f /run/opencomputer-offload/control.sock" "$UNIT"
check_has "enable: service condition on marker" "ConditionPathExists=$OC_ROOT/etc/opencomputer/offload.enabled" "$(cat "$OC_ROOT/etc/systemd/system/opencomputer-offload.service")"
check "enable: exception started before the service" "opencomputer-offload-imds.service opencomputer-offload-reap.timer opencomputer-offload.service" \
  "$(sed -n 's/^systemctl restart //p' "$T/calls" | tr '\n' ' ' | sed 's/ $//')"
check_lacks "enable: no secret in output" "sph_x" "$OUT"
check "enable: host restarted after the service" "opencomputer-offload.service slack-presence-host.service" \
  "$(sed -n 's/^systemctl \(try-\)\{0,1\}restart //p' "$T/calls" | tail -2 | tr '\n' ' ' | sed 's/ $//')"

# Enable again: idempotent (one user, no duplicate lines).
hi --enable-offload --bucket oc-offload-b
check "re-enable: exit 0" 0 "$RC"
check "re-enable: one useradd" 1 "$(grep -c '^useradd' "$T/calls")"
check "re-enable: one bucket line" 1 "$(ENV | grep -c '^SP_OFFLOAD_BUCKET=')"
hi --enable-offload --bucket oc-offload-c
check "new bucket replaces the old" "SP_OFFLOAD_BUCKET=oc-offload-c" "$(ENV | grep '^SP_OFFLOAD_BUCKET=')"

# The service fails to start: warning, still enabled (fail-closed).
touch "$T/fail-opencomputer-offload.service"; hi --enable-offload --bucket oc-offload-c
check "service fails: exit 0" 0 "$RC"
check_has "service fails: warning" "opencomputer-offload.service did not start" "$OUT"
rm "$T/fail-opencomputer-offload.service"
# The exception fails: error.
touch "$T/fail-opencomputer-offload-imds.service"; hi --enable-offload --bucket oc-offload-c
check "exception fails: exit 1" 1 "$RC"
rm "$T/fail-opencomputer-offload-imds.service"

# Disable, dry run: says what, changes nothing.
mkdir -p "$OC_ROOT/var/lib/opencomputer-offload"; echo '{"jobs":[]}' >"$OC_ROOT/var/lib/opencomputer-offload/ledger.json"
before="$(tree)"; : >"$T/calls"
hi --disable-offload --dry-run
check "disable dry run: exit 0" 0 "$RC"
check_has "disable dry run: drain shown" "would: timeout 180 systemd-run" "$OUT"
check "disable dry run: no files changed" "$before" "$(tree)"
check "disable dry run: no calls" "" "$(grep -E '^(systemd-run|userdel|systemctl (disable|restart))' "$T/calls")"

# Disable with a failing drain: everything removed, the ledger kept, the warning.
echo 1 >"$T/drain-rc"; : >"$T/calls"
hi --disable-offload
check "disable: exit 0" 0 "$RC"
check_has "disable: drain as oc-offload" "-p User=oc-offload" "$(grep '^systemd-run' "$T/calls")"
check_has "disable: drain command" "src/offload/main.ts drain --timeout 120" "$(grep '^systemd-run' "$T/calls")"
check_has "disable: drain failure said" "drain failed" "$OUT"
check_has "disable: running MicroVMs warned" "may still run until their maximum duration" "$OUT"
check_has "disable: AWS reminder" "delete the stack" "$OUT"
check "disable: no offload files" "" "$(tree | tr ' ' '\n' | grep -E 'offload\.(enabled|draining)|systemd/system/opencomputer-offload|var/lib/opencomputer-offload/')"
check "disable: no SP_OFFLOAD lines" "" "$(ENV | grep SP_OFFLOAD)"
check "disable: host lines kept" 1 "$(ENV | grep -c '^SP_HOST_TOKEN=sph_x$')"
check "disable: user removed" "" "$(grep -x oc-offload "$T/users")"
check "disable: host restarted" 1 "$(grep -c '^systemctl try-restart slack-presence-host.service$' "$T/calls")"
check "disable: ledger kept" '{"jobs":[]}' "$(cat "$OC_ROOT"/var/lib/opencomputer/offload-ledger-*/ledger.json)"
hi --disable-offload
check "disable again: nothing to do" "0 build offload is not enabled here; nothing to do" "$RC $OUT"

# Stale lines without the marker: install's plan warns, never enables.
setup; echo SP_OFFLOAD_BACKEND=aws-microvm >>"$OC_ROOT/etc/opencomputer/selfhost.env"
# shellcheck disable=SC2016  # $SELFHOST_ENV is expanded by the sourced script
OUT="$(bash -c 'warn() { printf "WARNING: %s\\n" "$*" >&2; }; source <(sed -n "/^# ------------------------------------------------------------------ helpers/,/^# ------------------------------------------------------------------ uninstall/p" "$1"); SELFHOST_ENV="$OC_ROOT/etc/opencomputer/selfhost.env" OFFLOAD_MARKER=/nonexistent OFFLOAD_KEYS="^[[:space:]]*SP_OFFLOAD[A-Z0-9_]*="; offload_plan_line; offload_upgrade' _ "$SELFHOST/host-install.sh" 2>&1)"
check_has "stale lines: plan warns" "they are ignored without --enable-offload" "$OUT"
check_has "stale lines: upgrade warns" "build offload is not enabled here" "$OUT"
check "stale lines: no detection" "" "$(cat "$FAKE_CURL/calls")"

# The exception unit against the fake iptables: first in OC-IMDS, once; ExecStop removes it.
setup
deny="$SELFHOST/systemd/opencomputer-imds-deny.service" ex="$SELFHOST/systemd/opencomputer-offload-imds.service"
while read -r c; do sh -c "$c"; done < <(unit_execs "$deny" ExecStart | head -1)
for _ in 1 2; do while read -r c; do sh -c "$c"; done < <(unit_execs "$ex" ExecStart); done
check "exception: first rule" "-A OC-IMDS -m owner --uid-owner oc-offload -j RETURN" "$(iptables -S OC-IMDS | grep -m1 '^-A')"
check "exception: once" 1 "$(iptables -S OC-IMDS | grep -c oc-offload)"
check "exception: deny still last" "-A OC-IMDS -j REJECT" "$(iptables -S OC-IMDS | tail -1)"
while read -r c; do sh -c "$c"; done < <(unit_execs "$ex" ExecStop)
check "exception: ExecStop removes it" 0 "$(iptables -S OC-IMDS | grep -c oc-offload)"

finish
