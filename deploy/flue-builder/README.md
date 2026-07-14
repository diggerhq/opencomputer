# Flue managed-build snapshot

This directory owns the immutable runtime used by the managed Flue repository
builder. It is an internal deployment asset, not a customer-selectable image.
Repository code runs here with public-only networking and without GitHub,
OpenComputer, R2, Cloudflare, WfP, or coordinator credentials. It runs as uid
1000 with no `sudo` binary or supplementary groups; the pinned toolchain is
root-owned while `/workspace` remains writable. The root guest-agent control
transport remains available to the trusted host but is unreachable from
repository processes inside the guest.

## Pinned coordinate

`coordinate.json` is the reviewed logical coordinate. It pins:

- snapshot name `flue-build-node22-19-0-oc-c39b315-r2` (never reuse it for a
  different recipe or checkpoint);
- Ubuntu 22.04 / x86-64 platform assertion;
- Node 22.19.0 and its upstream archive digest;
- npm 10.9.3 from that Node archive;
- the exact OpenComputer source commit and source-archive digest;
- Go 1.25.0, used only to build `oc`, and its archive digest;
- the reproducible Linux/amd64 `oc` binary digest;
- raw installer, image-template, and materialized-manifest digests;
- the required runtime `networkPolicy=public`; and
- the hardened runtime contract: `sandbox` uid/gid 1000 with no supplementary
  groups, no `sudo` path, host-only guest-agent control, a root-owned read-only
  toolchain, and writable `/workspace`.

The named snapshot is not the complete physical coordinate. The snapshot API's
ready response supplies its immutable `checkpointId`. `snapshot.py create`
writes that ID to a receipt. The production canary and real-substrate probe
must configure both the reviewed snapshot name and that receipt's checkpoint
ID. Name-only validation is insufficient because an operator could delete and
recreate a snapshot.

The recipe starts from OpenComputer's trusted `base` image, verifies every
downloaded toolchain/source archive, and verifies the built `oc` bytes. The
checkpoint receipt freezes the resulting base and OS-package state. A future
rebuild is a new `rN` snapshot name, coordinate, and receipt even when the
toolchain versions do not change.

The base image normally grants `sandbox ALL=(ALL) NOPASSWD:ALL`. The recipe uses
that privilege only for trusted installation steps. Its penultimate step runs a
root finalizer that clears every supplementary group, removes every `sudo` path
from the root filesystem, locks the account password, restricts the active
virtio-serial/Unix agent nodes to root, makes `/opt/opencomputer` root-owned and
non-writable, preserves the user-owned workspace, installs a read-only runtime
verifier, and removes the installer. Removing `sudo` avoids relying on parsing
its alias/group/include policy language. The last image step runs the verifier
as the ordinary sandbox user. No privileged step follows finalization.

`osb-agent` is a root PID-1 gRPC server whose trusted host API necessarily
includes root exec, filesystem operations, and binary upgrade. Its AF_VSOCK
listener accepts only Linux host CID 2; guest-local/own-CID connections are
closed before gRPC sees them. The virtio-serial device and Unix fallback are
mode `0600`. This keeps host orchestration working without exposing that RPC
surface to untrusted lifecycle scripts.

## Offline validation

These commands perform no API calls and create nothing:

```bash
python3 deploy/flue-builder/snapshot.py check
python3 ci/flue-builder-substrate-probe.py --check
```

They verify the shell syntax, recipe digests, materialized manifest, memory
settings, runtime policy, finalizer ordering, generated runtime-verifier
syntax, and the installer-emitted security/toolchain attestation. CI runs both.

## Create a new production canary after review

There is no separate development environment for this proof. Snapshot creation
is therefore an explicit, billable production write and is not part of routine
branch validation. First review the evergreen branch, merge the latest `main`
into it, and agree the new canary snapshot/resource plan. Never repoint, delete,
replace, or rebuild an existing snapshot/resource without separate operator
approval. If the reviewed name is already occupied by any earlier resource,
stop and bump the `rN` name plus every recipe coordinate before creating
anything.

With that plan approved, load a production operator key without printing it and
run:

```bash
export OPENCOMPUTER_API_URL='<approved-production-api>'
export OPENCOMPUTER_API_KEY='...'
export AGENT_BUILD_SNAPSHOT_ALLOW_CREATE=1
export AGENT_BUILD_SNAPSHOT_ALLOW_PRODUCTION=1

python3 deploy/flue-builder/snapshot.py create \
  --confirm-name flue-build-node22-19-0-oc-c39b315-r2 \
  --receipt /secure/operator-state/flue-build-node22-19-0-oc-c39b315-r2.json
```

The command never deletes or replaces a snapshot. Its existing-name path is
validation-only and succeeds only for the exact pinned manifest, but the
operator plan above still requires asking before using an existing resource. A
mismatch fails and requires a new snapshot name. Known production hosts require
the separate `AGENT_BUILD_SNAPSHOT_ALLOW_PRODUCTION=1` guard; local HTTP
requires `AGENT_BUILD_SNAPSHOT_ALLOW_HTTP=1`.

Store the receipt in the deployment system's non-secret release metadata. Do
not commit environment files or API keys. Configure the build worker from the
receipt:

```text
AGENT_BUILD_SANDBOX_SNAPSHOT=flue-build-node22-19-0-oc-c39b315-r2
AGENT_BUILD_SANDBOX_CHECKPOINT_ID=<receipt checkpointId>
AGENT_BUILD_NODE_VERSION=22.19.0
AGENT_BUILD_NETWORK_POLICY=public
```

For the fastest safe P1 path, use this same hardened snapshot/checkpoint for the
token-bearing source sandbox and the tokenless build sandbox until a smaller,
independently pinned source image exists:

```text
AGENT_SOURCE_SANDBOX_SNAPSHOT=flue-build-node22-19-0-oc-c39b315-r2
AGENT_SOURCE_SANDBOX_CHECKPOINT_ID=<same receipt checkpointId>
```

They remain separate ephemeral sandboxes with different inputs: only the source
sandbox's controlled Git exec receives the short-lived repository token; the
build sandbox receives tokenless source bytes. Sharing an immutable base does
not merge those trust boundaries. Worker readiness must compare both live
snapshot names and checkpoint IDs to these coordinates before claiming source
or build work.

## Real-substrate proof

The live probe creates two short-lived sandboxes from the same checkpoint:

1. an explicitly authorized unrestricted control, proving that the private
   canary, link-local metadata service, and guest-to-host service are actually
   live; and
2. the final `networkPolicy=public` sandbox, proving public npm registry and
   tarball access succeeds while those targets and inbound exposure fail.

It also requires the `sudo` binary to be absent, uid/gid 1000 to have no
supplementary groups, writes and deletes a workspace probe, verifies exact
Node/npm/`oc` versions and the `oc` digest, and checks root ownership/read-only
modes for the trusted binaries. An adversarial uid-1000 check sends an HTTP/2
preface to guest-local AF_VSOCK and Unix agent endpoints and fails if root gRPC
answers; it also tries to open every known virtio-serial agent node. It checks
that
the create response has no host port, proves a temporary non-secret server is
publicly reachable through the unrestricted control, then requires preview
creation to return 409 and the equivalent restricted guest server to remain
unreachable. Finally it scans guest process environments plus common
configuration files for exact credential sentinel values; the trusted file API
inspects PID 1 without restoring sudo to repository code. The raw adapter
constructs request bodies from an allowlist and never forwards the coordinator
process environment. Both sandboxes are destroyed in `finally`; a teardown
failure makes the probe fail and prints only the sandbox ID for operator
cleanup.

Provide a newly provisioned, disposable HTTP(S) production canary at a literal
RFC1918 or CGNAT address. It must be reachable from the newly approved
unrestricted control sandbox and return a short, non-secret marker. Do not put
credentials in its URL or marker. Then run:

```bash
export OPENCOMPUTER_API_URL='<approved-production-api>'
export OPENCOMPUTER_API_KEY='...'
export AGENT_BUILD_SANDBOX_SNAPSHOT='flue-build-node22-19-0-oc-c39b315-r2'
export AGENT_BUILD_SANDBOX_CHECKPOINT_ID='<receipt checkpointId>'
export AGENT_BUILD_NODE_VERSION='22.19.0'
export AGENT_BUILD_PRIVATE_CANARY_URL='http://10.0.0.10:8080/flue-probe'
export AGENT_BUILD_PRIVATE_CANARY_EXPECT='flue-private-canary-ok'
export AGENT_BUILD_PROBE_ALLOW_UNRESTRICTED_CONTROL=1
export AGENT_BUILD_PROBE_ALLOW_PRODUCTION=1

python3 ci/flue-builder-substrate-probe.py --run
```

The script refuses known production hosts unless
`AGENT_BUILD_PROBE_ALLOW_PRODUCTION=1` is also set, and refuses HTTP control
planes unless `AGENT_BUILD_PROBE_ALLOW_HTTP=1` is set. The unrestricted control
guard is deliberately separate: without it, a policy regression could look
like a passing denial test merely because the target was down.

This repository does not create the production canary snapshot or run the live
proof in CI. They require the reviewed evergreen branch integrated with latest
`main`, deployed sandbox-policy code, a newly approved resource plan, a real
checkpoint receipt, a private control canary, and explicit operator authority.
Record the exact receipt and probe result in the cross-repository working
document after that controlled production-canary run.
