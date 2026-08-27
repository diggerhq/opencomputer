#!/usr/bin/env bash
# Publish (create or update) the MicroVM image resource from an uploaded artifact.
#
# Split out from build.sh because the image resource carries configuration the
# artifact alone cannot express — the hook port, which hooks are enabled, and the
# CPU architecture. Getting any of those wrong fails the build with a bare
# CREATE_FAILED: no stateReason, and no CloudWatch log group, because the build
# never reaches the point of running the Dockerfile. Keeping the invocation in a
# script rather than in copy-paste instructions is what stops that recurring.
#
#   ./deploy/microvm/publish.sh s3://bucket/agent-image.zip
#
# Size tiers: memory is a property of the IMAGE, so each tier is its own image
# published from the SAME artifact with a different name and memory. Only the
# default tier is pooled; the rest cold-launch.
#
#   MICROVM_IMAGE_NAME=opensandbox-agent-dev-8192 \
#   MICROVM_IMAGE_MEMORY_MB=8192 \
#     ./deploy/microvm/publish.sh s3://bucket/agent-image.zip
#
# Then point the cell at them:
#   OPENSANDBOX_MICROVM_SIZE_IMAGES="8192=arn:...:microvm-image:opensandbox-agent-dev-8192"
set -euo pipefail

DEST="${1:-}"
if [[ -z "$DEST" ]]; then
  echo "usage: $0 s3://bucket/key.zip" >&2
  exit 2
fi

REGION="${AWS_REGION:-us-east-1}"
NAME="${MICROVM_IMAGE_NAME:-opensandbox-agent-dev}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
IMAGE_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:microvm-image:${NAME}"
BASE_IMAGE_ARN="${MICROVM_BASE_IMAGE_ARN:-arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1}"
BUILD_ROLE_ARN="${MICROVM_BUILD_ROLE_ARN:-arn:aws:iam::${ACCOUNT}:role/opensandbox-microvm-build}"

# The hook contract, mirroring cmd/microvm-hooks. Lambda will not call a hook we
# do not declare here, so an undeclared /ready means nothing ever signals that
# the image is safe to snapshot.
#
# Timeouts: run/resume are on the customer's critical path and capped at 60s by
# the API, so they are kept tight — a box that cannot produce a live agent in
# 20s is broken, and failing fast is better than admitting traffic to it. The
# build-time hooks get far longer because /validate deliberately exercises the
# exec path to drive snapshot-region prefetch.
HOOKS=$(cat <<'JSON'
{
  "port": 8080,
  "microvmHooks": {
    "run": "ENABLED",
    "runTimeoutInSeconds": 30,
    "resume": "ENABLED",
    "resumeTimeoutInSeconds": 30,
    "suspend": "ENABLED",
    "suspendTimeoutInSeconds": 30,
    "terminate": "ENABLED",
    "terminateTimeoutInSeconds": 30
  },
  "microvmImageHooks": {
    "ready": "ENABLED",
    "readyTimeoutInSeconds": 300,
    "validate": "ENABLED",
    "validateTimeoutInSeconds": 300
  }
}
JSON
)

# ARM_64 is the only architecture Lambda MicroVMs accepts. build.sh cross-compiles
# to match; stating it explicitly here keeps the two from drifting apart silently.
CPU='[{"architecture":"ARM_64"}]'

# Memory is the ONLY sizing knob this platform has, and it lives here rather
# than at launch: RunMicrovmInput carries no memory or vCPU field, so a size
# tier IS an image. Offering N sizes means publishing N images and selecting one
# per create (see awsvm.Config.SizeImages).
#
# 2048 MiB is the smallest baseline that still gets a full vCPU under Lambda's
# baseline-peak model, and peak scales to 4x it. Keep that as the floor: below
# it a box may not get a full vCPU, and there is no way to ask for one.
#
# There is deliberately no vCPU setting to mirror. cpu-configurations carries an
# architecture and nothing else; CPU is allocated as a function of memory.
MEMORY_MB="${MICROVM_IMAGE_MEMORY_MB:-2048}"
if (( MEMORY_MB < 2048 )); then
  echo "warning: ${MEMORY_MB}MiB is below the 2048 baseline — this tier may not get a full vCPU" >&2
fi
RESOURCES="[{\"minimumMemoryInMiB\":${MEMORY_MB}}]"

# Name the log group explicitly so build failures are greppable at a known path
# instead of wherever the service would otherwise default.
LOGGING="{\"cloudWatch\":{\"logGroup\":\"/aws/lambda/microvms/${NAME}\"}}"

common=(
  --code-artifact "uri=${DEST}"
  --base-image-arn "$BASE_IMAGE_ARN"
  --build-role-arn "$BUILD_ROLE_ARN"
  --hooks "$HOOKS"
  --cpu-configurations "$CPU"
  --resources "$RESOURCES"
  --logging "$LOGGING"
  --region "$REGION"
)

# Only ever create or update the image we own, identified by our own name. This
# account is shared with a customer-serving workload; nothing here enumerates or
# touches an image it did not create.
if aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --region "$REGION" >/dev/null 2>&1; then
  echo "updating existing image ${NAME}…"
  # base-image-arn and build-role-arn are required on every update, even when
  # only the artifact changed — omitting them is a ValidationException.
  aws lambda-microvms update-microvm-image --image-identifier "$IMAGE_ARN" "${common[@]}"
else
  echo "creating image ${NAME}…"
  aws lambda-microvms create-microvm-image --name "$NAME" "${common[@]}"
fi

echo
echo "build is asynchronous; polling until it leaves CREATING…"
while true; do
  state="$(aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --region "$REGION" \
    --query 'state' --output text 2>/dev/null || echo UNKNOWN)"
  echo "  state=${state}"
  case "$state" in
    # CREATED is a first build; UPDATED is every subsequent one. Both mean the
    # build finished — check latestActiveImageVersion for what to actually run.
    CREATED|UPDATED|ACTIVE)
      echo "image ready: ${IMAGE_ARN}"
      aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --region "$REGION" \
        --query '{active:latestActiveImageVersion,failed:latestFailedImageVersion}'
      exit 0 ;;
    *FAILED*)
      echo "build FAILED — reason (if any) and logs:" >&2
      aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --region "$REGION" >&2 || true
      aws logs tail "/aws/lambda/microvms/${NAME}" --since 30m --region "$REGION" >&2 || \
        echo "  (no log group — the build failed before running the Dockerfile)" >&2
      exit 1 ;;
  esac
  sleep 15
done
