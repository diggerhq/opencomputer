# Flue managed-build snapshot

This directory owns the immutable toolchain image used by managed Flue
repository builds. It is an internal deployment asset, not a customer-selectable
image.

The image is an ordinary disposable OpenComputer sandbox created from the
standard `base` image through the existing snapshot and sandbox APIs. The
repository-deploy feature consumes those public APIs as-is and does not require
changes to lower sandbox-platform layers.

## Pinned coordinate

`coordinate.json` is the reviewed logical coordinate. It pins:

- snapshot name `flue-build-node22-19-0-oc-c39b315-r3` (never reuse it for a
  different recipe or checkpoint);
- Ubuntu 22.04 / x86-64 platform assertion;
- Node 22.19.0 and its upstream archive digest;
- npm 10.9.3 from that Node archive;
- the exact OpenComputer source commit and source-archive digest;
- Go 1.25.0, used only to build `oc`, and its archive digest;
- the reproducible Linux/amd64 `oc` binary digest; and
- raw installer, image-template, and materialized-manifest digests.

The named snapshot is not the complete physical coordinate. The snapshot API's
ready response supplies its immutable `checkpointId`. `snapshot.py create`
writes that ID to a receipt. The build worker and live sandbox proof configure
both the reviewed snapshot name and that receipt's checkpoint ID. Name-only
validation is insufficient because an operator could delete and recreate a
snapshot.

The recipe verifies every downloaded toolchain/source archive and the built
`oc` bytes. The checkpoint freezes the resulting base and OS-package state. A
future rebuild gets a new `rN` snapshot name, coordinate, and receipt even when
the toolchain versions do not change.

## Credential separation

Isolation between repository access, build execution, and deployment authority
is an orchestration responsibility:

1. A short-lived source sandbox receives only the scoped repository credential
   needed to fetch one resolved commit.
2. The source sandbox emits a digest-checked, tokenless archive and is
   destroyed.
3. A separate ordinary sandbox created from this snapshot receives that archive
   and runs install/build commands without GitHub, OpenComputer, object-store,
   model, or Workers deployment credentials.
4. Trusted coordinator and deploy services move artifacts and hold their own
   narrowly scoped credentials outside repository code.

The build sandbox request must be constructed from an explicit allowlist. Do
not pass the worker process environment, an OpenComputer key, or a secret store
to the sandbox.

## Offline validation

These commands perform no API calls and create nothing:

```bash
python3 deploy/flue-builder/snapshot.py check
python3 ci/flue-builder-substrate-probe.py --check
python3 -m unittest ci/test_flue_builder_substrate_probe.py
```

They verify shell syntax, recipe digests, the materialized manifest, memory
settings, installer-emitted attestation, and the ordinary sandbox-create
contract. CI also runs the byte-identical managed-build golden fixture.

## Create the immutable snapshot

Snapshot creation is an explicit, billable platform write. Load an API key
without printing it and run:

```bash
export OPENCOMPUTER_API_URL='https://app.opencomputer.dev'
export OPENCOMPUTER_API_KEY='...'
export AGENT_BUILD_SNAPSHOT_ALLOW_CREATE=1
export AGENT_BUILD_SNAPSHOT_ALLOW_PRODUCTION=1

python3 deploy/flue-builder/snapshot.py create \
  --confirm-name flue-build-node22-19-0-oc-c39b315-r3 \
  --receipt /secure/operator-state/flue-build-node22-19-0-oc-c39b315-r3.json
```

The command is idempotent only when an existing snapshot has the exact pinned
manifest. It never deletes or replaces a snapshot. A mismatch fails and
requires a new snapshot name. Known production hosts require the separate
production guard; local HTTP requires `AGENT_BUILD_SNAPSHOT_ALLOW_HTTP=1`.

Store the receipt in non-secret release metadata. Do not commit environment
files or API keys. Configure the build worker from the coordinate and receipt:

```text
AGENT_BUILD_SANDBOX_SNAPSHOT=flue-build-node22-19-0-oc-c39b315-r3
AGENT_BUILD_SANDBOX_CHECKPOINT_ID=<receipt checkpointId>
AGENT_BUILD_NODE_VERSION=22.19.0
AGENT_BUILD_NPM_VERSION=10.9.3
AGENT_BUILD_OC_VERSION=oc@c39b31560cb78e0d5708a9eda4cfb30ec372eed9
AGENT_BUILD_OC_BINARY_SHA256=7f7286095aefe78c3027efb79465442070370c6dcf3cda67c9b1315949a42bc1
```

Worker readiness must compare the live snapshot manifest and checkpoint ID to
these coordinates before claiming repository builds.

## Live ordinary-sandbox proof

The guarded live probe:

1. validates the named snapshot's manifest and immutable checkpoint receipt;
2. creates one disposable sandbox with the normal
   `{"snapshot": "...", "timeout": 600}` request;
3. verifies the exact Node, npm, and `oc` versions/digests and a writable
   `/workspace`;
4. fetches the pinned public starter, runs `npm ci`, and reproduces its golden
   Flue artifact with the pinned `oc`; and
5. confirms coordinator credential sentinels were not passed into the sandbox.

The probe destroys every sandbox in `finally`; a cleanup failure fails the run
and prints only the sandbox ID for operator cleanup.

```bash
export OPENCOMPUTER_API_URL='https://app.opencomputer.dev'
export OPENCOMPUTER_API_KEY='...'
export AGENT_BUILD_SANDBOX_SNAPSHOT='flue-build-node22-19-0-oc-c39b315-r3'
export AGENT_BUILD_SANDBOX_CHECKPOINT_ID='<receipt checkpointId>'
export AGENT_BUILD_NODE_VERSION='22.19.0'
export AGENT_BUILD_NPM_VERSION='10.9.3'
export AGENT_BUILD_OC_VERSION='oc@c39b31560cb78e0d5708a9eda4cfb30ec372eed9'
export AGENT_BUILD_OC_BINARY_SHA256='7f7286095aefe78c3027efb79465442070370c6dcf3cda67c9b1315949a42bc1'
export AGENT_BUILD_PROBE_ALLOW_PRODUCTION=1

python3 ci/flue-builder-substrate-probe.py --run
```

The script refuses known production hosts without the production guard and
refuses HTTP control planes without `AGENT_BUILD_PROBE_ALLOW_HTTP=1`.

This proof deliberately tests the repository-deploy feature as a consumer of
OpenComputer's existing public sandbox contract, without feature-specific
sandbox variants.
