# Image for the Node gateway: runs `tsx src/gateway/main.ts` on any container
# platform with a volume at /data. Production uses the backend's Cloudflare gateway.
# The host agent and runners do NOT run from this image; they run on the VM
# (deploy/vm/provision.sh), on a laptop, or in the self-host image that holds
# all three (deploy/docker/).
#
# Build: `docker build --build-arg SP_VERSION=$(git rev-parse --short HEAD) -t slack-presence-gateway .`

FROM node:24-slim

# ca-certificates: outbound HTTPS to Slack and GitHub. tini: PID 1 that
# forwards SIGTERM, so a container stop gives the gateway a clean shutdown.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, for layer caching. Dev dependencies are kept on purpose:
# the gateway runs TypeScript directly through tsx (a devDependency).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY deploy/gateway/entrypoint.sh /usr/local/bin/gateway-entrypoint
RUN chmod 0755 /usr/local/bin/gateway-entrypoint

# .git is not in the build context; pass the commit so the gateway can report
# its version: --build-arg SP_VERSION=$(git rev-parse --short HEAD)
ARG SP_VERSION=dev
ENV SP_VERSION=$SP_VERSION \
    NODE_ENV=production \
    PORT=8080 \
    SP_DB=/data/gateway.db
EXPOSE 8080

# The container starts as root only so the entrypoint can hand the data volume
# (mounted root-owned at /data) to the unprivileged `node` user; it then drops
# privileges with setpriv before starting Node. Nothing runs as root after that.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gateway-entrypoint"]
CMD ["node_modules/.bin/tsx", "src/gateway/main.ts"]
