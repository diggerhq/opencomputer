#!/usr/bin/env bash
set -euo pipefail

# Deploy the opensandbox-gitserver binary to the EC2 control plane instance.
# Run from the repo root: ./deploy/ec2/deploy-gitserver.sh
#
# This script:
#   1. Cross-compiles the git server binary for Linux amd64
#   2. Uploads it to the EC2 instance (same host as control plane)
#   3. Installs the systemd service (first run only)
#   4. Restarts the git server service
#
# The git server runs alongside the control plane on the same instance
# because they share the same PostgreSQL database.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/opensandbox-digger.pem}"
SERVER_IP="${SERVER_IP:-3.135.246.117}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH="ssh -i $SSH_KEY $SSH_USER@$SERVER_IP"
SCP="scp -i $SSH_KEY"

cd "$REPO_ROOT"

echo "==> Building opensandbox-gitserver (linux/amd64)..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/opensandbox-gitserver-deploy ./cmd/gitserver/
echo "    Built: opensandbox-gitserver ($(du -h bin/opensandbox-gitserver-deploy | cut -f1), amd64)"

echo "==> Uploading binary to $SERVER_IP..."
$SCP bin/opensandbox-gitserver-deploy "$SSH_USER@$SERVER_IP:/tmp/opensandbox-gitserver"

echo "==> Installing binary..."
$SSH "sudo mv /tmp/opensandbox-gitserver /usr/local/bin/opensandbox-gitserver && \
      sudo chmod +x /usr/local/bin/opensandbox-gitserver"

# Install systemd service if not already present
$SSH "if [ ! -f /etc/systemd/system/opensandbox-gitserver.service ]; then
    echo '==> Installing systemd service (first run)...'
    sudo mkdir -p /data/opensandbox-repos
    sudo chown $SSH_USER:$SSH_USER /data/opensandbox-repos
fi"

echo "==> Uploading systemd service file..."
$SCP "$SCRIPT_DIR/opensandbox-gitserver.service" "$SSH_USER@$SERVER_IP:/tmp/opensandbox-gitserver.service"
$SSH "sudo mv /tmp/opensandbox-gitserver.service /etc/systemd/system/opensandbox-gitserver.service && \
      sudo systemctl daemon-reload && \
      sudo systemctl enable opensandbox-gitserver"

echo "==> Restarting git server service..."
$SSH "sudo systemctl restart opensandbox-gitserver"

echo "==> Waiting for git server to start..."
sleep 2
$SSH "sudo systemctl is-active opensandbox-gitserver"

echo "==> Deployed successfully!"
echo "    Binary:  /usr/local/bin/opensandbox-gitserver"
echo "    Service: opensandbox-gitserver.service"
echo "    Port:    3000"

# Cleanup
rm -f bin/opensandbox-gitserver-deploy
