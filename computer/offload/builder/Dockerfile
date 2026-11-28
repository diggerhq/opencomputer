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
