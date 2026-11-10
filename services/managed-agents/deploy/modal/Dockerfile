FROM public.ecr.aws/amazonlinux/amazonlinux:2023

ARG GH_VERSION=2.100.0
ARG GH_AMD64_SHA256=d5ba4be326de149dfd72c052e982c4cb7b86c1b2c1e4aa704e586e63327d32b5
ARG GH_ARM64_SHA256=3d085211727fbb0a770c46d1804f27bc530973ae4fc99db32fe78f909987d0bc
# The fixed-IP tunnel client (work 073; src/microvm/egress-tunnel.ts).
ARG SING_BOX_VERSION=1.14.0
ARG SING_BOX_AMD64_SHA256=2375de6999f4f56ab46b4fc5ddf26a6aba1d3e61a0f4e7ddec2f4690457d5f63
ARG SING_BOX_ARM64_SHA256=04d9b40bc98dc55b6f509ce3292145c65478f65866bea64826ebb2f382385088

RUN dnf install -y --setopt=tsflags=nocaps nodejs22 nodejs22-npm git tar curl-minimal \
      python3 python3-pip which findutils procps-ng unzip \
    && case "$(uname -m)" in \
      x86_64) gh_arch=amd64; gh_sha256="${GH_AMD64_SHA256}" ;; \
      aarch64) gh_arch=arm64; gh_sha256="${GH_ARM64_SHA256}" ;; \
      *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac \
    && curl -fsSL \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.rpm" \
      -o /tmp/gh.rpm \
    && echo "${gh_sha256}  /tmp/gh.rpm" | sha256sum --check --strict \
    && dnf install -y /tmp/gh.rpm \
    && rm -f /tmp/gh.rpm \
    && alternatives --set node /usr/bin/node-22 \
    && gh --version \
    && case "$(uname -m)" in \
      x86_64) sb_arch=amd64; sb_sha256="${SING_BOX_AMD64_SHA256}" ;; \
      aarch64) sb_arch=arm64; sb_sha256="${SING_BOX_ARM64_SHA256}" ;; \
    esac \
    && curl -fsSL \
      "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-${sb_arch}.tar.gz" \
      -o /tmp/sing-box.tgz \
    && echo "${sb_sha256}  /tmp/sing-box.tgz" | sha256sum --check --strict \
    && tar -xzf /tmp/sing-box.tgz -C /tmp \
    && install -m 0755 "/tmp/sing-box-${SING_BOX_VERSION}-linux-${sb_arch}/sing-box" /usr/local/bin/sing-box \
    && rm -rf /tmp/sing-box.tgz "/tmp/sing-box-${SING_BOX_VERSION}-linux-${sb_arch}" \
    && sing-box version \
    && dnf clean all

# ── Headless browser (Playwright Chromium) ───────────────────────────────────
# Every sandbox ships a browser by default, so an agent can drive a real
# headless Chromium — navigate, screenshot, scrape, run a page — with no
# per-run download. The heavy, slow parts (the Chromium binary and its system
# libraries) are baked here; an agent that wants the client library just runs
# `npm i playwright` and reuses the Chromium already at PLAYWRIGHT_BROWSERS_PATH.
# Amazon Linux is dnf, not apt, so Playwright's `install-deps` can't run: the
# runtime libraries are named explicitly (the field-tested Remotion AL2023 set
# plus the few extra libs Playwright's Chromium links) and `playwright install`
# runs without --with-deps. Fonts are best-effort (--skip-broken) so a package
# rename can't break the image build; the libs above are a hard requirement.
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN dnf install -y --setopt=tsflags=nocaps \
      nss nspr atk at-spi2-atk at-spi2-core cups-libs \
      libdrm libxkbcommon mesa-libgbm dbus-libs \
      libX11 libxcb libXcomposite libXdamage libXext libXfixes \
      libXrandr libXrender alsa-lib pango cairo expat \
    && dnf install -y --setopt=tsflags=nocaps --skip-broken \
      fontconfig freetype dejavu-sans-fonts liberation-sans-fonts \
    && dnf clean all \
    && npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
    && playwright install chromium \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"
# Make the globally-installed playwright resolvable from any cwd (agents work
# under /workspace), so `require('playwright')` / `import` works with no local
# install. Covers both global-prefix layouts (/usr and /usr/local).
ENV NODE_PATH=/usr/lib/node_modules:/usr/local/lib/node_modules

WORKDIR /opt/blue
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN mkdir -p /opt/blue/opencode2-deps \
    && cd /opt/blue/opencode2-deps \
    && npm init -y \
    && npm install --ignore-scripts --no-audit --no-fund \
      "@opencode-ai/plugin@$(node -p "require('/opt/blue/node_modules/@opencode-ai/plugin-v2/package.json').version")" \
    && mkdir -p /opt/blue/opencode-config \
    && cp -a /opt/blue/opencode2-deps/. /opt/blue/opencode-config/

COPY dist ./dist

ENV NODE_ENV=production
ENV PATH="/opt/blue/node_modules/.bin:${PATH}"
ENV OPENCODE_CONFIG_DIR="/opt/blue/opencode-config"
EXPOSE 8080

CMD ["node", "dist/microvm/supervisor.js"]
