#!/usr/bin/env bash
# rclone-azure-to-tigris.sh
#
# One-shot copy of the prod checkpoints container from Azure Blob to Tigris.
# Run with --dry-run first to confirm the planned transfer.
#
# Required env vars:
#   AZURE_STORAGE_ACCOUNT       e.g. occkpt3ccf3c31
#   AZURE_STORAGE_KEY           az storage account keys list -g opencomputer-prod \
#                                 -n occkpt3ccf3c31 --query "[0].value" -o tsv
#   TIGRIS_ACCESS_KEY_ID
#   TIGRIS_SECRET_ACCESS_KEY
#
# Optional:
#   SRC_CONTAINER               default: checkpoints
#   TIGRIS_BUCKET               default: opencomputer-prod
#   TIGRIS_ENDPOINT             default: https://t3.storage.dev
#
# Use rclone copy (not sync) — never deletes from destination. Safe to re-run;
# subsequent runs only transfer keys that changed (delta sync).
#
# Best run from a VM in eastus2 (same region as source storage account).

set -euo pipefail

: "${AZURE_STORAGE_ACCOUNT:?required}"
: "${AZURE_STORAGE_KEY:?required}"
: "${TIGRIS_ACCESS_KEY_ID:?required}"
: "${TIGRIS_SECRET_ACCESS_KEY:?required}"

SRC_CONTAINER="${SRC_CONTAINER:-checkpoints}"
TIGRIS_BUCKET="${TIGRIS_BUCKET:-opencomputer-prod}"
TIGRIS_ENDPOINT="${TIGRIS_ENDPOINT:-https://t3.storage.dev}"

export RCLONE_CONFIG_AZ_TYPE=azureblob
export RCLONE_CONFIG_AZ_ACCOUNT="$AZURE_STORAGE_ACCOUNT"
export RCLONE_CONFIG_AZ_KEY="$AZURE_STORAGE_KEY"

export RCLONE_CONFIG_TIGRIS_TYPE=s3
export RCLONE_CONFIG_TIGRIS_PROVIDER=Other
export RCLONE_CONFIG_TIGRIS_ENDPOINT="$TIGRIS_ENDPOINT"
export RCLONE_CONFIG_TIGRIS_REGION=auto
export RCLONE_CONFIG_TIGRIS_ACCESS_KEY_ID="$TIGRIS_ACCESS_KEY_ID"
export RCLONE_CONFIG_TIGRIS_SECRET_ACCESS_KEY="$TIGRIS_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_TIGRIS_FORCE_PATH_STYLE=true

LOGFILE="${LOGFILE:-rclone-az-to-tigris-$(date +%Y%m%d-%H%M%S).log}"

echo "==> $(date)  rclone copy az:$SRC_CONTAINER -> tigris:$TIGRIS_BUCKET"
echo "    log: $LOGFILE"
echo "    args: $*"

# --transfers 16: parallel file transfers
# --checkers 32: parallel existence checks
# --multi-thread-streams 8 with cutoff 256M: parallelize large goldens (4GB)
# --s3-chunk-size 64M: fewer S3 ops per big file
# --progress + --stats: live visibility
rclone copy \
  "az:$SRC_CONTAINER" \
  "tigris:$TIGRIS_BUCKET" \
  --transfers 16 \
  --checkers 32 \
  --multi-thread-streams 8 \
  --multi-thread-cutoff 256M \
  --s3-chunk-size 64M \
  --s3-upload-concurrency 4 \
  --progress \
  --stats 30s \
  --stats-one-line \
  --log-level INFO \
  --log-file "$LOGFILE" \
  "$@"

echo "==> $(date)  done"
