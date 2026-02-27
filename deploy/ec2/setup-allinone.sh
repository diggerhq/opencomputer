#!/usr/bin/env bash
set -euo pipefail

# Provision a t4g instance as an all-in-one OpenSandbox dev/test environment.
# Runs: control plane (server) + Firecracker worker + git server + PostgreSQL
#
# Usage: ssh -i key.pem ubuntu@<IP> 'bash -s' < deploy/ec2/setup-allinone.sh

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  GOARCH="amd64"; FC_ARCH="x86_64" ;;
  aarch64) GOARCH="arm64"; FC_ARCH="aarch64" ;;
  *)       echo "ERROR: Unsupported architecture: $ARCH"; exit 1 ;;
esac
echo "==> All-in-one setup ($ARCH)"

echo "==> Updating packages..."
sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

# -------------------------------------------------------------------
# PostgreSQL
# -------------------------------------------------------------------
echo "==> Installing PostgreSQL..."
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-client
sudo systemctl enable postgresql
sudo systemctl start postgresql

echo "==> Creating opensandbox database and user..."
sudo -u postgres psql -c "CREATE USER opensandbox WITH PASSWORD 'opensandbox';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE opensandbox OWNER opensandbox;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE opensandbox TO opensandbox;" 2>/dev/null || true

# Allow local password auth
sudo sed -i 's/^local.*all.*all.*peer$/local   all             all                                     md5/' /etc/postgresql/*/main/pg_hba.conf
echo "host    all             all             127.0.0.1/32            md5" | sudo tee -a /etc/postgresql/*/main/pg_hba.conf > /dev/null
sudo systemctl restart postgresql

# -------------------------------------------------------------------
# Firecracker
# -------------------------------------------------------------------
echo "==> Installing Firecracker..."
FC_VERSION="v1.9.1"
FC_RELEASE="firecracker-${FC_VERSION}-${FC_ARCH}"
FC_URL="https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/${FC_RELEASE}.tgz"

cd /tmp
curl -fSL -o firecracker.tgz "$FC_URL"
tar xzf firecracker.tgz
sudo cp "release-${FC_VERSION}-${FC_ARCH}/firecracker-${FC_VERSION}-${FC_ARCH}" /usr/local/bin/firecracker
sudo chmod +x /usr/local/bin/firecracker
rm -rf firecracker.tgz "release-${FC_VERSION}-${FC_ARCH}"
cd /
firecracker --version

# KVM
if [ -e /dev/kvm ]; then
    echo "==> /dev/kvm found"
    sudo chmod 666 /dev/kvm
else
    echo "WARNING: /dev/kvm not found! Firecracker will not work."
fi

# -------------------------------------------------------------------
# Podman (for rootfs building)
# -------------------------------------------------------------------
echo "==> Installing Podman..."
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y podman uidmap slirp4netns e2fsprogs git

# -------------------------------------------------------------------
# IP forwarding for Firecracker VMs
# -------------------------------------------------------------------
echo "==> Configuring networking..."
sudo tee /etc/sysctl.d/99-opensandbox.conf > /dev/null << 'SYSCTL'
net.ipv4.ip_forward = 1
net.ipv4.neigh.default.gc_thresh1 = 1024
net.ipv4.neigh.default.gc_thresh2 = 4096
net.ipv4.neigh.default.gc_thresh3 = 8192
fs.file-max = 1000000
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 524288
SYSCTL
sudo sysctl --system

# -------------------------------------------------------------------
# Directory structure
# -------------------------------------------------------------------
echo "==> Creating directories..."
sudo mkdir -p /data/sandboxes /data/firecracker/images /data/checkpoints /data/opensandbox-repos /etc/opensandbox

# -------------------------------------------------------------------
# Worker identity (static for all-in-one)
# -------------------------------------------------------------------
PUBLIC_IP=$(curl -s -m 5 http://169.254.169.254/latest/meta-data/public-ipv4 || echo "52.15.68.251")
PRIVATE_IP=$(curl -s -m 5 http://169.254.169.254/latest/meta-data/local-ipv4 || echo "127.0.0.1")

sudo tee /etc/opensandbox/worker-identity.env > /dev/null << EOF
OPENSANDBOX_WORKER_ID=w-dev-allinone
OPENSANDBOX_HTTP_ADDR=http://${PUBLIC_IP}:8081
OPENSANDBOX_GRPC_ADVERTISE=${PRIVATE_IP}:9090
EOF

# -------------------------------------------------------------------
# Server env
# -------------------------------------------------------------------
sudo tee /etc/opensandbox/server.env > /dev/null << EOF
OPENSANDBOX_DATABASE_URL=postgres://opensandbox:opensandbox@localhost:5432/opensandbox?sslmode=disable
OPENSANDBOX_JWT_SECRET=dev-secret-allinone
EOF

# -------------------------------------------------------------------
# systemd: control plane (server)
# -------------------------------------------------------------------
echo "==> Installing server systemd unit..."
sudo tee /etc/systemd/system/opensandbox-server.service > /dev/null << EOF
[Unit]
Description=OpenSandbox Control Plane (server)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/opensandbox-server
Restart=always
RestartSec=5
Environment=HOME=/root
Environment=OPENSANDBOX_MODE=server
Environment=OPENSANDBOX_PORT=8080
Environment=OPENSANDBOX_REGION=use2
Environment=OPENSANDBOX_DATA_DIR=/data
Environment=OPENSANDBOX_WORKER_ID=cp-dev-1
Environment=OPENSANDBOX_HTTP_ADDR=http://${PUBLIC_IP}:8080
Environment=OPENSANDBOX_SANDBOX_DOMAIN=workers.opensandbox.ai
Environment=OPENSANDBOX_SECRETS_ARN=arn:aws:secretsmanager:us-east-2:739940681129:secret:opensandbox/server-vtN2Ez
EnvironmentFile=-/etc/opensandbox/server.env
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# -------------------------------------------------------------------
# systemd: worker (Firecracker)
# -------------------------------------------------------------------
echo "==> Installing worker systemd unit..."
sudo tee /etc/systemd/system/opensandbox-worker.service > /dev/null << EOF
[Unit]
Description=OpenSandbox Worker (Firecracker)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/opensandbox-worker
Restart=always
RestartSec=5
Environment=HOME=/root
Environment=OPENSANDBOX_MODE=worker
Environment=OPENSANDBOX_PORT=8081
Environment=OPENSANDBOX_REGION=use2
Environment=OPENSANDBOX_DATA_DIR=/data
Environment=OPENSANDBOX_SANDBOX_DOMAIN=workers.opensandbox.ai
Environment=OPENSANDBOX_FIRECRACKER_BIN=/usr/local/bin/firecracker
Environment=OPENSANDBOX_KERNEL_PATH=/data/firecracker/vmlinux-arm64
Environment=OPENSANDBOX_IMAGES_DIR=/data/firecracker/images
Environment=OPENSANDBOX_MAX_CAPACITY=5
Environment=OPENSANDBOX_SECRETS_ARN=arn:aws:secretsmanager:us-east-2:739940681129:secret:opensandbox/worker-vtN2Ez
EnvironmentFile=/etc/opensandbox/worker-identity.env
EnvironmentFile=-/etc/opensandbox/server.env
KillMode=process
TimeoutStopSec=120
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# -------------------------------------------------------------------
# systemd: git server
# -------------------------------------------------------------------
echo "==> Installing gitserver systemd unit..."
sudo tee /etc/systemd/system/opensandbox-gitserver.service > /dev/null << EOF
[Unit]
Description=OpenSandbox Git Server
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/opensandbox-gitserver
Restart=always
RestartSec=5
Environment=HOME=/root
Environment=OPENSANDBOX_GIT_PORT=3000
Environment=OPENSANDBOX_GIT_REPO_ROOT=/data/opensandbox-repos
Environment=OPENSANDBOX_GIT_DOMAIN=${PUBLIC_IP}:3000
Environment=OPENSANDBOX_SECRETS_ARN=arn:aws:secretsmanager:us-east-2:739940681129:secret:opensandbox/server-vtN2Ez
EnvironmentFile=-/etc/opensandbox/server.env
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# -------------------------------------------------------------------
# Enable everything
# -------------------------------------------------------------------
sudo systemctl daemon-reload
sudo systemctl enable opensandbox-server opensandbox-worker opensandbox-gitserver

echo ""
echo "============================================"
echo " All-in-one setup complete! ($ARCH)"
echo ""
echo " Instance: ${PUBLIC_IP}"
echo " PostgreSQL: localhost:5432 (opensandbox/opensandbox)"
echo ""
echo " Remaining steps:"
echo "   1. Deploy binaries: server, worker, agent, gitserver"
echo "   2. Download kernel to /data/firecracker/vmlinux-arm64"
echo "   3. Build rootfs images to /data/firecracker/images/"
echo "   4. Start services"
echo "============================================"
