# Self-host image (work 101): the gateway, the host agent and its runners in
# one container, with one data volume at /data. The same image runs on a laptop
# and on a VM; moving the instance means moving the volume.
#
# Build from computer/:
#   docker build -f deploy/docker/Dockerfile --build-arg SP_VERSION=$(git rev-parse --short HEAD) -t computer .
# Run: deploy/docker/compose.yaml, or
#   docker run -p 8080:8080 -v computer-data:/data computer
#
# Every session runs as the same user in this container, so sessions can read
# each other's files and the instance's keys under /data. Fine for one person
# trying it; per-session isolation is separate work.

FROM node:24-slim

# git and gh: sessions clone, commit and open pull requests. python3: the
# terminal's pty helper. openssl: first-start keys. tini: PID 1, reaps the
# detached runners and forwards SIGTERM.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssh-client openssl python3 tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, for layer caching. Dev dependencies stay: everything runs through tsx.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY definitions ./definitions
COPY deploy/docker/start.sh ./deploy/docker/start.sh

# Scratch workspaces live on the volume (src/workspace.ts puts them in /app/workspaces).
RUN ln -s /data/workspaces /app/workspaces

# Git and gh get GitHub App tokens from the host's token socket (README "Workspaces").
USER node
RUN git config --global credential.https://github.com.helper '' \
 && git config --global --add credential.https://github.com.helper /app/bin/git-credential-slack-presence \
 && git config --global credential.https://github.com.useHttpPath true
USER root

ARG SP_VERSION=dev
ENV SP_VERSION=$SP_VERSION \
    NODE_ENV=production \
    PORT=8080 \
    SP_HOME=/data \
    SP_REAL_GH=/usr/bin/gh \
    PATH=/app/bin:$PATH
EXPOSE 8080
VOLUME /data

# Starts as root only to hand /data to `node`; start.sh drops privileges before anything else runs.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/deploy/docker/start.sh"]
