# The self-host gateway: services/managed-agents' Computer path (src/selfhost/entry.ts), api-edge
# (cloudflare-workers/api-edge, SELFHOST=1) and the dashboard (web/, VITE_SELFHOST=1) under
# Miniflare, persisting to /data. Build from the repository root:
#   podman build -f selfhost/gateway/Dockerfile -t computer-gateway:local .

# ---- build: the Worker bundle, the way `wrangler deploy` would upload it.
FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /src/services/managed-agents
COPY services/managed-agents/package.json services/managed-agents/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY services/managed-agents/ ./
RUN WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --config wrangler.selfhost.jsonc --outdir /bundle

# ---- api-edge: its bundle (it imports ../shared).
FROM docker.io/library/node:24-bookworm-slim AS edge
WORKDIR /src/cloudflare-workers/api-edge
COPY cloudflare-workers/api-edge/package.json cloudflare-workers/api-edge/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY cloudflare-workers/shared/ /src/cloudflare-workers/shared/
COPY cloudflare-workers/api-edge/ ./
RUN mkdir -p assets && WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir /edge-bundle

# ---- the dashboard, without billing (VITE_SELFHOST=1). It reads the SDK's client from source.
FROM docker.io/library/node:24-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY sdks/typescript/src/computer/ /src/sdks/typescript/src/computer/
COPY web/ ./
RUN VITE_SELFHOST=1 npx vite build

# ---- run: Miniflare (workerd needs glibc, hence bookworm), the bundle and the D1 migrations.
FROM docker.io/library/node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm install --no-save --no-audit --no-fund miniflare@4.20260722.0
COPY --from=build /bundle /app/bundle
COPY services/managed-agents/migrations /app/managed-agents/migrations
COPY --from=edge /edge-bundle /app/edge-bundle
COPY cloudflare-workers/api-edge/migrations /app/api-edge/migrations
COPY cloudflare-workers/api-edge/schema-snapshots /app/api-edge/schema-snapshots
COPY --from=web /src/web/dist /app/web
COPY selfhost/gateway/serve.mjs /app/selfhost/gateway/serve.mjs
ENV GATEWAY_BUNDLE=/app/bundle/entry.js \
    MANAGED_AGENTS_DIR=/app/managed-agents \
    EDGE_BUNDLE=/app/edge-bundle/index.js \
    API_EDGE_DIR=/app/api-edge \
    WEB_DIST=/app/web \
    MINIFLARE_MODULE=/app/node_modules/miniflare/dist/src/index.js \
    GATEWAY_DATA=/data \
    PORT=8080 \
    HOST=0.0.0.0
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "/app/selfhost/gateway/serve.mjs"]
