# The self-host gateway: services/managed-agents' Computer path (src/selfhost/entry.ts) under
# Miniflare, persisting to /data. Build from the repository root:
#   podman build -f selfhost/gateway/Dockerfile -t computer-gateway:local .

# ---- build: the Worker bundle, the way `wrangler deploy` would upload it.
FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /src/services/managed-agents
COPY services/managed-agents/package.json services/managed-agents/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY services/managed-agents/ ./
RUN WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --config wrangler.selfhost.jsonc --outdir /bundle

# ---- run: Miniflare (workerd needs glibc, hence bookworm), the bundle and the D1 migrations.
FROM docker.io/library/node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm install --no-save --no-audit --no-fund miniflare@4.20260722.0
COPY --from=build /bundle /app/bundle
COPY services/managed-agents/migrations /app/managed-agents/migrations
COPY selfhost/gateway/serve.mjs /app/selfhost/gateway/serve.mjs
ENV GATEWAY_BUNDLE=/app/bundle/entry.js \
    MANAGED_AGENTS_DIR=/app/managed-agents \
    MINIFLARE_MODULE=/app/node_modules/miniflare/dist/src/index.js \
    GATEWAY_DATA=/data \
    PORT=8080 \
    HOST=0.0.0.0
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "/app/selfhost/gateway/serve.mjs"]
