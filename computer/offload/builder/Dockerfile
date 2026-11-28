# The offload builder: the pinned session image plus the build agent, so a
# build in a MicroVM sees the same toolchains, user and paths as the session it
# came from. selfhost/aws/build-offload-image.sh zips this file and agent.mjs
# and has Lambda MicroVMs build it, once per size tier.
#
# CreateMicrovmImage takes no build arguments, so the script rewrites the
# SESSION_IMAGE default below in the zipped copy with the digest the host runs
# (SP_IMAGE in the release's .sp-version.env, written by host-install.sh). The
# placeholder is not a valid reference, so an unrewritten build fails at FROM.
# Locally: podman build --build-arg SESSION_IMAGE=ghcr.io/diggerhq/computer-session@sha256:<digest> .
ARG SESSION_IMAGE=ghcr.io/diggerhq/computer-session@sha256:set-by-build-offload-image
FROM ${SESSION_IMAGE}

USER root
# The session image installs Node (computer/deploy/image/Containerfile); this
# only matters if a future session image drops it.
RUN command -v node >/dev/null 2>&1 \
 || (apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*)
# Rust, which the session image lacks: rustup's minimal stable profile (rustc,
# cargo, rust-std), system-wide and owned by agent, so builds can add targets,
# components and the crate cache. The linker (cc), pkg-config and make come
# from the session image's build-essential; installed here only if it drops them.
ENV RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo PATH=/opt/rust/cargo/bin:$PATH
RUN (command -v cc && command -v pkg-config && command -v make) >/dev/null 2>&1 \
 || (apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config make && rm -rf /var/lib/apt/lists/*)
RUN set -eu; tmp="$(mktemp -d)"; cd "$tmp" \
 && url=https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init \
 && curl -fsSL --retry 5 "$url" -o rustup-init \
 && echo "$(curl -fsSL --retry 5 "$url.sha256" | cut -d' ' -f1)  rustup-init" | sha256sum -c - \
 && chmod +x rustup-init \
 && ./rustup-init -y --no-modify-path --profile minimal --default-toolchain stable \
 && cd / && rm -rf "$tmp" "$RUSTUP_HOME/downloads" "$RUSTUP_HOME/tmp" \
 && chown -R 1500:1500 /opt/rust \
 && printf 'export RUSTUP_HOME=%s CARGO_HOME=%s\ncase ":$PATH:" in *":%s/bin:"*) ;; *) PATH="%s/bin:$PATH" ;; esac\n' \
      "$RUSTUP_HOME" "$CARGO_HOME" "$CARGO_HOME" "$CARGO_HOME" > /etc/profile.d/rust.sh \
 && cargo --version && rustc --version
RUN mkdir -p /opt/oc-offload /work && chown 1500:1500 /work
COPY agent.mjs /opt/oc-offload/agent.mjs

# Builds run as agent (uid 1500), as in the session. VERIFY: that the MicroVM
# runtime honours USER (the spike ran the session image's own USER 1500).
USER 1500:1500
WORKDIR /work
ENV PORT=8080 OC_WORK_ROOT=/work
EXPOSE 8080
# tini (from the session image) reaps the builds' orphans; the session
# image's own entrypoint (sp-session-init) is not wanted here.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/oc-offload/agent.mjs"]
