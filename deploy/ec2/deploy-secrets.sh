#!/usr/bin/env bash
set -euo pipefail

# Deploy the opensandbox-secrets binary to the EC2 control plane instance.
# Run from the repo root: ./deploy/ec2/deploy-secrets.sh
#
# This script:
#   1. Cross-compiles the secrets service binary for Linux amd64
#   2. Uploads it to the EC2 instance (same host as control plane)
#   3. Installs the systemd service (first run only)
#   4. Restarts the secrets service
#
# The secrets service runs alongside the control plane on the same instance
# because they share the same PostgreSQL database.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/opensandbox-digger.pem}"
SERVER_IP="${SERVER_IP:-3.135.246.117}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH="ssh -i $SSH_KEY $SSH_USER@$SERVER_IP"
SCP="scp -i $SSH_KEY"

cd "$REPO_ROOT"

echo "==> Building opensandbox-secrets (linux/amd64)..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/opensandbox-secrets-deploy ./cmd/secrets-server/
echo "    Built: opensandbox-secrets ($(du -h bin/opensandbox-secrets-deploy | cut -f1), amd64)"

echo "==> Uploading binary to $SERVER_IP..."
$SCP bin/opensandbox-secrets-deploy "$SSH_USER@$SERVER_IP:/tmp/opensandbox-secrets"

echo "==> Installing binary..."
$SSH "sudo mv /tmp/opensandbox-secrets /usr/local/bin/opensandbox-secrets && \
      sudo chmod +x /usr/local/bin/opensandbox-secrets"

echo "==> Uploading systemd service file..."
$SCP "$SCRIPT_DIR/opensandbox-secrets.service" "$SSH_USER@$SERVER_IP:/tmp/opensandbox-secrets.service"
$SSH "sudo mv /tmp/opensandbox-secrets.service /etc/systemd/system/opensandbox-secrets.service && \
      sudo systemctl daemon-reload && \
      sudo systemctl enable opensandbox-secrets"

echo "==> Restarting secrets service..."
$SSH "sudo systemctl restart opensandbox-secrets"

echo "==> Waiting for secrets service to start..."
sleep 2
$SSH "sudo systemctl is-active opensandbox-secrets"

echo "==> Deployed successfully!"
echo "    Binary:  /usr/local/bin/opensandbox-secrets"
echo "    Service: opensandbox-secrets.service"
echo "    Port:    9095 (gRPC)"

# Cleanup
rm -f bin/opensandbox-secrets-deploy
