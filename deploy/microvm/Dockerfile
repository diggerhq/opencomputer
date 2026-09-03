# MicroVM image for the AWS Lambda MicroVMs backend (internal/awsvm).
#
# Lambda runs this Dockerfile on top of its managed MicroVM base environment
# (al2023-1), starts the ENTRYPOINT, waits for our /ready hook, then snapshots
# the disk AND memory. Every MicroVM launched from the resulting image resumes
# from that snapshot — which is why startup is fast, and also why anything
# baked in here is already warm when a customer arrives.
#
# The FROM below is Lambda's own snapshot-compatible container base. We could
# use our own base instead (private ECR is supported), and eventually should,
# so that sandboxes on this backend match the runtime customers get on the QEMU
# backend. For now this stays deliberately minimal: the open question is whether
# our agent works through Lambda's proxy at all, and a fat image only slows the
# loop that answers it.
# Resolves to arm64: Lambda MicroVMs runs ARM_64 only, and the build host is
# ARM, so the multi-arch base and the binaries build.sh cross-compiles must both
# be arm64 or the build fails before this file is ever executed.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# The sandbox's toolchain.
#
# This list is the al2023 equivalent of what the QEMU fleet ships
# (deploy/firecracker/rootfs/Dockerfile.default, Ubuntu 22.04). It used to be
# six packages — nodejs, python3, tar, gzip, ca-certificates, shadow-utils —
# which measured, from inside a live sandbox, as:
#
#   HAVE  curl node npm python3 pip3 openssl
#   MISS  git wget make gcc g++ vim nano ps top unzip zip jq ssh rsync sudo sqlite3
#
# No git is the one that matters most: cloning a repo is the first thing most
# agents do, and it simply was not there. No compilers meant any `pip install`
# needing a native extension failed. That is not a runtime a QEMU customer can
# be moved onto, whatever the API surface says.
#
# shadow-utils is not optional: it provides useradd. The minimal base does not
# ship it, and without it the sandbox user below is never created — which shows
# up much later as every exec failing with "fork/exec /bin/sh: no such file or
# directory", because the agent runs commands in /home/sandbox and Go reports a
# missing working directory as if the binary were missing.
#
# fuse/fuse3 and rclone are here for the mounts feature: internal/mounts drives
# it entirely through manager.WriteFile + manager.Exec (it writes an rclone
# config into the guest and runs `rclone mount`), so mounts are not host-side
# and need nothing but these binaries and a working /dev/fuse.
# curl-minimal ships in the base and conflicts with the full curl that git
# pulls in, so swap it first. NOTE the install below has no --allowerasing:
# this base runs dnf5, which does not have that flag ("error: Unknown option
# --allowerasing"). The swap is what resolves the conflict.
RUN dnf -y swap curl-minimal curl
RUN dnf install -y \
      bash ca-certificates shadow-utils sudo findutils which procps-ng \
      nano vim-minimal less \
      wget openssh-clients iproute iputils bind-utils \
      git \
      tar gzip bzip2 xz zip unzip \
      gcc gcc-c++ make automake cmake pkgconf-pkg-config \
      openssl openssl-devel libffi-devel zlib-devel \
      jq sqlite sqlite-devel \
      nodejs python3 python3-pip python3-devel \
      fuse fuse3 rsync \
 && dnf clean all \
 && rm -rf /var/cache/dnf

# rclone is not in the al2023 repositories, and mounts need it. Fetched by
# architecture rather than pinned to x86: this image is ARM_64 only.
RUN set -eux; \
    arch="$(uname -m)"; case "$arch" in aarch64) rc=arm64 ;; x86_64) rc=amd64 ;; *) rc=arm64 ;; esac; \
    curl -fsSL -o /tmp/rclone.zip "https://downloads.rclone.org/rclone-current-linux-${rc}.zip"; \
    cd /tmp && unzip -q rclone.zip && cp rclone-*-linux-${rc}/rclone /usr/local/bin/rclone; \
    chmod +x /usr/local/bin/rclone; rm -rf /tmp/rclone.zip /tmp/rclone-*-linux-${rc}

# A sandbox user so customer commands do not run as root — matching the QEMU
# backend, where exec deliberately runs unprivileged. internal/agent runs every
# exec as this user with cwd /home/sandbox, so both must exist.
#
# Deliberately NOT tolerant of failure: an earlier `|| true` here hid a missing
# useradd and turned a build-time problem into an every-exec runtime failure.
RUN useradd --create-home --shell /bin/bash sandbox \
 && test -d /home/sandbox

# Passwordless sudo for the sandbox user, matching the QEMU rootfs (which ships
# sudo for the same reason). internal/mounts execs `sudo chmod` on the rclone
# config it writes, so without this the mounts feature fails at its second step.
RUN echo 'sandbox ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/sandbox \
 && chmod 0440 /etc/sudoers.d/sandbox

# ==== OSB_CUSTOM_TEMPLATE_LAYERS ====
# Custom-template layers are spliced in HERE, and nowhere else.
#
# This position is load-bearing in three ways:
#   - AFTER useradd/sudoers, so a customer step can chown to `sandbox` and
#     write into /home/sandbox.
#   - BEFORE the ENV block below, so a customer `pip install` at build time
#     runs WITHOUT PIP_USER=1 and lands system-wide, visible to the sandbox
#     user. With PIP_USER set it would install into /root/.local and simply
#     not exist for the customer — a silent "my template did not apply".
#   - BEFORE the agent COPY and ENTRYPOINT below, so no customer layer can
#     remove or shadow the agent, and ENTRYPOINT is always ours.
#
# Splitting the real image definition here (rather than duplicating a prologue
# in Go) is what guarantees a custom-template box is the pool box plus the
# customer's layers, and cannot drift from it.

# osb-agent is the same binary the QEMU backend runs in-guest; only its
# listener differs (TCP here, virtio-serial there), selected by the env var the
# hook server sets when it spawns the agent.
COPY osb-agent /usr/local/bin/osb-agent
COPY microvm-hooks /usr/local/bin/microvm-hooks
RUN chmod +x /usr/local/bin/osb-agent /usr/local/bin/microvm-hooks

# User-space install defaults.
#
# The customer runs unprivileged and cannot write to /usr/local or /opt (sudo
# cannot elevate — the MicroVM sets no_new_privs), so a toolchain they install
# has to live under their home directory to exist at all. Pointing the package
# managers there additionally means a checkpoint CAPTURES it, because the
# workspace archive covers /home/sandbox — a template can then carry an
# installed environment without any custom image.
#
# PIP_USER makes `pip install X` land in ~/.local without the customer having to
# remember --user; PIP_BREAK_SYSTEM_PACKAGES is needed alongside it because pip
# otherwise refuses to touch an externally-managed environment.
ENV PIP_USER=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    NPM_CONFIG_PREFIX=/home/sandbox/.npm-global \
    PATH=/home/sandbox/.local/bin:/home/sandbox/.npm-global/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin

RUN mkdir -p /home/sandbox/.local/bin /home/sandbox/.npm-global/bin \
 && chown -R sandbox:sandbox /home/sandbox/.local /home/sandbox/.npm-global

# Documentation only. Lambda's proxy forwards guest traffic solely to the port
# declared in the image's hook configuration (8080) — EXPOSE does not influence
# that, which was confirmed by adding 8081 here and watching it stay 502.
# osb-agent's 8081 is reachable only via the in-guest bridge in cmd/microvm-hooks.
EXPOSE 8080

# microvm-hooks is PID 1: it supervises osb-agent, serves the lifecycle hooks
# Lambda calls, and reaps orphaned children (unreaped zombies otherwise exhaust
# the pid budget on a box that looks idle).
ENTRYPOINT ["/usr/local/bin/microvm-hooks"]
