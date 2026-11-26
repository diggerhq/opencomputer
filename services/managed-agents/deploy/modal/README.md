# Modal tool-sandbox provider

Routes `sandboxEnsure` tool sandboxes at [Modal](https://modal.com) sandboxes
(`runtime="vm"`, Cloud Hypervisor). Selected per environment with
`BLUE_SANDBOX_PROVIDER=modal`; it is the only provider, and without it no
sandbox starts.

## Shape

- `src/platform/modal-sandbox.ts` — shim client. workerd cannot drive the
  Modal SDK (gRPC/node APIs), so a small FastAPI **shim** runs on Modal and
  owns sandbox lifecycle; everything past creation is plain HTTPS.
- `src/platform/tool-sandbox/modal.ts` — the Modal `ToolSandboxProvider`
  (ensure, retire, supervisor endpoint, workspace files list/export/download)
  built on that client. The interface lives in `tool-sandbox/shared.ts`, and
  `tool-sandbox/resolve.ts` decides whether Modal serves a request (account
  gate at ensure, the `sb-` id afterwards, volume existence for workspace
  files).
- `shim.py` — the shim. Deployed as a Modal app (`blue-modal-shim`). Endpoints
  give `sandboxEnsure` what it needs: create (boot + volume
  mount + run-hook delivery + tunnel), status, terminate, suspend (FS snapshot
  → terminate → image id), snapshot lookup by session — plus the volume
  filesystem endpoints behind `/v1/workspaces/*`: `list`, `stat`, `file`,
  `export` (streams a volume file into a presigned S3 PUT the platform mints),
  and `/dl` (public HMAC-signed download, the presigned-URL analog).
- `Dockerfile` — the sandbox image. There is no `amazon-efs-utils` (Modal
  Volumes hold the workspace); `python3`, `pip`, `which` and a few basics
  are installed explicitly, since agents expect them; and `dnf` runs
  with `--setopt=tsflags=nocaps` (Modal's rootless builder cannot set file
  capabilities). The base is Amazon Linux, so the package manager is `dnf`,
  not `apt-get`.
- `build-image.py` — builds that Dockerfile on Modal and publishes it as a
  named image so `Sandbox.create` never blocks on a rebuild.
  `.github/workflows/publish-modal-image.yml` runs it on every `main` push
  that changes the supervisor or the Dockerfile, and on dispatch.
- `src/microvm/supervisor.ts` accepts `fileSystem.backend: "mounted"` — the
  infrastructure attaches the volume at `/workspace`, so the supervisor skips
  its s3files mount but keeps the local-disk scratch bind mount for repos.
- `MODAL_SANDBOX_APP` — Modal app that owns the sandboxes (default on the
  shim: `opencomputer-sandboxes`).

## Lifecycle

create (~2s) → supervisor reachable over its encrypted tunnel
(`*.w.modal.host`) → turns run → lease retire / suspend →
`snapshot_filesystem` (~5s) → terminate (suspended sessions cost nothing) →
next ensure creates from the session snapshot and remounts the volume.

Tunnel auth: the platform generates a `BLUE_SANDBOX_TOKEN` per sandbox and
injects it into the sandbox env; the supervisor requires it as
`x-sandbox-token` on non-loopback requests (in-sandbox calls are loopback
and skip it). The shim stores the token per sandbox so the provider's
supervisor `endpoint` can resend it; `POST /sandboxes` is idempotent per
`session_id` so a retried ensure returns the same sandbox instead of
stranding a duplicate. Platform AWS credentials are injected for the
supervisor's own S3 artifact fetch but scrubbed from everything the agent
spawns (`sandboxChildEnv`).

Snapshot retention (2026-10-12): a session can be woken at any
point in the future, ended or not, so its latest snapshot (the
`blue-modal-snapshots` entry) is kept forever. Only a snapshot a newer one
replaced is disposable: the shim records it in
`blue-modal-superseded-snapshots` and deletes it only with
`SNAPSHOT_DELETE_SUPERSEDED=1` in the `blue-shim-config` secret. Turn that
on only after `verify-snapshot-delete.py` passes; it checks that a snapshot
taken from a sandbox restored from the previous one survives that
previous one's deletion.

`/workspace` lives on a per-workspace Modal Volume
(`MODAL_VOLUME_PREFIX + workspace.id`), so user files survive independently of
sandbox lifetime.

Workspace export/download: `/v1/workspaces/list` reads the volume through the
shim; `/export` issues a presigned S3 PUT on the artifact staging key and the
shim streams volume → bucket (bytes never transit the workerd edge); the
shim's stat-before/stat-after drift check stands in for S3's
`CopySourceIfMatch` (volumes have no ETag — a weaker guarantee worth knowing).
`/download` mints `sig = HMAC-SHA256(shim token, vol\npath\nexp)` and returns
`{MODAL_DOWNLOAD_BASE_URL}/dl?vol&path&exp&sig` — bearer, 5-minute TTL, same
trust model as a presigned S3 GET.

To keep `*.modal.run` out of client URLs the shim serves a custom domain:
set `DL_DOMAIN=dl.example.com` (comma-separate for several) on the machine
running `modal deploy`, register the domain in the Modal workspace settings,
and CNAME it at the shim's web endpoint. `MODAL_DOWNLOAD_BASE_URL` is then
`https://dl.example.com`. Without it, `/v1/workspaces/download` refuses on
the modal provider.

## Deploy

```bash
# 1. shim (Modal app). Secret `blue-shim-config` must contain BLUE_SHIM_TOKEN.
modal secret create blue-shim-config BLUE_SHIM_TOKEN=<random>
modal deploy deploy/modal/shim.py
# note the printed web URL -> MODAL_SHIM_URL

# 2. runtime image (needs `npm run build` first — the Dockerfile COPYs dist/)
python deploy/modal/build-image.py
```

## Platform worker config

| Var | Purpose |
| --- | --- |
| `BLUE_SANDBOX_PROVIDER=modal` | enable the provider |
| `MODAL_SHIM_URL` | deployed shim web URL |
| `MODAL_SHIM_TOKEN` | shared secret (wrangler secret) |
| `MODAL_SANDBOX_IMAGE` | named image, e.g. `oc-blue-runtime` |
| `MODAL_SANDBOX_APP` | Modal app for sandboxes (default `opencomputer-sandboxes`) |
| `MODAL_SANDBOX_REGION` | e.g. `us` or `us-east` (broad pins only) |
| `MODAL_SANDBOX_CPU` / `MODAL_SANDBOX_MEMORY_MIB` | defaults 2 / 4096 |
| `MODAL_VOLUME_PREFIX` | volume name prefix (default `oc-ws-`) |
| `MODAL_DOWNLOAD_BASE_URL` | public base for signed `/dl` URLs (the shim's custom domain) |
| `MODAL_ACCOUNT_ALLOWLIST` | gated rollout: comma-separated account ids whose ensures run on Modal, `*` for all (empty = nobody) |
| `MODAL_ROLLOUT_PERCENT` | gradual rollout: 0-100, deterministic account-id bucket; raising it only adds orgs |

For devin-* preview stacks these come from `OC_STACK_*` env vars via
`scripts/stack.mjs`.

## Measured (devin-modal stack)

- create → supervisor healthy: ~2.1s steady, flat to ~150 concurrent;
  500/500 concurrent creates (worst 12.5s)
- tool-call latency through a real session: shell p50 ~1.2s — same as microVM
- suspend → snapshot (~5s) → terminate → resume → first tool: ~4.7s
- known gaps: memory snapshots are gVisor-only (resume is cold-boot from the
  FS snapshot, not hibernate-faithful); `experimentalOutboundPolicy` (the
  secrets-MITM analog) is untested; `from_dockerfile` is Python/Go SDK only —
  image builds can't come from workerd/TS; export's drift check is weaker
  than S3's ETag precondition (volumes have no versioned reads); in-sandbox
  AWS SDK/CLI calls have no execution-role equivalent (platform creds are
  deliberately scrubbed from spawned processes).
