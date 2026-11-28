#!/usr/bin/env bash
# Builds and publishes the build-offload MicroVM images, one per size tier,
# from computer/offload/builder (the pinned session image plus the build
# agent). Run it after creating the stack in selfhost/aws/offload.yaml, and
# again whenever the session image changes; an unchanged build is reused.
# Prints the selfhost.env lines for host-install.sh --enable-offload.
# Guide: docs/self-hosting/offload.mdx.
#
#   selfhost/aws/build-offload-image.sh --region R --bucket B --build-role-arn ARN [options]
#
#   --region R            the stack's region (the instance's region)
#   --bucket B            stack output OffloadBucket
#   --build-role-arn ARN  stack output BuildRoleArn
#   --session-image REF   ghcr.io/diggerhq/computer-session@sha256:<digest>
#                         [SP_IMAGE from /opt/slack-presence/current/.sp-version.env]
#   --tiers LIST          tier:baseline MiB [s:2048,m:8192]
#   --stack NAME          the stack name; tags images opencomputer:offload=NAME,
#                         which the instance policy requires [opencomputer-offload]
#   --base-image-arn ARN  Lambda-managed base image [the only one listed]
#   --base-image-version V                          [newest AVAILABLE for X86_64]
#   --dry-run             print the aws commands instead of running them
#
# Needs an AWS CLI that knows `lambda-microvms`, and credentials allowed by the
# stack's instance policy (on the instance) or an administrator's.

set -euo pipefail

log()  { printf '==> %s\n' "$*" >&2; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '/^#   selfhost/,/^#$/p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILDER="$REPO_ROOT/computer/offload/builder"
SESSION_REPOSITORY=ghcr.io/diggerhq/computer-session
VERSION_ENV=/opt/slack-presence/current/.sp-version.env
POLL_SECONDS=15 POLL_LIMIT_SECONDS=$((25 * 60))

REGION="" BUCKET="" BUILD_ROLE_ARN="" SESSION_IMAGE="" TIERS="s:2048,m:8192"
STACK=opencomputer-offload BASE_ARN="" BASE_VERSION="" DRY_RUN=0
while (($#)); do
  arg=$1 val=""
  case $arg in
    --*=*) val=${arg#*=} arg=${arg%%=*} ;;
    --dry-run) DRY_RUN=1; shift; continue ;;
    -h|--help) usage ;;
    --*) (($# >= 2)) || die "$arg needs a value"; val=$2; shift ;;
    *) usage 1 ;;
  esac
  shift
  case $arg in
    --region) REGION=$val ;;
    --bucket) BUCKET=$val ;;
    --build-role-arn) BUILD_ROLE_ARN=$val ;;
    --session-image) SESSION_IMAGE=$val ;;
    --tiers) TIERS=$val ;;
    --stack) STACK=$val ;;
    --base-image-arn) BASE_ARN=$val ;;
    --base-image-version) BASE_VERSION=$val ;;
    *) die "unknown option $arg (--help)" ;;
  esac
done

if [[ -z $SESSION_IMAGE && -r $VERSION_ENV ]]; then
  SESSION_IMAGE="$(sed -n 's/^SP_IMAGE=//p' "$VERSION_ENV")"
  log "session image from $VERSION_ENV: $SESSION_IMAGE"
fi

# Every value ends up in JSON or an ARN; checking shapes here keeps both safe.
[[ $REGION =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || die "--region: not a region: '$REGION'"
[[ $BUCKET =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "--bucket: not a bucket name: '$BUCKET'"
[[ $BUILD_ROLE_ARN =~ ^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$ ]] || die "--build-role-arn: not a role ARN: '$BUILD_ROLE_ARN'"
[[ $SESSION_IMAGE =~ ^${SESSION_REPOSITORY//./\\.}@sha256:[0-9a-f]{64}$ ]] \
  || die "--session-image must be $SESSION_REPOSITORY@sha256:<digest> (a pushed image; a local build or a tag cannot be pulled by the image build), not '$SESSION_IMAGE'"
[[ $TIERS =~ ^[a-z]+:[0-9]+(,[a-z]+:[0-9]+)*$ ]] || die "--tiers: expected tier:MiB[,tier:MiB...], not '$TIERS'"
[[ $STACK =~ ^[A-Za-z][A-Za-z0-9-]{0,127}$ ]] || die "--stack: not a stack name: '$STACK'"
[[ -z $BASE_ARN || $BASE_ARN =~ ^arn:aws[a-z-]*:[A-Za-z0-9:/._-]+$ ]] || die "--base-image-arn: not an ARN: '$BASE_ARN'"
[[ -z $BASE_VERSION || $BASE_VERSION =~ ^[A-Za-z0-9._-]+$ ]] || die "--base-image-version: '$BASE_VERSION'"
ABI="$(tr -d '[:space:]' < "$REPO_ROOT/computer/deploy/image/ABI")"
[[ $ABI =~ ^[0-9]+$ ]] || die "computer/deploy/image/ABI is not an integer"

AWS=(aws --region "$REGION")
# aws_q CMD...: runs aws (prints it under --dry-run, where it answers nothing).
aws_q() {
  if ((DRY_RUN)); then printf '+'; printf ' %q' "${AWS[@]}" "$@"; printf '\n'; return 0; fi
  "${AWS[@]}" "$@"
}

if ((!DRY_RUN)); then
  command -v aws >/dev/null || die "the AWS CLI is not installed"
  # Offline: `help` exits 255 without groff or mandoc, even when the CLI has the service.
  aws lambda-microvms list-microvms --generate-cli-skeleton >/dev/null 2>&1 || die "this AWS CLI does not know lambda-microvms; update it"
fi

# ---- stage and hash: the Dockerfile with the session image pinned, and the agent
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
sed "s|^ARG SESSION_IMAGE=.*|ARG SESSION_IMAGE=$SESSION_IMAGE|" "$BUILDER/Dockerfile" > "$STAGE/Dockerfile"
grep -qx "ARG SESSION_IMAGE=$SESSION_IMAGE" "$STAGE/Dockerfile" || die "could not pin SESSION_IMAGE in the Dockerfile"
cp "$BUILDER/agent.mjs" "$STAGE/agent.mjs"
HASH="$(cat "$STAGE/Dockerfile" "$STAGE/agent.mjs" | sha256sum | cut -c1-16)"
ZIP="$STAGE/$HASH.zip"
# A fixed mtime, so the same files make the same zip. Zip stores local time and
# nothing before 1980: 1980-01-02 UTC (not 01-01) is still 1980 in every zone,
# and the zip runs with TZ=UTC so its bytes do not depend on the box's zone.
touch -d @315619200 "$STAGE/Dockerfile" "$STAGE/agent.mjs"
# VERIFY: the service expects the Dockerfile at the zip's root (the spike's layout).
if command -v zip >/dev/null; then
  (cd "$STAGE" && TZ=UTC zip -X -q "$ZIP" Dockerfile agent.mjs)
else
  TZ=UTC python3 -I -c 'import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for p in sys.argv[2:]: z.write(p, p.rsplit("/", 1)[-1])' "$ZIP" "$STAGE/Dockerfile" "$STAGE/agent.mjs"
fi
URI="s3://$BUCKET/images/$HASH.zip"   # VERIFY: codeArtifact.uri takes the s3:// form
log "builder $HASH (session image ${SESSION_IMAGE##*@}, ABI $ABI, zip sha256 $(sha256sum "$ZIP" | cut -c1-16))"

log "upload $URI"
aws_q s3 cp "$ZIP" "$URI" --only-show-errors

# ---- base image: Lambda-managed, X86_64 (the session's artifacts are amd64)
if [[ -z $BASE_ARN ]]; then
  if ((DRY_RUN)); then
    aws_q lambda-microvms list-managed-microvm-images --query 'items[].imageArn' --output text
    BASE_ARN='<base-image-arn>'
  else
    mapfile -t arns < <(aws_q lambda-microvms list-managed-microvm-images --query 'items[].imageArn' --output text | tr '\t' '\n' | sed '/^$/d')
    ((${#arns[@]} == 1)) || die "found ${#arns[@]} managed base images; choose one with --base-image-arn: ${arns[*]}"
    BASE_ARN=${arns[0]}
  fi
fi
if [[ -z $BASE_VERSION ]]; then
  q="items[?status=='AVAILABLE' && contains(supportedCpuConfigurations[].architecture, 'X86_64')].imageVersion"
  if ((DRY_RUN)); then
    aws_q lambda-microvms list-managed-microvm-image-versions --image-identifier "$BASE_ARN" --query "$q" --output text
    BASE_VERSION='<base-image-version>'
  else
    BASE_VERSION="$(aws_q lambda-microvms list-managed-microvm-image-versions --image-identifier "$BASE_ARN" --query "$q" --output text | tr '\t' '\n' | sed '/^$/d' | sort -V | tail -1)"
    [[ -n $BASE_VERSION ]] || die "no AVAILABLE X86_64 version of $BASE_ARN in $REGION"
  fi
fi
# x86_64 needs base image version 3 or later (AWS docs). VERIFY: the version format.
[[ $BASE_VERSION =~ ^[0-9]+ ]] && ((${BASE_VERSION%%[!0-9]*} < 3)) && die "base image version $BASE_VERSION is below 3, which X86_64 needs"
log "base image $BASE_ARN version $BASE_VERSION"

# image_input TIER MIB: the request body shared by create and update.
image_input() {
  printf '"baseImageArn":"%s","baseImageVersion":"%s","buildRoleArn":"%s","description":"OpenComputer build offload, tier %s (%s MiB), builder %s",' \
    "$BASE_ARN" "$BASE_VERSION" "$BUILD_ROLE_ARN" "$1" "$2" "$HASH"
  printf '"codeArtifact":{"uri":"%s"},"cpuConfigurations":[{"architecture":"X86_64"}],"resources":[{"minimumMemoryInMiB":%s}],"clientToken":"%s"' \
    "$URI" "$2" "$(client_token "$1")"
}

# client_token TIER: Lambda remembers a clientToken after the image is deleted,
# so a token reused with other parameters (a re-created stack's build role, a
# newer base image) is refused. The hash of those makes it theirs; at most 64
# characters.
client_token() {
  printf 'oc-offload-%s-%s-%s-%s' "$1" "$ABI" "$HASH" \
    "$(printf '%s|%s|%s|%s' "$BUILD_ROLE_ARN" "$BASE_ARN" "$BASE_VERSION" "$URI" | sha256sum | cut -c1-12)"
}

# Get, List and Update take the image's ARN, not its name (Create takes the name).
if ((DRY_RUN)); then
  PARTITION=aws ACCOUNT="<account>"
else
  read -r ACCOUNT CALLER < <(aws_q sts get-caller-identity --query '[Account,Arn]' --output text)
  PARTITION="$(cut -d: -f2 <<<"$CALLER")"
fi

declare -A ARN VERSION
IFS=, read -r -a tiers <<< "$TIERS"
for t in "${tiers[@]}"; do
  tier=${t%%:*} mib=${t#*:}
  name="oc-offload-$tier-$ABI"   # the instance policy allows only oc-offload-*
  ident="arn:$PARTITION:lambda:$REGION:$ACCOUNT:microvm-image:$name"
  if ((DRY_RUN)); then
    aws_q lambda-microvms get-microvm-image --image-identifier "$ident" --query imageArn --output text
    echo "# if $name does not exist:"
    aws_q lambda-microvms create-microvm-image --cli-input-json \
      "{\"name\":\"$name\",$(image_input "$tier" "$mib"),\"tags\":{\"opencomputer:offload\":\"$STACK\",\"opencomputer:release\":\"$HASH\"}}"
    echo "# else, unless a version already has codeArtifact $URI:"
    aws_q lambda-microvms list-microvm-image-versions --image-identifier "$ident" \
      --query "items[?codeArtifact.uri=='$URI' && state!='FAILED'].[imageVersion,state]" --output text
    aws_q lambda-microvms update-microvm-image --cli-input-json "{\"imageIdentifier\":\"$ident\",$(image_input "$tier" "$mib")}"
    ARN[$tier]="<imageArn of $name>" VERSION[$tier]="<imageVersion>"
    continue
  fi

  if out="$(aws_q lambda-microvms get-microvm-image --image-identifier "$ident" --query imageArn --output text 2>&1)"; then
    ARN[$tier]=$out
    have="$(aws_q lambda-microvms list-microvm-image-versions --image-identifier "$ident" \
      --query "items[?codeArtifact.uri=='$URI' && state!='FAILED'].imageVersion | [0]" --output text)"
    if [[ -n $have && $have != None ]]; then
      log "$name: builder $HASH is already version $have"
      VERSION[$tier]=$have
      continue
    fi
    log "$name: new version ($mib MiB)"
    read -r "ARN[$tier]" "VERSION[$tier]" < <(aws_q lambda-microvms update-microvm-image \
      --cli-input-json "{\"imageIdentifier\":\"$ident\",$(image_input "$tier" "$mib")}" --query '[imageArn,imageVersion]' --output text)
  elif [[ $out == *ResourceNotFoundException* ]]; then
    log "$name: create ($mib MiB)"
    read -r "ARN[$tier]" "VERSION[$tier]" < <(aws_q lambda-microvms create-microvm-image --cli-input-json \
      "{\"name\":\"$name\",$(image_input "$tier" "$mib"),\"tags\":{\"opencomputer:offload\":\"$STACK\",\"opencomputer:release\":\"$HASH\"}}" \
      --query '[imageArn,imageVersion]' --output text)
  else
    die "$name: $out"
  fi
done

# ---- wait for every tier's version (the spike saw 3.5-4.5 min per build)
if ((DRY_RUN)); then
  echo "# then poll every ${POLL_SECONDS}s until SUCCESSFUL, per tier:"
  aws_q lambda-microvms get-microvm-image-version --image-identifier "arn:$PARTITION:lambda:$REGION:$ACCOUNT:microvm-image:oc-offload-${tiers[0]%%:*}-$ABI" \
    --image-version '<imageVersion>' --query '[state,stateReason]' --output text
else
  deadline=$((SECONDS + POLL_LIMIT_SECONDS))
  pending=("${tiers[@]%%:*}")
  while ((${#pending[@]})); do
    left=()
    for tier in "${pending[@]}"; do
      read -r state reason < <(aws_q lambda-microvms get-microvm-image-version --image-identifier "${ARN[$tier]}" \
        --image-version "${VERSION[$tier]}" --query '[state,stateReason]' --output text)
      case $state in
        SUCCESSFUL) log "tier $tier: version ${VERSION[$tier]} built" ;;
        PENDING|IN_PROGRESS) left+=("$tier") ;;
        *) die "tier $tier: version ${VERSION[$tier]} is $state: $reason (aws lambda-microvms list-microvm-image-builds --image-identifier ${ARN[$tier]} --image-version ${VERSION[$tier]})" ;;
      esac
    done
    pending=("${left[@]}")
    ((${#pending[@]})) || break
    ((SECONDS < deadline)) || die "still building after $((POLL_LIMIT_SECONDS / 60)) min: ${pending[*]}"
    log "building: ${pending[*]}"
    sleep "$POLL_SECONDS"
  done
fi

echo
echo "# add to /etc/opencomputer/selfhost.env, then host-install.sh --enable-offload:"
for t in "${tiers[@]}"; do
  tier=${t%%:*}
  printf 'SP_OFFLOAD_IMAGE_%s=%s\n' "${tier^^}" "${ARN[$tier]}"
  printf '# version %s, builder %s\n' "${VERSION[$tier]}" "$HASH"
done
