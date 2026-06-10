# worker-ami-aws-burst.pkr.hcl — Build an immutable AMI for OpenSandbox Burst workers on AWS.
#
# Mirrors deploy/packer/worker-ami.pkr.hcl (Azure variant) but targets the
# amazon-ebs builder. The setup script (`deploy/azure/setup-azure-host.sh`)
# is cloud-agnostic in practice — it installs QEMU + kernel modules + systemd
# units + Vector and never talks to Azure-specific APIs. We reuse it as-is.
#
# Differences from the Azure file:
#   - amazon-ebs source on Ubuntu 24.04 LTS x86_64 instead of azure-arm.
#   - Optional Tigris/S3-compatible rootfs blob caching. Same rootfs inputs
#     reuse the same cached default.ext4, which keeps AMI builds fast and
#     golden versions stable when the guest image did not change.
#   - Installs awscli (needed by deploy/vector/populate-vector-env.sh AWS path
#     and by the worker user-data shared-disk attach).
#   - Tags the AMI for the terraform `aws_ami` data source lookup
#     (opensandbox-role=worker, opensandbox-cloud=aws).
#
# Usage:
#   # 1. Build binaries for linux/amd64:
#   CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-X main.WorkerVersion=$(git rev-parse --short HEAD)" \
#     -o bin/opensandbox-worker ./cmd/worker/
#   CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/osb-agent ./cmd/agent/
#
#   # 2. Build the rootfs context tarball:
#   tar czf /tmp/packer-rootfs-ctx.tar.gz deploy/firecracker/rootfs/ deploy/ec2/build-rootfs-docker.sh scripts/claude-agent-wrapper/
#
#   # 3. Run packer:
#   packer init deploy/packer/worker-ami-aws-burst.pkr.hcl
#   packer build -var "worker_version=$(git rev-parse --short HEAD)" deploy/packer/worker-ami-aws-burst.pkr.hcl
#
#   # 4. The data source in opencomputer-infra/terraform/aws/us-east-2-poc/ami.tf
#   #    picks up the new AMI on the next `tofu apply`.

packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

# ---------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------

variable "worker_version" {
  type        = string
  description = "Worker version (git SHA). Baked into AMI name and tags."
}

variable "agent_version" {
  type    = string
  default = ""
}

variable "region" {
  type    = string
  default = "us-east-2"
}

variable "instance_type" {
  type        = string
  default     = "c5.4xlarge"
  description = "Builder instance type. Needs enough memory for Docker rootfs build (~8GB) but doesn't need to run guest VMs, so non-metal is fine and saves ~10× vs c5.metal."
}

variable "worker_binary" {
  type    = string
  default = "bin/opensandbox-worker"
}

variable "agent_binary" {
  type    = string
  default = "bin/osb-agent"
}

variable "rootfs_context" {
  type        = string
  default     = "/tmp/packer-rootfs-ctx.tar.gz"
  description = "Pre-built tarball of rootfs + agent wrapper sources."
}

variable "vector_context" {
  type        = string
  default     = "/tmp/packer-vector-ctx.tar.gz"
  description = "Pre-built tarball of deploy/vector/ (config + populator + units). Pre-create with: tar czf /tmp/packer-vector-ctx.tar.gz deploy/vector/"
}

variable "tigris_endpoint" {
  type        = string
  default     = ""
  description = "Optional S3-compatible endpoint for Tigris rootfs/golden cache."
}

variable "tigris_access_key_id" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Optional Tigris access key for rootfs/golden cache."
}

variable "tigris_secret_access_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Optional Tigris secret key for rootfs/golden cache."
}

variable "tigris_goldens_bucket" {
  type        = string
  default     = ""
  description = "Optional Tigris bucket for content-addressed rootfs cache and golden uploads. Empty = skip cache."
}

# ---------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------

source "amazon-ebs" "worker" {
  region        = var.region
  instance_type = var.instance_type
  ssh_username  = "ubuntu"
  ssh_pty       = true

  ami_name        = "opensandbox-burst-worker-${var.worker_version}-${formatdate("YYYYMMDD-hhmm", timestamp())}"
  ami_description = "OpenSandbox Burst worker AMI (Ubuntu 24.04, QEMU/KVM nested-virt). Built from git ${var.worker_version}."

  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
      architecture        = "x86_64"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
    }
    most_recent = true
    owners      = ["099720109477"] # Canonical
  }

  ena_support   = true
  sriov_support = true

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 50
    volume_type           = "gp3"
    delete_on_termination = true
  }

  # AMI tags — the terraform `aws_ami` data source in the AWS leaf filters
  # on these to pick the most-recent worker AMI for this cloud.
  tags = {
    Name                  = "opensandbox-burst-worker-${var.worker_version}"
    "opensandbox-role"    = "worker"
    "opensandbox-cloud"   = "aws"
    "opensandbox-version" = var.worker_version
  }

  # Volume snapshot tag — propagates so the EBS snapshot underlying the AMI
  # has the same provenance metadata as the AMI itself.
  snapshot_tags = {
    "opensandbox-role"    = "worker"
    "opensandbox-cloud"   = "aws"
    "opensandbox-version" = var.worker_version
  }

  run_tags = {
    Name = "packer-opensandbox-worker-build"
  }
}

# ---------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------

build {
  sources = ["source.amazon-ebs.worker"]

  # 1. Upload pre-built binaries.
  provisioner "file" {
    source      = var.worker_binary
    destination = "/tmp/opensandbox-worker"
  }
  provisioner "file" {
    source      = var.agent_binary
    destination = "/tmp/osb-agent"
  }

  # 2. Upload rootfs build context.
  provisioner "file" {
    source      = var.rootfs_context
    destination = "/tmp/rootfs-ctx.tar.gz"
  }

  # 3. Upload the EC2 worker systemd unit (the Azure variant uses a different
  #    unit; the EC2 one was already drafted at deploy/ec2/opensandbox-worker.service).
  provisioner "file" {
    source      = "deploy/ec2/opensandbox-worker.service"
    destination = "/tmp/opensandbox-worker.service"
  }

  # 4. Upload Vector config + populator. Packer's file provisioner doesn't
  #    do recursive directory upload reliably across SSH clients, so we
  #    tar/extract the same way we do the rootfs context above. See
  #    var.vector_context for the pre-build command.
  provisioner "file" {
    source      = var.vector_context
    destination = "/tmp/vector-ctx.tar.gz"
  }
  provisioner "shell" {
    inline = [
      "mkdir -p /tmp/vector",
      "tar xzf /tmp/vector-ctx.tar.gz -C /tmp/vector --strip-components=2", # strip deploy/vector/ prefix
      "rm /tmp/vector-ctx.tar.gz",
    ]
  }

  # 5. Run the (misleadingly-named-but-cloud-agnostic) setup script. Installs
  #    QEMU, kernel modules, Docker for rootfs build, Vector, systemd units.
  provisioner "shell" {
    execute_command = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E bash '{{ .Path }}'"
    script          = "deploy/azure/setup-azure-host.sh"
  }

  # 6. AWS-specific: install awscli (used by populate-vector-env.sh and by
  #    the worker user-data's shared-disk attach), bake OCFS2 dependencies for
  #    the shared data volume, then install binaries and build the golden rootfs.
  provisioner "shell" {
    execute_command = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E bash '{{ .Path }}'"
    environment_vars = [
      "TIGRIS_ENDPOINT=${var.tigris_endpoint}",
      "TIGRIS_ACCESS_KEY_ID=${var.tigris_access_key_id}",
      "TIGRIS_SECRET_ACCESS_KEY=${var.tigris_secret_access_key}",
      "TIGRIS_GOLDENS_BUCKET=${var.tigris_goldens_bucket}",
      "AWS_DEFAULT_REGION=auto",
    ]
    inline = [
      # awscli v2 — apt's `awscli` is v1 and missing some commands we use.
      "apt-get update -qq",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip ocfs2-tools \"linux-modules-extra-$(uname -r)\"",
      "curl -fsSL 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip' -o /tmp/awscliv2.zip",
      "cd /tmp && unzip -q awscliv2.zip && ./aws/install --update",
      "rm -rf /tmp/awscliv2.zip /tmp/aws",
      "aws --version",
      "modprobe ocfs2",
      "modprobe ocfs2_dlmfs",
      "modprobe ocfs2_stack_o2cb",
      "command -v mount.ocfs2",
      "systemctl disable --now apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service 2>/dev/null || true",

      # Install worker + agent binaries.
      "mv /tmp/opensandbox-worker /usr/local/bin/opensandbox-worker",
      "chmod +x /usr/local/bin/opensandbox-worker",
      "mv /tmp/osb-agent /usr/local/bin/osb-agent",
      "chmod +x /usr/local/bin/osb-agent",

      # Install systemd unit.
      "mv /tmp/opensandbox-worker.service /etc/systemd/system/opensandbox-worker.service",
      "systemctl daemon-reload",
      "systemctl enable opensandbox-worker.service",

      # Build or restore the golden rootfs. The cache key is content-addressed
      # from the guest agent, rootfs sources, and guest kernel modules.
      "mkdir -p /tmp/rootfs-ctx",
      "cd /tmp/rootfs-ctx && tar xzf /tmp/rootfs-ctx.tar.gz",
      "INPUT_HASH=$({ sha256sum /usr/local/bin/osb-agent; find /tmp/rootfs-ctx -type f | sort | xargs sha256sum; sha256sum /opt/opensandbox/guest-modules/*.ko* 2>/dev/null; } | sha256sum | awk '{print $1}')",
      "echo \"Rootfs input hash: $INPUT_HASH\"",
      "ROOTFS_UUID=$(echo \"$INPUT_HASH\" | head -c 32 | sed 's/\\(........\\)\\(....\\)\\(....\\)\\(....\\)\\(............\\)/\\1-\\2-\\3-\\4-\\5/')",
      "export ROOTFS_UUID",
      "INPUT_HASH_SHORT=$(echo \"$INPUT_HASH\" | cut -c1-16)",
      "CACHE_KEY=\"rootfs-cache/$INPUT_HASH_SHORT/default.ext4\"",
      "CACHE_HIT=0",
      "mkdir -p /data/firecracker/images /opt/opensandbox/images",
      "if [ -n \"$TIGRIS_ENDPOINT\" ] && [ -n \"$TIGRIS_ACCESS_KEY_ID\" ] && [ -n \"$TIGRIS_SECRET_ACCESS_KEY\" ] && [ -n \"$TIGRIS_GOLDENS_BUCKET\" ]; then",
      "  export AWS_ACCESS_KEY_ID=\"$TIGRIS_ACCESS_KEY_ID\" AWS_SECRET_ACCESS_KEY=\"$TIGRIS_SECRET_ACCESS_KEY\"",
      "  echo \"Checking rootfs cache: s3://$TIGRIS_GOLDENS_BUCKET/$CACHE_KEY\"",
      "  if aws s3 cp --endpoint-url \"$TIGRIS_ENDPOINT\" \"s3://$TIGRIS_GOLDENS_BUCKET/$CACHE_KEY\" /data/firecracker/images/default.ext4; then",
      "    CACHE_HIT=1",
      "    echo 'Rootfs restored from cache — skipping Docker build'",
      "  else",
      "    echo 'Rootfs cache miss — building from source'",
      "  fi",
      "else",
      "  echo 'Tigris cache credentials incomplete; rootfs cache disabled'",
      "fi",
      "if [ \"$CACHE_HIT\" != \"1\" ]; then",
      "  cd /tmp/rootfs-ctx && ROOTFS_UUID=\"$ROOTFS_UUID\" bash deploy/ec2/build-rootfs-docker.sh /usr/local/bin/osb-agent /data/firecracker/images default",
      "fi",
      "cp /data/firecracker/images/default.ext4 /opt/opensandbox/images/default.ext4",

      # Inject guest kernel modules into rootfs.
      "GUEST_MODDIR=/opt/opensandbox/guest-modules",
      "if [ -d \"$GUEST_MODDIR\" ] && [ -f /opt/opensandbox/images/default.ext4 ]; then",
      "  MNTDIR=$(mktemp -d)",
      "  mount -o loop /opt/opensandbox/images/default.ext4 $MNTDIR",
      "  mkdir -p $MNTDIR/lib/modules/extra",
      "  cp $GUEST_MODDIR/*.ko* $MNTDIR/lib/modules/extra/ 2>/dev/null || true",
      "  umount $MNTDIR",
      "  rmdir $MNTDIR",
      "fi",

      # Stamp the golden version (hash of the final ext4) — workers read this
      # at boot to decide whether to fetch a newer golden from S3.
      "GOLDEN_VERSION=$(/usr/local/bin/opensandbox-worker golden-version /opt/opensandbox/images/default.ext4 2>/dev/null || sha256sum /opt/opensandbox/images/default.ext4 | awk '{print $1}')",
      "echo \"$GOLDEN_VERSION\" > /opt/opensandbox/images/golden-version",
      "echo \"Golden version: $GOLDEN_VERSION\"",
      "if [ \"$CACHE_HIT\" != \"1\" ] && [ -n \"$TIGRIS_ENDPOINT\" ] && [ -n \"$TIGRIS_ACCESS_KEY_ID\" ] && [ -n \"$TIGRIS_SECRET_ACCESS_KEY\" ] && [ -n \"$TIGRIS_GOLDENS_BUCKET\" ]; then",
      "  export AWS_ACCESS_KEY_ID=\"$TIGRIS_ACCESS_KEY_ID\" AWS_SECRET_ACCESS_KEY=\"$TIGRIS_SECRET_ACCESS_KEY\"",
      "  echo \"Uploading rootfs cache: s3://$TIGRIS_GOLDENS_BUCKET/$CACHE_KEY\"",
      "  aws s3 cp --endpoint-url \"$TIGRIS_ENDPOINT\" /opt/opensandbox/images/default.ext4 \"s3://$TIGRIS_GOLDENS_BUCKET/$CACHE_KEY\" || echo 'rootfs cache upload failed — continuing'",
      "fi",
    ]
  }

  # 7. Optional: upload the golden to Tigris so future hydration paths
  #    + future per-instance prefetch path can fetch it without rebuilding.
  provisioner "shell" {
    execute_command = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E bash '{{ .Path }}'"
    environment_vars = [
      "TIGRIS_ENDPOINT=${var.tigris_endpoint}",
      "TIGRIS_ACCESS_KEY_ID=${var.tigris_access_key_id}",
      "TIGRIS_SECRET_ACCESS_KEY=${var.tigris_secret_access_key}",
      "TIGRIS_GOLDENS_BUCKET=${var.tigris_goldens_bucket}",
      "AWS_DEFAULT_REGION=auto",
    ]
    inline = [
      "set -e",
      "if [ -z \"$TIGRIS_ENDPOINT\" ] || [ -z \"$TIGRIS_ACCESS_KEY_ID\" ] || [ -z \"$TIGRIS_SECRET_ACCESS_KEY\" ] || [ -z \"$TIGRIS_GOLDENS_BUCKET\" ]; then",
      "  echo 'Tigris cache credentials incomplete; skipping golden upload (worker AMI still includes the baked golden)'",
      "  exit 0",
      "fi",
      "export AWS_ACCESS_KEY_ID=\"$TIGRIS_ACCESS_KEY_ID\" AWS_SECRET_ACCESS_KEY=\"$TIGRIS_SECRET_ACCESS_KEY\"",
      "GOLDEN_VERSION=$(cat /opt/opensandbox/images/golden-version)",
      "S3_KEY=\"bases/$GOLDEN_VERSION/default.ext4\"",
      "echo \"Uploading default.ext4 -> s3://$TIGRIS_GOLDENS_BUCKET/$S3_KEY (~4GB, will take a moment)\"",
      "aws s3 cp --endpoint-url \"$TIGRIS_ENDPOINT\" /opt/opensandbox/images/default.ext4 \"s3://$TIGRIS_GOLDENS_BUCKET/$S3_KEY\" || echo 'Tigris upload failed — continuing (AMI golden is the only copy)'",
    ]
  }

  # 8. Write a manifest so external tooling can pin to the resulting AMI ID.
  post-processor "manifest" {
    output     = "packer-manifest-aws.json"
    strip_path = true
  }
}
