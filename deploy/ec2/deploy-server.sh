#!/usr/bin/env bash
set -euo pipefail

# Deploy the opensandbox-server binary to the EC2 control plane instance.
# Run from the repo root: ./deploy/ec2/deploy-server.sh
#
# This script:
#   1. Cross-compiles the server binary for Linux amd64 (t3.small)
#   2. Uploads it to the EC2 instance
#   3. Installs and restarts the server service

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/opensandbox-digger.pem}"
SERVER_IP="${SERVER_IP:-3.135.246.117}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH="ssh -i $SSH_KEY $SSH_USER@$SERVER_IP"
SCP="scp -i $SSH_KEY"

cd "$REPO_ROOT"

echo "==> Building opensandbox-server (linux/amd64)..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/opensandbox-server-deploy ./cmd/server/
echo "    Built: opensandbox-server ($(du -h bin/opensandbox-server-deploy | cut -f1), amd64)"

echo "==> Uploading binary to $SERVER_IP..."
$SCP bin/opensandbox-server-deploy "$SSH_USER@$SERVER_IP:/tmp/opensandbox-server"

echo "==> Installing binary..."
$SSH "sudo mv /tmp/opensandbox-server /usr/local/bin/opensandbox-server && \
      sudo chmod +x /usr/local/bin/opensandbox-server"

echo "==> Restarting server service..."
$SSH "sudo systemctl restart opensandbox-server"

echo "==> Waiting for server to start..."
sleep 2
$SSH "sudo systemctl is-active opensandbox-server"

echo "==> Deployed successfully!"
echo "    Server: /usr/local/bin/opensandbox-server"

# Cleanup
rm -f bin/opensandbox-server-deploy
