# shellcheck shell=bash
# selfhost/lib/aws-detect.sh: is this host an EC2 instance with a role attached?
# Sourced by host-install.sh for --enable-offload, and on every install where
# build offload is enabled; or run it: `sudo bash selfhost/lib/aws-detect.sh`.
# aws_detect prints one line and returns
#   0  aws <region> <instance-id> <role-name>
#   1  not-aws: <reason>
#   2  aws-no-role <region> <instance-id>
# It reads DMI (a veto for Azure and GCP, a hint for EC2), then asks the
# metadata service for an IMDSv2 token (PUT, 2 s timeout), the instance
# identity document (checked for shape) and the role listing. It never reads
# security-credentials/<role>, so it never sees or prints a credential.
# Runs as root: board_asset_tag and product_uuid are root-only, and on a
# self-host opencomputer-imds-deny.service denies the metadata service to
# every other user. OC_IMDS, OC_DMI and OC_CURL exist for the tests' fakes.
# Plan: work/136 section 3.

OC_IMDS="${OC_IMDS:-http://169.254.169.254}"
OC_DMI="${OC_DMI:-/sys/class/dmi/id}"
OC_CURL="${OC_CURL:-curl}"

aws_dmi() {   # prints aws | veto:<vendor> | unknown
  local v p a u b
  v="$(cat "$OC_DMI/sys_vendor" 2>/dev/null || true)"
  p="$(cat "$OC_DMI/product_name" 2>/dev/null || true)"
  a="$(cat "$OC_DMI/board_asset_tag" 2>/dev/null || true)"
  u="$(cat "$OC_DMI/product_uuid" 2>/dev/null || true)"
  b="$(cat "$OC_DMI/bios_version" 2>/dev/null || true)"
  if [[ $v == "Microsoft Corporation" || $v == *Google* || $p == *Google* ]]; then
    echo "veto:${v:-$p}"; return
  fi
  if [[ $v == *"Amazon EC2"* || $p == *"Amazon EC2"* || $a == i-* || ${u,,} == ec2* || ${b,,} == *amazon* ]]; then
    echo aws; return
  fi
  echo unknown
}

aws_imds() {  # aws_imds <token> <path>: the body, or fail
  "$OC_CURL" -fsS -m 2 -H "X-aws-ec2-metadata-token: $1" "$OC_IMDS$2" 2>/dev/null
}

aws_detect() {
  local dmi tok doc iid region acct role
  dmi="$(aws_dmi)"
  if [[ $dmi == veto:* ]]; then echo "not-aws: DMI reports '${dmi#veto:}'"; return 1; fi
  tok="$("$OC_CURL" -fsS -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
          "$OC_IMDS/latest/api/token" 2>/dev/null)" || tok=""
  if [[ ! $tok =~ ^[A-Za-z0-9_=+/-]{20,}$ ]]; then
    if [[ $dmi == aws ]]; then
      echo "not-aws: EC2 by DMI but IMDSv2 is unreachable (set HttpEndpoint=enabled, HttpTokens=required)"; return 1
    fi
    echo "not-aws: no EC2 metadata service"; return 1
  fi
  doc="$(aws_imds "$tok" /latest/dynamic/instance-identity/document)" || doc=""
  iid="$(jq -r '.instanceId // empty' <<<"$doc" 2>/dev/null)" || iid=""
  region="$(jq -r '.region // empty' <<<"$doc" 2>/dev/null)" || region=""
  acct="$(jq -r '.accountId // empty' <<<"$doc" 2>/dev/null)" || acct=""
  if [[ ! $iid =~ ^i-[0-9a-f]{8,17}$ || ! $region =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ || ! $acct =~ ^[0-9]{12}$ ]]; then
    echo "not-aws: metadata service answered, but not with an EC2 identity document"; return 1
  fi
  role="$(aws_imds "$tok" /latest/meta-data/iam/security-credentials/ | head -n1 | tr -d '[:space:]')" || role=""
  if [[ ! $role =~ ^[A-Za-z0-9+=,.@_-]{1,128}$ ]]; then echo "aws-no-role $region $iid"; return 2; fi
  [[ $dmi == aws ]] || printf 'WARNING: %s\n' "EC2 identity confirmed but DMI did not say so; continuing" >&2
  echo "aws $region $iid $role"
}

# Run as a script: print the line, exit with its code.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then aws_detect; exit $?; fi
