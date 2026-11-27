#!/usr/bin/env bash
# selfhost/lib/aws-detect.sh against fake DMI directories and a fake curl
# (selfhost/test/bin/fake-curl): the line it prints and its exit code for
# Azure, GCP, bare metal, EC2 in its shapes, and imposters; and that no case
# reads a credential. bash selfhost/test/aws-detect.test.sh
set -uo pipefail
# shellcheck source=selfhost/test/lib.sh
source "$(dirname "$0")/lib.sh"

TOKEN=AQAEAFakeTokenForTests0123456789abcdef==
DOC='{"accountId":"123456789012","architecture":"x86_64","availabilityZone":"us-east-1a","imageId":"ami-0abcdef1234567890","instanceId":"i-0123456789abcdef0","instanceType":"m7i.large","privateIp":"10.0.0.5","region":"us-east-1","version":"2017-09-30"}'

# scenario: a fresh fake DMI dir and fake metadata service.
scenario() {
  FAKE_CURL="$(mktemp -d)" OC_DMI="$(mktemp -d)"; export FAKE_CURL
  : >"$FAKE_CURL/calls"
}
dmi() { printf '%s\n' "$2" >"$OC_DMI/$1"; }
imds() { printf '%s' "$3" >"$FAKE_CURL/$1${2//\//_}"; [[ -z ${4:-} ]] || echo "$4" >"$FAKE_CURL/$1${2//\//_}.code"; }
ec2_imds() {   # a real-looking EC2 metadata service; role optional
  imds PUT /latest/api/token "$TOKEN"
  imds GET /latest/dynamic/instance-identity/document "$DOC"
  if [[ -n ${1:-} ]]; then imds GET /latest/meta-data/iam/security-credentials/ "$1"
  else imds GET /latest/meta-data/iam/security-credentials/ '<?xml version="1.0"?><Error><Code>NotFound</Code></Error>' 404; fi
  # What the detector must never ask for.
  imds GET "/latest/meta-data/iam/security-credentials/${1:-x}" '{"AccessKeyId":"AKIAFAKE","SecretAccessKey":"fake-secret","Token":"fake-session"}'
}
detect() {   # runs it as a script, as root would; sets OUT and RC
  OUT="$(OC_DMI="$OC_DMI" OC_CURL="$TEST_DIR/bin/fake-curl" OC_IMDS=http://169.254.169.254 \
          bash "$SELFHOST/lib/aws-detect.sh" 2>"$FAKE_CURL/stderr")"; RC=$?
}
never_creds() {
  check "$1: no credential requested" "" "$(grep -E 'security-credentials/.+' "$FAKE_CURL/calls")"
  check_lacks "$1: no secret printed" "fake-secret" "$OUT$(cat "$FAKE_CURL/stderr")"
  rm -rf "$FAKE_CURL" "$OC_DMI"
}

# Azure: DMI veto, before any request (the IMDS there would answer 400 without Metadata: true).
scenario; dmi sys_vendor "Microsoft Corporation"; dmi product_name "Virtual Machine"
imds PUT /latest/api/token '{"error":"Bad request. Required metadata header not specified"}' 400
detect
check "azure: exit 1" 1 "$RC"
check "azure: line" "not-aws: DMI reports 'Microsoft Corporation'" "$OUT"
check "azure: no request at all" "" "$(cat "$FAKE_CURL/calls")"
never_creds azure

# Azure DMI hidden (a container): the PUT gets a 400, so no token.
scenario
imds PUT /latest/api/token '{"error":"Bad request. Required metadata header not specified"}' 400
detect
check "azure without DMI: exit 1" 1 "$RC"
check "azure without DMI: line" "not-aws: no EC2 metadata service" "$OUT"
never_creds "azure without DMI"

# GCP: DMI veto (the metadata server would refuse the PUT, 403, without Metadata-Flavor).
scenario; dmi sys_vendor Google; dmi product_name "Google Compute Engine"
imds PUT /latest/api/token 'Forbidden' 403
detect
check "gcp: exit 1" 1 "$RC"
check "gcp: line" "not-aws: DMI reports 'Google'" "$OUT"
check "gcp: no request at all" "" "$(cat "$FAKE_CURL/calls")"
never_creds gcp

# GCP with only product_name.
scenario; dmi product_name "Google Compute Engine"
detect
check "gcp product_name: veto" "1 not-aws: DMI reports 'Google Compute Engine'" "$RC $OUT"
never_creds "gcp product_name"

# Bare metal: nothing at the address (connection refused) or a timeout.
scenario; dmi sys_vendor "Dell Inc."; dmi product_name "PowerEdge R650"
detect
check "bare metal: exit 1" 1 "$RC"
check "bare metal: line" "not-aws: no EC2 metadata service" "$OUT"
never_creds "bare metal"
scenario; dmi sys_vendor QEMU; touch "$FAKE_CURL/timeout"
detect
check "local VM, timeout: not-aws" "1 not-aws: no EC2 metadata service" "$RC $OUT"
never_creds "local VM"

# EC2 with IMDS disabled or hop-limited: DMI says EC2, no token.
scenario; dmi sys_vendor "Amazon EC2"; dmi product_name m7i.large
detect
check "ec2 imds off: exit 1" 1 "$RC"
check_has "ec2 imds off: line with the fix" "not-aws: EC2 by DMI but IMDSv2 is unreachable" "$OUT"
never_creds "ec2 imds off"

# EC2 without a role.
scenario; dmi sys_vendor "Amazon EC2"; ec2_imds ""
detect
check "ec2 no role: exit 2" 2 "$RC"
check "ec2 no role: line" "aws-no-role us-east-1 i-0123456789abcdef0" "$OUT"
never_creds "ec2 no role"

# EC2 with an empty listing (200, no body).
scenario; dmi sys_vendor "Amazon EC2"; ec2_imds ""; imds GET /latest/meta-data/iam/security-credentials/ ""
rm -f "$FAKE_CURL/GET_latest_meta-data_iam_security-credentials_.code"
detect
check "ec2 empty listing: exit 2" 2 "$RC"
never_creds "ec2 empty listing"

# EC2 (Nitro) with a role.
scenario; dmi sys_vendor "Amazon EC2"; dmi product_name m7i.large; dmi board_asset_tag i-0123456789abcdef0
ec2_imds oc-host-role
detect
check "ec2 ok: exit 0" 0 "$RC"
check "ec2 ok: line" "aws us-east-1 i-0123456789abcdef0 oc-host-role" "$OUT"
check "ec2 ok: no warning" "" "$(cat "$FAKE_CURL/stderr")"
check "ec2 ok: exactly token, document, listing" \
  $'PUT /latest/api/token\nGET /latest/dynamic/instance-identity/document\nGET /latest/meta-data/iam/security-credentials/' \
  "$(cat "$FAKE_CURL/calls")"
never_creds "ec2 ok"

# EC2 (old Xen) with a role: DMI by bios_version.
scenario; dmi sys_vendor Xen; dmi product_name "HVM domU"; dmi bios_version 4.11.amazon
ec2_imds oc-host-role
detect
check "ec2 xen: aws" "0 aws us-east-1 i-0123456789abcdef0 oc-host-role" "$RC $OUT"
never_creds "ec2 xen"

# Identity confirmed, DMI silent (new family): aws, with a warning.
scenario; dmi sys_vendor "Some Vendor"; ec2_imds oc-host-role
detect
check "unknown DMI: aws" "0 aws us-east-1 i-0123456789abcdef0 oc-host-role" "$RC $OUT"
check_has "unknown DMI: warning" "DMI did not say so" "$(cat "$FAKE_CURL/stderr")"
never_creds "unknown DMI"

# Imposters: something answers the PUT, but it is not EC2's metadata service.
scenario; imds PUT /latest/api/token "$TOKEN"; imds GET /latest/dynamic/instance-identity/document '{"instanceId":"vm-1"}'
detect
check "imposter document: not-aws" "1 not-aws: metadata service answered, but not with an EC2 identity document" "$RC $OUT"
never_creds "imposter document"
scenario; imds PUT /latest/api/token '<html><body>proxy</body></html>'
detect
check "garbage token: not-aws" "1 not-aws: no EC2 metadata service" "$RC $OUT"
never_creds "garbage token"
scenario; imds PUT /latest/api/token "$TOKEN"; imds GET /latest/dynamic/instance-identity/document 'instanceId: i-0123456789abcdef0'
detect
check "document not JSON: not-aws" 1 "$RC"
never_creds "document not JSON"
scenario; imds PUT /latest/api/token "$TOKEN"; imds GET /latest/dynamic/instance-identity/document "${DOC/123456789012/12345}"
detect
check "bad account id: not-aws" 1 "$RC"
never_creds "bad account id"

# Sourced, as host-install.sh does: the function, no output on source.
check "sourcing prints nothing" "" "$(bash -c "source '$SELFHOST/lib/aws-detect.sh'")"

finish
