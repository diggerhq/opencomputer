#!/usr/bin/env bash
# Prints the first-boot script (cloud-init user data) of a self-managed
# computer VM: one the operator creates by hand, for a gateway that runs with
# COMPUTER_VMS=self-managed. Run it on the operator's machine and pass the
# output to the cloud's CLI as the VM's user data:
#
#   GATEWAY_HOST=gateway.example.com ORG_ID=... TOKEN=sph_... BUNDLE_URL=... \
#     deploy/vm/self-managed-user-data.sh > computer-user-data.sh
#
# On the VM (Ubuntu 24.04, amd64, as root) the printed script writes
# /root/calvin-computer.env (0600), downloads the release bundle and runs
# azure-computer-boot.sh from it with BOOTSTRAP_FETCH=0. That script runs on
# any cloud: provision.sh gets CLOUD=none and the data disk named here.
#
# The output holds the host token. Keep the file 0600; the cloud stores it as
# the VM's user data, readable by whoever may read the VM there.
#
# Inputs, from the environment:
#   GATEWAY_HOST  the gateway Worker's hostname, e.g. gateway.example.com
#   ORG_ID        the organization id (dashboard, Settings)
#   TOKEN         the organization's host token, sph_...
#   BUNDLE_URL    where the VM downloads the release that bundle.sh built:
#                 https://...  any URL the VM can GET (S3 presigned, Azure SAS)
#                 gs://<bucket>/<object>  read with the VM's service account
#   DATA_DEVICE   optional: the blank data disk, a block device path. Unset, an
#                 Azure VM uses the disk at LUN 0 (provision.sh finds it) and
#                 any other VM the one disk that is not the root disk.
set -euo pipefail

die() { echo "self-managed-user-data: $*" >&2; exit 1; }

for name in GATEWAY_HOST ORG_ID TOKEN BUNDLE_URL; do
  [[ -n ${!name:-} ]] || die "$name is not set"
done
[[ $GATEWAY_HOST =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "GATEWAY_HOST is a hostname, without wss:// or a path"
[[ $TOKEN =~ ^sph_[A-Za-z0-9_-]+$ ]] || die "TOKEN is not a host token (sph_...)"
[[ $ORG_ID =~ ^[A-Za-z0-9_:.-]+$ ]] || die "ORG_ID is not an organization id"
[[ $BUNDLE_URL != *[[:space:]\']* ]] || die "BUNDLE_URL holds a space or a quote"
DATA_DEVICE="${DATA_DEVICE:-}"
[[ -z $DATA_DEVICE || $DATA_DEVICE =~ ^/dev/[A-Za-z0-9/_.:-]+$ ]] || die "DATA_DEVICE is not a /dev path"

urlencode() {
  local s=$1 out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [A-Za-z0-9._~-]) out+=$c ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

case $BUNDLE_URL in
  https://*)
    fetch="curl -fsSL --retry 5 -o /opt/bootstrap/calvin.bundle '$BUNDLE_URL'"
    ;;
  gs://*/*)
    bucket=${BUNDLE_URL#gs://}
    object=${bucket#*/}
    bucket=${bucket%%/*}
    fetch="access_token=\$(curl -fsS -H 'Metadata-Flavor: Google' \\
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \\
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"access_token\"])')
curl -fsSL --retry 5 -H \"Authorization: Bearer \$access_token\" -o /opt/bootstrap/calvin.bundle \\
  'https://storage.googleapis.com/storage/v1/b/$bucket/o/$(urlencode "$object")?alt=media'"
    ;;
  *) die "BUNDLE_URL is neither https://... nor gs://<bucket>/<object>" ;;
esac

cat <<EOF
#!/bin/bash
# First boot of a self-managed computer VM (deploy/vm/self-managed-user-data.sh).
set -euo pipefail
exec > >(tee -a /var/log/calvin-first-boot.log) 2>&1

data_device='$DATA_DEVICE'
if [[ -z \$data_device && ! -d /dev/disk/azure ]]; then
  root_disk=\$(lsblk -no PKNAME "\$(findmnt -no SOURCE /)")
  mapfile -t others < <(lsblk -dno NAME,TYPE | awk -v r="\$root_disk" '\$2 == "disk" && \$1 != r { print \$1 }')
  [[ \${#others[@]} -eq 1 ]] || { echo "expected one data disk besides \$root_disk, found: \${others[*]:-none}"; exit 1; }
  data_device=/dev/\${others[0]}
fi

umask 077
cat > /root/calvin-computer.env <<ENV
SP_GATEWAY_URL=wss://$GATEWAY_HOST/v1/computer/host?organizationId=$(urlencode "$ORG_ID")
SP_HOST_TOKEN=$TOKEN
SP_HOST_ID=$ORG_ID
ENV
[[ -z \$data_device ]] || echo "DATA_DEVICE=\$data_device" >> /root/calvin-computer.env
umask 022

apt-get update -q
apt-get install -y -q git curl
install -d -m 0755 /opt/bootstrap
$fetch
rm -rf /opt/bootstrap/calvin-src
git clone -q --branch main /opt/bootstrap/calvin.bundle /opt/bootstrap/calvin-src
BOOTSTRAP_FETCH=0 bash /opt/bootstrap/calvin-src/deploy/vm/azure-computer-boot.sh
EOF
