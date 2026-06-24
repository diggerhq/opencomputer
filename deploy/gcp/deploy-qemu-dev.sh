#!/usr/bin/env bash
# deploy-qemu-dev.sh — Deploy QEMU-based dev environment on GCP Compute Engine.
#
# Uses GCP nested virtualization (no bare metal required, unlike AWS).
# Reuses deploy/azure/setup-azure-host.sh for QEMU/KVM provisioning.
#
# Usage:
#   ./deploy/gcp/deploy-qemu-dev.sh [create|deploy|ssh|status|stop|start|destroy]
#
# Configuration (env vars):
#   GCP_PROJECT         — GCP project ID (required)
#   GCP_ZONE            — GCP zone (default: us-east4-c)
#   MACHINE_TYPE        — instance machine type (default: n2-standard-8)
#   INSTANCE_NAME       — VM name (default: opensandbox-qemu-dev)
#   SSH_KEY             — Path to SSH private key (default: ~/.ssh/google_compute_engine)
#   API_KEY             — API key for the server (default: test-dev-key)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# --- Defaults ---
GCP_PROJECT="${GCP_PROJECT:?GCP_PROJECT is required (e.g. export GCP_PROJECT=prod-415611)}"
GCP_ZONE="${GCP_ZONE:-us-east4-c}"
MACHINE_TYPE="${MACHINE_TYPE:-n2-standard-8}"
INSTANCE_NAME="${INSTANCE_NAME:-opensandbox-qemu-dev}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/google_compute_engine}"
SSH_USER="${SSH_USER:-$(whoami)}"
API_KEY="${API_KEY:-test-dev-key}"
NETWORK_TAG="opensandbox-dev"
FIREWALL_NAME="opensandbox-dev-allow"

STATE_FILE="$SCRIPT_DIR/.qemu-dev-state-${GCP_ZONE}"

# --- Helpers ---
log()  { echo "$(date '+%H:%M:%S') [qemu-dev-gcp] $*"; }
err()  { echo "$(date '+%H:%M:%S') [qemu-dev-gcp] ERROR: $*" >&2; exit 1; }

gcp_cmd() { gcloud --project "$GCP_PROJECT" "$@"; }

save_state() {
    local key="$1" value="$2"
    if [ -f "$STATE_FILE" ] && grep -q "^${key}=" "$STATE_FILE" 2>/dev/null; then
        sed -i.bak "s|^${key}=.*|${key}=${value}|" "$STATE_FILE"
        rm -f "${STATE_FILE}.bak"
    else
        echo "${key}=${value}" >> "$STATE_FILE"
    fi
}

load_state() {
    local key="$1"
    if [ -f "$STATE_FILE" ]; then
        grep "^${key}=" "$STATE_FILE" 2>/dev/null | cut -d= -f2- || true
    fi
}

ssh_cmd() {
    local ip
    ip=$(load_state PUBLIC_IP)
    [ -n "$ip" ] || err "No instance IP found. Run 'create' first."
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -i "$SSH_KEY" "${SSH_USER}@${ip}" "$@"
}

ensure_ssh_key() {
    if [ ! -f "$SSH_KEY" ]; then
        log "Generating SSH key at $SSH_KEY..."
        ssh-keygen -t ed25519 -f "$SSH_KEY" -N '' -C "${SSH_USER}@gcp-opensandbox-dev"
    fi
    [ -f "${SSH_KEY}.pub" ] || err "SSH pubkey missing at ${SSH_KEY}.pub"
}

ensure_firewall() {
    if gcp_cmd compute firewall-rules describe "$FIREWALL_NAME" &>/dev/null; then
        return 0
    fi
    log "Creating firewall rule '$FIREWALL_NAME' (TCP 22, 80, 8080, 8081)..."
    gcp_cmd compute firewall-rules create "$FIREWALL_NAME" \
        --direction=INGRESS \
        --action=ALLOW \
        --rules=tcp:22,tcp:80,tcp:8080,tcp:8081 \
        --source-ranges=0.0.0.0/0 \
        --target-tags="$NETWORK_TAG" \
        --description="OpenSandbox dev box: SSH + HTTP + server + worker"
}

# --- Create ---
cmd_create() {
    local existing_state
    existing_state=$(gcp_cmd compute instances describe "$INSTANCE_NAME" \
        --zone="$GCP_ZONE" --format='value(status)' 2>/dev/null || echo "")
    if [ "$existing_state" = "RUNNING" ] || [ "$existing_state" = "STAGING" ]; then
        log "Instance $INSTANCE_NAME already exists (state: $existing_state)"
        cmd_status
        return 0
    fi

    ensure_ssh_key
    ensure_firewall

    local pubkey_content
    pubkey_content=$(cat "${SSH_KEY}.pub")
    local ssh_keys_metadata="${SSH_USER}:${pubkey_content}"

    log "Launching ${MACHINE_TYPE} in ${GCP_ZONE} (nested virt enabled)..."
    gcp_cmd compute instances create "$INSTANCE_NAME" \
        --zone="$GCP_ZONE" \
        --machine-type="$MACHINE_TYPE" \
        --image-family=ubuntu-2404-lts-amd64 \
        --image-project=ubuntu-os-cloud \
        --boot-disk-size=50GB \
        --boot-disk-type=pd-ssd \
        --local-ssd=interface=NVME \
        --enable-nested-virtualization \
        --tags="$NETWORK_TAG" \
        --metadata="ssh-keys=${ssh_keys_metadata}" \
        --labels=project=opensandbox,role=qemu-dev,owner="${SSH_USER}"

    save_state INSTANCE_NAME "$INSTANCE_NAME"

    local public_ip
    public_ip=$(gcp_cmd compute instances describe "$INSTANCE_NAME" \
        --zone="$GCP_ZONE" \
        --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
    save_state PUBLIC_IP "$public_ip"
    log "Public IP: $public_ip"

    log "Waiting for SSH..."
    for i in $(seq 1 60); do
        if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes \
            -i "$SSH_KEY" "${SSH_USER}@$public_ip" "echo ready" &>/dev/null; then
            log "SSH ready after ~$((i * 5))s"
            break
        fi
        if [ "$i" -eq 60 ]; then
            err "SSH not ready after 300s. Check 'gcloud compute instances get-serial-port-output $INSTANCE_NAME --zone=$GCP_ZONE'."
        fi
        sleep 5
    done

    # Format local SSD as XFS with reflink and mount at /data
    log "Setting up local SSD storage (XFS with reflink)..."
    ssh_cmd << 'SETUP_SSD'
set -euo pipefail
# GCP local SSDs in NVMe mode appear as /dev/nvme0n*. Find the unmounted one(s).
NVME_DRIVES=()
for dev in /dev/nvme0n1 /dev/nvme0n2 /dev/nvme0n3 /dev/nvme0n4; do
    [ -b "$dev" ] || continue
    if lsblk -no MOUNTPOINT "$dev" 2>/dev/null | grep -q '/'; then continue; fi
    if lsblk -no MOUNTPOINT "${dev}"* 2>/dev/null | grep -q '/'; then continue; fi
    NVME_DRIVES+=("$dev")
done
echo "Found ${#NVME_DRIVES[@]} local SSD(s): ${NVME_DRIVES[*]}"

if [ ${#NVME_DRIVES[@]} -eq 0 ]; then
    echo "WARNING: no local SSD found, falling back to boot disk"
    sudo mkdir -p /data
    exit 0
fi

sudo apt-get install -y -qq xfsprogs
if [ ${#NVME_DRIVES[@]} -eq 1 ]; then
    TARGET="${NVME_DRIVES[0]}"
    sudo mkfs.xfs -f -m reflink=1 "$TARGET"
else
    sudo apt-get install -y -qq mdadm
    sudo mdadm --create /dev/md0 --level=0 --raid-devices=${#NVME_DRIVES[@]} "${NVME_DRIVES[@]}" --force --run
    sudo mdadm --detail --scan | sudo tee -a /etc/mdadm/mdadm.conf
    sudo mkfs.xfs -f -m reflink=1 /dev/md0
    TARGET="/dev/md0"
fi
sudo mkdir -p /data
sudo mount "$TARGET" /data
UUID=$(sudo blkid -s UUID -o value "$TARGET")
echo "UUID=$UUID /data xfs defaults,nofail 0 2" | sudo tee -a /etc/fstab
sudo mkdir -p /data/sandboxes /data/firecracker/images /data/checkpoints
df -h /data
SETUP_SSD

    # Sync code and run QEMU host setup
    log "Syncing codebase..."
    rsync -az --progress \
        -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i $SSH_KEY" \
        --exclude '.git' --exclude 'bin/' --exclude 'node_modules/' \
        --exclude '.claude/' --exclude '*.ext4' \
        "$PROJECT_ROOT/" "${SSH_USER}@${public_ip}:~/opensandbox/"

    log "Running QEMU host setup (deploy/azure/setup-azure-host.sh)..."
    ssh_cmd "cd ~/opensandbox && sudo bash deploy/azure/setup-azure-host.sh"

    log ""
    log "=== GCP instance created ==="
    log "  Instance: $INSTANCE_NAME ($MACHINE_TYPE, $GCP_ZONE)"
    log "  IP:       $public_ip"
    log "  SSH:      $0 ssh"
    log "  Deploy:   $0 deploy"
    log ""
    log "Next: run '$0 deploy' to build and start services"
}

# --- Deploy ---
cmd_deploy() {
    local public_ip
    public_ip=$(load_state PUBLIC_IP)
    [ -n "$public_ip" ] || err "No instance found. Run 'create' first."

    if ! ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes \
        -i "$SSH_KEY" "${SSH_USER}@$public_ip" "echo ok" &>/dev/null; then
        err "Cannot reach $public_ip via SSH. Instance may be stopped."
    fi

    local branch
    branch=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD)
    log "Deploying branch '$branch' to $public_ip..."

    log "Syncing code..."
    rsync -az --progress \
        -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i $SSH_KEY" \
        --exclude '.git' --exclude 'bin/' --exclude 'node_modules/' \
        --exclude '.claude/' --exclude '*.ext4' \
        "$PROJECT_ROOT/" "${SSH_USER}@${public_ip}:~/opensandbox/"

    log "Building binaries on instance..."
    ssh_cmd << 'BUILD'
set -euo pipefail
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
cd ~/opensandbox
VERSION=$(cat VERSION 2>/dev/null || echo "dev")
echo "Building version $VERSION..."
CGO_ENABLED=0 go build -o bin/opensandbox-server ./cmd/server/
CGO_ENABLED=0 go build -ldflags="-X main.AgentVersion=$VERSION" -o bin/opensandbox-worker ./cmd/worker/
CGO_ENABLED=0 GOARCH=amd64 go build -ldflags="-X main.Version=$VERSION" -o bin/osb-agent ./cmd/agent/
sudo systemctl stop opensandbox-worker 2>/dev/null || true
sudo systemctl stop opensandbox-server 2>/dev/null || true
sudo cp bin/opensandbox-server bin/opensandbox-worker bin/osb-agent /usr/local/bin/
sudo chmod +x /usr/local/bin/opensandbox-server /usr/local/bin/opensandbox-worker /usr/local/bin/osb-agent
echo "Binaries installed."
BUILD

    log "Building rootfs (if needed)..."
    ssh_cmd << 'ROOTFS'
set -euo pipefail
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
if [ ! -f /data/firecracker/images/default.ext4 ]; then
    cd ~/opensandbox
    sudo -E bash deploy/ec2/build-rootfs-docker.sh /usr/local/bin/osb-agent /data/firecracker/images default
else
    echo "Rootfs already exists (delete /data/firecracker/images/default.ext4 to rebuild)."
fi

# Patch rootfs with full kernel modules from host (matches the EC2 flow)
if [ -f /data/firecracker/images/default.ext4 ]; then
    GUEST_KVER_FILE="/opt/opensandbox/guest-kernel-version"
    if [ -f "$GUEST_KVER_FILE" ]; then
        GUEST_KVER=$(cat "$GUEST_KVER_FILE")
    else
        GUEST_KVER=$(grep -aoP '\d+\.\d+\.\d+-\d+-generic' /opt/opensandbox/vmlinux | head -1)
    fi
    if [ -n "$GUEST_KVER" ] && [ -d "/lib/modules/$GUEST_KVER" ]; then
        echo "Patching rootfs with kernel modules for $GUEST_KVER..."
        MNTDIR=$(mktemp -d)
        sudo mount -o loop /data/firecracker/images/default.ext4 "$MNTDIR"
        sudo rm -rf "$MNTDIR/lib/modules"/*
        sudo cp -a "/lib/modules/$GUEST_KVER" "$MNTDIR/lib/modules/"
        sudo depmod -b "$MNTDIR" "$GUEST_KVER" 2>/dev/null || true
        if [ -f "$MNTDIR/bin/busybox" ] && [ ! -e "$MNTDIR/sbin/insmod" ]; then
            sudo ln -sf /bin/busybox "$MNTDIR/sbin/insmod"
        fi
        sudo umount "$MNTDIR"; rmdir "$MNTDIR"
        echo "Rootfs patched."
    fi
fi
ROOTFS

    log "Installing env files..."
    local private_ip
    private_ip=$(gcp_cmd compute instances describe "$INSTANCE_NAME" \
        --zone="$GCP_ZONE" \
        --format='value(networkInterfaces[0].networkIP)')
    local sandbox_domain="${public_ip}.nip.io"
    local api_key_hash
    api_key_hash=$(echo -n "${API_KEY}" | shasum -a 256 | cut -d' ' -f1)

    # S3 creds optional — checkpoint upload disabled if empty.
    local s3_bucket="${OPENSANDBOX_S3_BUCKET:-}"
    local s3_region="${OPENSANDBOX_S3_REGION:-us-east-1}"
    local s3_ak="${S3_ACCESS_KEY_ID:-}"
    local s3_sk="${S3_SECRET_ACCESS_KEY:-}"

    # WorkOS optional — dashboard auth disabled if empty.
    local workos_api_key="${WORKOS_API_KEY:-}"
    local workos_client_id="${WORKOS_CLIENT_ID:-}"
    local workos_redirect_uri="${WORKOS_REDIRECT_URI:-}"

    local env_tmpdir
    env_tmpdir=$(mktemp -d)

    cat > "$env_tmpdir/worker.env" << EOF
OPENSANDBOX_MODE=worker
OPENSANDBOX_VM_BACKEND=qemu
OPENSANDBOX_QEMU_BIN=qemu-system-x86_64
OPENSANDBOX_DATA_DIR=/data/sandboxes
OPENSANDBOX_KERNEL_PATH=/opt/opensandbox/vmlinux
OPENSANDBOX_IMAGES_DIR=/data/firecracker/images
OPENSANDBOX_GRPC_ADVERTISE=${private_ip}:9090
OPENSANDBOX_HTTP_ADDR=http://${private_ip}:8081
OPENSANDBOX_JWT_SECRET=dev-jwt-secret
OPENSANDBOX_WORKER_ID=w-qemu-dev-1
OPENSANDBOX_REGION=use4
OPENSANDBOX_MAX_CAPACITY=100
OPENSANDBOX_DATABASE_URL=postgres://opensandbox:opensandbox@localhost:5432/opensandbox?sslmode=disable
OPENSANDBOX_REDIS_URL=redis://localhost:6379
OPENSANDBOX_SANDBOX_DOMAIN=${sandbox_domain}
OPENSANDBOX_PORT=8081
OPENSANDBOX_DEFAULT_SANDBOX_MEMORY_MB=1024
OPENSANDBOX_DEFAULT_SANDBOX_CPUS=2
OPENSANDBOX_NATS_URL=
OPENSANDBOX_S3_BUCKET=${s3_bucket}
OPENSANDBOX_S3_REGION=${s3_region}
OPENSANDBOX_S3_ACCESS_KEY_ID=${s3_ak}
OPENSANDBOX_S3_SECRET_ACCESS_KEY=${s3_sk}
EOF

    cat > "$env_tmpdir/server.env" << EOF
OPENSANDBOX_MODE=server
OPENSANDBOX_API_KEY=${api_key_hash}
OPENSANDBOX_JWT_SECRET=dev-jwt-secret
OPENSANDBOX_HTTP_ADDR=http://0.0.0.0:8080
OPENSANDBOX_DATABASE_URL=postgres://opensandbox:opensandbox@localhost:5432/opensandbox?sslmode=disable
OPENSANDBOX_REDIS_URL=redis://localhost:6379
OPENSANDBOX_SANDBOX_DOMAIN=${sandbox_domain}
OPENSANDBOX_PORT=8080
OPENSANDBOX_REGION=use4
OPENSANDBOX_S3_BUCKET=${s3_bucket}
OPENSANDBOX_S3_REGION=${s3_region}
OPENSANDBOX_S3_ACCESS_KEY_ID=${s3_ak}
OPENSANDBOX_S3_SECRET_ACCESS_KEY=${s3_sk}
OPENSANDBOX_MIN_WORKERS=1
SVIX_API_TOKEN=${SVIX_API_TOKEN:-}
WORKOS_API_KEY=${workos_api_key}
WORKOS_CLIENT_ID=${workos_client_id}
WORKOS_REDIRECT_URI=${workos_redirect_uri}
EOF

    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -i "$SSH_KEY" "$env_tmpdir/worker.env" "$env_tmpdir/server.env" \
        "${SSH_USER}@${public_ip}:/tmp/"

    ssh_cmd "sudo mkdir -p /etc/opensandbox && sudo mv /tmp/worker.env /tmp/server.env /etc/opensandbox/"

    rm -rf "$env_tmpdir"

    log "Starting services..."
    ssh_cmd << 'RESTART'
set -euo pipefail
DEFAULT_IFACE=$(ip route show default | awk '/default/ {print $5}' | head -1)
sudo iptables -t nat -C POSTROUTING -s 172.16.0.0/16 -o "$DEFAULT_IFACE" -j MASQUERADE 2>/dev/null || \
    sudo iptables -t nat -A POSTROUTING -s 172.16.0.0/16 -o "$DEFAULT_IFACE" -j MASQUERADE
sudo iptables -C FORWARD -s 172.16.0.0/16 -j ACCEPT 2>/dev/null || \
    sudo iptables -I FORWARD -s 172.16.0.0/16 -j ACCEPT
sudo iptables -C FORWARD -d 172.16.0.0/16 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
    sudo iptables -I FORWARD -d 172.16.0.0/16 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
sudo sysctl -w net.ipv4.ip_forward=1 > /dev/null
sudo sysctl -w net.ipv4.conf.all.route_localnet=1 > /dev/null

PRIVATE_IP=$(ip -4 addr show $(ip route show default | awk '{print $5}' | head -1) | awk '/inet / {print $2}' | cut -d/ -f1)
PUBLIC_IP=$(curl -sH 'Metadata-Flavor: Google' -m 2 \
    'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' 2>/dev/null || echo "")
if [ -n "$PRIVATE_IP" ]; then
    sudo iptables -t nat -C PREROUTING -p tcp --dport 80 -d "$PRIVATE_IP" -j REDIRECT --to-port 8080 2>/dev/null || \
        sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -d "$PRIVATE_IP" -j REDIRECT --to-port 8080
fi
if [ -n "$PUBLIC_IP" ]; then
    sudo iptables -t nat -C PREROUTING -p tcp --dport 80 -d "$PUBLIC_IP" -j REDIRECT --to-port 8080 2>/dev/null || \
        sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -d "$PUBLIC_IP" -j REDIRECT --to-port 8080
fi

sudo systemctl daemon-reload
sudo systemctl restart opensandbox-server || true
sleep 2
sudo systemctl restart opensandbox-worker || true
echo "Services started."
RESTART

    log "Waiting for server..."
    for i in $(seq 1 30); do
        if ssh_cmd "curl -sf http://localhost:8080/health" 2>/dev/null; then break; fi
        sleep 2
    done

    log "Seeding database..."
    ssh_cmd << SEED
set -euo pipefail
export PGPASSWORD=opensandbox
KEY_HASH=\$(echo -n "${API_KEY}" | sha256sum | cut -d' ' -f1)
for i in \$(seq 1 15); do
    psql -h localhost -U opensandbox -d opensandbox -q -c 'SELECT 1 FROM orgs LIMIT 0' 2>/dev/null && break
    echo "Waiting for migrations..."
    sleep 2
done
psql -h localhost -U opensandbox -d opensandbox -c "
    INSERT INTO orgs (id, name, slug) VALUES ('00000000-0000-0000-0000-000000000001', 'Dev Org', 'dev')
    ON CONFLICT DO NOTHING;
" 2>/dev/null || echo "DB seed: orgs insert failed (may already exist)"
psql -h localhost -U opensandbox -d opensandbox -c "
    INSERT INTO api_keys (id, org_id, key_hash, key_prefix, name)
    VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '\${KEY_HASH}', '$(echo -n "${API_KEY}" | cut -c1-8)', 'dev-key')
    ON CONFLICT DO NOTHING;
" 2>/dev/null || echo "DB seed: api_keys insert failed (may already exist)"
echo "DB seeded (org + API key)"
SEED

    log ""
    log "=== Deployment complete ==="
    log "  Server: http://${public_ip}:8080"
    log "  Worker: http://${public_ip}:8081"
    log "  API key: ${API_KEY}"
    log ""
    log "Smoke test:"
    log "  curl -sf http://${public_ip}:8080/health"
    log "  curl -X POST http://${public_ip}:8080/api/sandboxes \\"
    log "    -H 'Content-Type: application/json' -H 'X-API-Key: ${API_KEY}' \\"
    log "    -d '{\"templateID\":\"default\"}'"
}

# --- SSH ---
cmd_ssh() {
    local public_ip
    public_ip=$(load_state PUBLIC_IP)
    [ -n "$public_ip" ] || err "No instance found. Run 'create' first."
    if [ $# -gt 0 ] && [ "$1" = "--" ]; then
        shift
        ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -i "$SSH_KEY" "${SSH_USER}@$public_ip" "$@"
    else
        ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -i "$SSH_KEY" "${SSH_USER}@$public_ip"
    fi
}

# --- Status ---
cmd_status() {
    local state public_ip
    state=$(gcp_cmd compute instances describe "$INSTANCE_NAME" \
        --zone="$GCP_ZONE" --format='value(status)' 2>/dev/null || echo "not-found")

    if [ "$state" = "RUNNING" ]; then
        public_ip=$(gcp_cmd compute instances describe "$INSTANCE_NAME" \
            --zone="$GCP_ZONE" \
            --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
        save_state PUBLIC_IP "$public_ip"
    else
        public_ip=$(load_state PUBLIC_IP)
    fi

    echo ""
    echo "  Instance:  $INSTANCE_NAME"
    echo "  Machine:   $MACHINE_TYPE"
    echo "  Project:   $GCP_PROJECT"
    echo "  Zone:      $GCP_ZONE"
    echo "  State:     $state"
    echo "  Public IP: ${public_ip:-n/a}"
    echo ""
    if [ "$state" = "RUNNING" ]; then
        echo "  Server:  http://${public_ip}:8080"
        echo "  Worker:  http://${public_ip}:8081"
        echo "  SSH:     $0 ssh"
        echo "  Logs:    $0 ssh -- sudo journalctl -u opensandbox-worker -f"
    fi
    echo ""
}

# --- Stop ---
cmd_stop() {
    log "Stopping $INSTANCE_NAME..."
    gcp_cmd compute instances stop "$INSTANCE_NAME" --zone="$GCP_ZONE"
    log "Instance stopped. Boot disk preserved (~\$0.04/GB-month)."
    log "WARNING: Local SSD data is LOST when the instance stops."
}

# --- Start ---
cmd_start() {
    log "Starting $INSTANCE_NAME..."
    gcp_cmd compute instances start "$INSTANCE_NAME" --zone="$GCP_ZONE"
    local public_ip
    public_ip=$(gcp_cmd compute instances describe "$INSTANCE_NAME" \
        --zone="$GCP_ZONE" \
        --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
    save_state PUBLIC_IP "$public_ip"
    log "Instance running. Public IP: $public_ip"
    log "NOTE: local SSD is gone; re-run 'deploy' to re-seed /data and rebuild rootfs."
}

# --- Destroy ---
cmd_destroy() {
    echo "This will DELETE instance $INSTANCE_NAME in $GCP_ZONE (all disk data lost)."
    read -r -p "Are you sure? (y/N) " confirm
    if [[ ! "$confirm" =~ ^[yY]$ ]]; then
        echo "Cancelled."
        return 0
    fi
    gcp_cmd compute instances delete "$INSTANCE_NAME" --zone="$GCP_ZONE" --quiet
    rm -f "$STATE_FILE"
    log "Instance deleted. State file cleaned up."
}

# --- Main ---
CMD="${1:-help}"
case "$CMD" in
    create)    cmd_create ;;
    deploy)    cmd_deploy ;;
    ssh)       shift; cmd_ssh "$@" ;;
    status)    cmd_status ;;
    stop)      cmd_stop ;;
    start)     cmd_start ;;
    destroy)   cmd_destroy ;;
    *)
        echo "Usage: $0 {create|deploy|ssh|status|stop|start|destroy}"
        echo ""
        echo "Environment:"
        echo "  GCP_PROJECT=$GCP_PROJECT  GCP_ZONE=$GCP_ZONE"
        echo "  MACHINE_TYPE=$MACHINE_TYPE  INSTANCE_NAME=$INSTANCE_NAME"
        echo "  API_KEY=$API_KEY"
        echo ""
        echo "Quick start:"
        echo "  source ~/.opensandbox-gcp-dev.env"
        echo "  $0 create    # Launch ${MACHINE_TYPE} (~\$0.39/hr)"
        echo "  $0 deploy    # Build + deploy QEMU backend"
        echo "  $0 ssh       # SSH into instance"
        ;;
esac
