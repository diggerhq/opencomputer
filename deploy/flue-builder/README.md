# Flue managed-build snapshot

This directory owns the immutable runtime used by the managed Flue repository
builder. It is an internal deployment asset, not a customer-selectable image.
Repository code runs here with public-only networking and without GitHub,
OpenComputer, R2, Cloudflare, WfP, or coordinator credentials.

## Pinned coordinate

`coordinate.json` is the reviewed logical coordinate. It pins:

- snapshot name `flue-build-node22-19-0-oc-c39b315-r1` (never reuse it for a
  different recipe or checkpoint);
- Ubuntu 22.04 / x86-64 platform assertion;
- Node 22.19.0 and its upstream archive digest;
- npm 10.9.3 from that Node archive;
- the exact OpenComputer source commit and source-archive digest;
- Go 1.25.0, used only to build `oc`, and its archive digest;
- the reproducible Linux/amd64 `oc` binary digest;
- raw installer, image-template, and materialized-manifest digests; and
- the required runtime `networkPolicy=public`.

The named snapshot is not the complete physical coordinate. The snapshot API's
ready response supplies its immutable `checkpointId`. `snapshot.py create`
writes that ID to a receipt. Staging and the real-substrate probe must configure
both the reviewed snapshot name and that receipt's checkpoint ID. Name-only
validation is insufficient because an operator could delete and recreate a
snapshot.

The recipe starts from OpenComputer's trusted `base` image, verifies every
downloaded toolchain/source archive, and verifies the built `oc` bytes. The
checkpoint receipt freezes the resulting base and OS-package state. A future
rebuild is a new `rN` snapshot name, coordinate, and receipt even when the
toolchain versions do not change.

## Offline validation

These commands perform no API calls and create nothing:

```bash
python3 deploy/flue-builder/snapshot.py check
python3 ci/flue-builder-substrate-probe.py --check
```

They verify the shell syntax, recipe digests, materialized manifest, memory
settings, runtime policy, and the installer-emitted attestation. CI runs both.

## Create in isolated staging

Snapshot creation is an explicit, billable platform write. Do not run this
against production while the feature is under development. Use a staging API
key that owns the internal snapshot, load it without printing it, and run:

```bash
export OPENCOMPUTER_API_URL='https://staging.example.invalid'
export OPENCOMPUTER_API_KEY='...'
export AGENT_BUILD_SNAPSHOT_ALLOW_CREATE=1

python3 deploy/flue-builder/snapshot.py create \
  --confirm-name flue-build-node22-19-0-oc-c39b315-r1 \
  --receipt /secure/operator-state/flue-build-node22-19-0-oc-c39b315-r1.json
```

The command is idempotent only when an existing snapshot has the exact pinned
manifest. It never deletes or replaces a snapshot. A mismatch fails and
requires a new snapshot name. Known production hosts additionally require the
separate `AGENT_BUILD_SNAPSHOT_ALLOW_PRODUCTION=1` guard; local HTTP requires
`AGENT_BUILD_SNAPSHOT_ALLOW_HTTP=1`.

Store the receipt in the deployment system's non-secret release metadata. Do
not commit environment files or API keys. Configure the build worker from the
receipt:

```text
AGENT_BUILD_SANDBOX_SNAPSHOT=flue-build-node22-19-0-oc-c39b315-r1
AGENT_BUILD_SANDBOX_CHECKPOINT_ID=<receipt checkpointId>
AGENT_BUILD_NODE_VERSION=22.19.0
AGENT_BUILD_NETWORK_POLICY=public
```

Worker readiness must compare the live snapshot's manifest and checkpoint ID
to these coordinates before claiming repository builds.

## Real-substrate proof

The live probe creates two short-lived sandboxes from the same checkpoint:

1. an explicitly authorized unrestricted control, proving that the private
   canary, link-local metadata service, and guest-to-host service are actually
   live; and
2. the final `networkPolicy=public` sandbox, proving public npm registry and
   tarball access succeeds while those targets and inbound exposure fail.

It also verifies the runtime attestation and exact `oc` digest, checks that the
create response has no host port, proves a temporary non-secret server is
publicly reachable through the unrestricted control, then requires preview
creation to return 409 and the equivalent restricted guest server to remain
unreachable. Finally it scans guest process environments plus common
configuration files for exact credential sentinel values. The raw adapter
constructs request bodies from an allowlist and never forwards the coordinator
process environment. Both sandboxes are destroyed in `finally`; a teardown
failure makes the probe fail and prints only the sandbox ID for operator
cleanup.

Provide a disposable HTTP(S) canary at a literal RFC1918 or CGNAT address. It
must be reachable from a normal staging sandbox and return a short, non-secret
marker. Do not put credentials in its URL or marker. Then run:

```bash
export OPENCOMPUTER_API_URL='https://staging.example.invalid'
export OPENCOMPUTER_API_KEY='...'
export AGENT_BUILD_SANDBOX_SNAPSHOT='flue-build-node22-19-0-oc-c39b315-r1'
export AGENT_BUILD_SANDBOX_CHECKPOINT_ID='<receipt checkpointId>'
export AGENT_BUILD_NODE_VERSION='22.19.0'
export AGENT_BUILD_PRIVATE_CANARY_URL='http://10.0.0.10:8080/flue-probe'
export AGENT_BUILD_PRIVATE_CANARY_EXPECT='flue-private-canary-ok'
export AGENT_BUILD_PROBE_ALLOW_UNRESTRICTED_CONTROL=1

python3 ci/flue-builder-substrate-probe.py --run
```

The script refuses known production hosts unless
`AGENT_BUILD_PROBE_ALLOW_PRODUCTION=1` is also set, and refuses HTTP control
planes unless `AGENT_BUILD_PROBE_ALLOW_HTTP=1` is set. The unrestricted control
guard is deliberately separate: without it, a policy regression could look
like a passing denial test merely because the target was down.

This repository does not create the staging snapshot or run the live proof in
CI. They require deployed sandbox-policy code, a real checkpoint receipt, a
private control canary, and explicit operator authority. Record the exact
receipt and probe result in the cross-repository working document after that
controlled staging run.
