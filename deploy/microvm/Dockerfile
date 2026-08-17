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

# Runtimes the TTI benchmark and most first commands reach for. Kept small on
# purpose — see the note above about runtime parity being a later, separate job.
#
# shadow-utils is not optional: it provides useradd. The minimal base does not
# ship it, and without it the sandbox user below is never created — which shows
# up much later as every exec failing with "fork/exec /bin/sh: no such file or
# directory", because the agent runs commands in /home/sandbox and Go reports a
# missing working directory as if the binary were missing.
RUN dnf install -y nodejs python3 tar gzip ca-certificates shadow-utils \
 && dnf clean all \
 && rm -rf /var/cache/dnf

# osb-agent is the same binary the QEMU backend runs in-guest; only its
# listener differs (TCP here, virtio-serial there), selected by the env var the
# hook server sets when it spawns the agent.
COPY osb-agent /usr/local/bin/osb-agent
COPY microvm-hooks /usr/local/bin/microvm-hooks
RUN chmod +x /usr/local/bin/osb-agent /usr/local/bin/microvm-hooks

# A sandbox user so customer commands do not run as root — matching the QEMU
# backend, where exec deliberately runs unprivileged. internal/agent runs every
# exec as this user with cwd /home/sandbox, so both must exist.
#
# Deliberately NOT tolerant of failure: an earlier `|| true` here hid a missing
# useradd and turned a build-time problem into an every-exec runtime failure.
RUN useradd --create-home --shell /bin/bash sandbox \
 && test -d /home/sandbox

# Documentation only. Lambda's proxy forwards guest traffic solely to the port
# declared in the image's hook configuration (8080) — EXPOSE does not influence
# that, which was confirmed by adding 8081 here and watching it stay 502.
# osb-agent's 8081 is reachable only via the in-guest bridge in cmd/microvm-hooks.
EXPOSE 8080

# microvm-hooks is PID 1: it supervises osb-agent, serves the lifecycle hooks
# Lambda calls, and reaps orphaned children (unreaped zombies otherwise exhaust
# the pid budget on a box that looks idle).
ENTRYPOINT ["/usr/local/bin/microvm-hooks"]
