# Self-hosted computer: the host ↔ gateway contract

One VM runs two things:

- **The gateway**: the hosted gateway (`services/managed-agents`) under Miniflare, a container
  built from `selfhost/gateway/Dockerfile` and run by `selfhost/compose.yaml` (PR #1253). It
  handles the API, Slack, `/setup`, its state in the `/data` volume, and the tunnel.
- **The host agent and its sessions**: systemd services and rootless Podman, set up by
  `selfhost/host-install.sh` (stream A, this directory).

This file is everything one side assumes about the other. Unmarked facts come from the code, with the file named. Anything marked **PROPOSED** is a choice made here that the code does not fix yet; stream B should match it or change it here. The names below were checked against #1253's `selfhost/compose.yaml`, `selfhost/.env.example` and `selfhost/gateway/serve.mjs`, and the connection in §1, §2 and §8 was run on an Azure test VM (see §9).

## 1. The connection

| | Value | Source |
|---|---|---|
| Direction | host → gateway, outbound only. The gateway never calls a service on the host (not the host agent, not oc-modelproxy); it sends hosts their credentials over the host's WebSocket. | `src/host/gateway-link.ts` |
| Protocol | WebSocket on the Computer path, **`/v1/computer/host?organizationId=<GATEWAY_ORG>`**, as the hosted gateway. | `services/managed-agents/src/http/host/upgrade.ts` |
| Auth | `Authorization: Bearer <SP_HOST_TOKEN>` on the upgrade, the organization's host token (§2). A bad token gets a 401. | `gateway-link.ts`, `actors/computer/host-link/host-token.ts` |
| Host id | `SP_HOST_ID` = the organization, `GATEWAY_ORG` (default `org_selfhost`). | `selfhost/.env.example` (#1253) |
| Gateway port in the container | **8080**. | `selfhost/compose.yaml` (#1253) |
| Published port on the VM | **`127.0.0.1:${GATEWAY_PORT:-8080}:8080`**: loopback only. `GATEWAY_PORT` is in compose's `.env` and is passed into the container too, so the gateway knows it. | `selfhost/compose.yaml` (#1253) |
| Host's URL | **`SP_GATEWAY_URL=ws://127.0.0.1:8080/v1/computer/host?organizationId=org_selfhost`**: plain ws over loopback, never through the tunnel. `host-install.sh --link-gateway` builds it from the container's `GATEWAY_PORT` and `GATEWAY_ORG`, so the two cannot drift; `host-install.sh` refuses any other shape. | `selfhost/host-install.sh` |
| Health check | `GET /healthz` on the same port returns 200 with `{"ok":true,"mode":"miniflare"}`. It has no host count: the host's journal says `connected to ws://127.0.0.1:8080/v1/computer/host?organizationId=…`, and `/setup`'s Host step shows **connected**. | `selfhost/gateway/serve.mjs` |

`/setup`'s Host step shows the same URL, `SP_HOST_ID` and the token masked (`sph_••••`), as a one-line install command; "Reveal" shows it with the token. `--link-gateway` does the same without the browser and without the token passing through a terminal.

## 2. The host token

| | |
|---|---|
| Gateway side | `/data/host-token` in the gateway's volume, mode 0600, written by the gateway at every start: `sph_` + base64url(HMAC-SHA256(`COMPUTER_HOST_TOKEN_KEY`, `"calvin-host:" + GATEWAY_ORG`)). The key is generated once into `/data/keys.json`, so the token is stable as long as the volume is; nothing is set in the gateway's `.env`. |
| Host side | `SP_HOST_TOKEN`, in `/etc/opencomputer/selfhost.env` (root:root 0600). systemd reads it (`EnvironmentFile=`) and passes it to the host; `sp-host` cannot read the file, and `agent` (the sessions) can read neither. |
| Format | `sph_` followed by base64url characters. `--link-gateway` refuses anything else. |

**How the token gets from the gateway to the host** (`sudo selfhost/host-install.sh --link-gateway`, as run on the VM):

1. as `oc-gateway`, find the compose stack's gateway container (label `com.docker.compose.service=gateway`; `GATEWAY_CONTAINER=` names one when there are several);
2. `podman exec <container> printenv GATEWAY_ORG GATEWAY_PORT` and `podman exec <container> cat /data/host-token`, the token captured into a shell variable;
3. write `SP_GATEWAY_URL`, `SP_HOST_ID` and `SP_HOST_TOKEN` into a 0600 temp file next to `selfhost.env` (its other lines kept; `printf`, a shell builtin, so the token is on no command line), then `mv` it over `selfhost.env` (root:root 0600);
4. restart `slack-presence-host`.

The token is never printed, logged, committed or passed as an argument. The log line names only where it came from. Rerun `--link-gateway` after the gateway's volume is recreated (a new key means a new token); a plain gateway restart keeps it.

## 3. Environment variables

### Host: `/etc/opencomputer/selfhost.env` (operator's; `selfhost/selfhost.env.example`)

| Var | Req | Default | Meaning |
|---|---|---|---|
| `SP_GATEWAY_URL` | yes | `ws://localhost:3171/host` (code) | `ws://127.0.0.1:<GATEWAY_PORT>/v1/computer/host?organizationId=<GATEWAY_ORG>` (§1); written by `--link-gateway` |
| `SP_HOST_TOKEN` | yes, **secret** | empty → 401 | `/data/host-token` (§2); written by `--link-gateway` |
| `SP_HOST_ID` | yes | hostname | `GATEWAY_ORG` (`org_selfhost`); written by `--link-gateway` |
| `SP_RUNNER_MEMORY_MAX`, `SP_IDLE_MS`, `SP_POOL_SIZE`, `SP_ARTIFACTS_IDLE_HOURS`, `SP_SWEEP_AGE_MS`, `SP_FETCH_INTERVAL`, `SP_FETCH_TIMEOUT`, `SP_FORK_FETCH_TIMEOUT`, `SP_FORK_FETCH_FRESH`, `SP_FORK_RETENTION_DAYS` | no | code defaults | tuning (`src/host/host-config.ts`, `src/workspaces/clones.ts`) |
| `SP_TELEMETRY_URL`, `SP_TELEMETRY_CREDENTIAL`, `SP_REGION`, `SP_SUBSTRATE` | no | unset: nothing leaves | leave unset |

### Host: set by the units (written by `host-install.sh` and the fleet scripts it calls; not the operator's)

| Var | Value | Set by |
|---|---|---|
| `SP_LAUNCH` | `podman` | drop-in `20-sp-host.conf` (`deploy/vm/sp-host.sh`, from `/etc/slack-presence/sp-launch`) |
| `SP_RUNNER_USER` | `agent` | same drop-in |
| `SP_RUNNER_PATH` | the agent's PATH | same drop-in |
| `SP_MODEL_PROXY` | `/run/oc-modelproxy/control.sock` | same drop-in |
| `SP_IMAGE`, `SP_IMAGE_ABI`, `SP_VERSION` | session image (digest), `deploy/image/ABI`, release commit | `/opt/slack-presence/current/.sp-version.env` |
| `SP_DATA`, `SP_RUN`, `SP_DEFINITION` | `/data`, `/run/slack-presence`, `…/current/definitions/computer.json` | `slack-presence-host.service` |
| `HOME`, `PATH`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `DISABLE_AUTOUPDATER` | sp-host's home and PATH; `/run/user/1500`; its bus; `1` | unit and drop-in |
| `SP_MODEL_SOCKET` | unset → `/run/oc-modelproxy/api.sock` | code default |

`SP_LAUNCH=podman` without `SP_RUNNER_USER`, `SP_IMAGE` or `SP_IMAGE_ABI` stops the host at start (`host-config.ts:98-101`).

### oc-modelproxy

Reads no configuration from the environment and never talks to the gateway. Model credentials reach it from the gateway through the host, over `control.sock`. It does **not** get `selfhost.env`: that would hand it the host token for nothing.

### Gateway container (#1253's `selfhost/.env.example`; listed so nothing is set on the wrong side)

| Var | Req | Secret | Notes |
|---|---|---|---|
| `SETUP_TOKEN` | **yes** | yes | `/setup`'s sign-in and the operator's bearer on `/v1/computer/*` |
| `PUBLIC_URL` | for Slack | | public `https://` origin of the tunnel (`SP_ORIGIN` is its older name) |
| `GATEWAY_ORG` | no | | the one organization; default `org_selfhost`. The host's `SP_HOST_ID` and the URL's `organizationId` |
| `GATEWAY_PORT` | no | | the VM side of the loopback port, default 8080 (§1) |
| `SP_SETUP_OPEN` | no | | `1`: `/setup` stays open after the Claude credential is set and the host connected |
| `ANTHROPIC_API_KEY` | no | yes | the sessions' shared key; `/setup` can store one instead (encrypted in `/data`) |
| `ATTACHMENTS_S3_ENDPOINT`, `ATTACHMENTS_S3_BUCKET`, `ATTACHMENTS_S3_ACCESS_KEY_ID`, `ATTACHMENTS_S3_SECRET_ACCESS_KEY` | no | the key pair | an S3-compatible store (R2, S3, MinIO) for attachments, used when all four are set; `ATTACHMENTS_S3_REGION` is optional (default `auto`). Unset: attachments are in the volume (`r2/`), see below |
| `CLOUDFLARE_TUNNEL_TOKEN`, `NGROK_*` | for a tunnel profile | yes | |

None of the gateway's variables are needed on the host, and none of the host's on the gateway. The host's three values come from the running container (§2).

Attachments without `ATTACHMENTS_S3_*`: the gateway keeps the bytes in its `ATTACHMENTS` bucket (Miniflare's R2, in the volume) and serves them itself. The API hands a client a URL of the gateway's own, `<origin>/v1/computer/attachment-objects/<org>/<session>/<id>?…&sig=…`, signed with `ATTACHMENTS_URL_KEY` (generated into `/data/keys.json`); the router sends `/v1/*` to managed-agents, so the URL needs no sign-in, only its signature. `<origin>` is the one the caller reached the API at: api-edge passes it on (`x-opencomputer-public-origin`), a direct `/v1/computer` caller's request has it, and `PUBLIC_URL` is the fallback. Sessions fetch attachments at `PUBLIC_URL`, as they reach the rest of the API (`services/managed-agents/src/http/api/attachment-objects.ts`, `src/actors/org/attachment-store.ts`).

## 4. Ports

| Port | Bound to | Owner | Public? |
|---|---|---|---|
| 8080 | `127.0.0.1` on the VM (container `0.0.0.0:8080`) | gateway | **no**; reached from outside only through the tunnel **PROPOSED** |
| tunnel → `127.0.0.1:8080` | outbound from the VM | cloudflared/ngrok (stream B) | the only public ingress |
| none | | host agent | the host listens on no TCP port; it uses unix sockets under `/run/slack-presence` |
| 7070 | `127.0.0.1` | host's preview proxy | only when the gateway sends a preview config, which the Node gateway does not; unused here |
| 7071 | `127.0.0.1` | client relay (`slack-presence-wire`) | not installed on a self-hosted computer |

The VM's firewall needs no inbound port besides SSH.

## 5. Paths and volumes

| Path | Owner | What |
|---|---|---|
| `/etc/opencomputer/selfhost.env` | root 0600 | host's env (§3) **PROPOSED** path |
| `/etc/opencomputer/selfhost.env.example` | root 0644 | copy of the example, rewritten every install |
| `/opt/slack-presence/{releases/<commit>,current}` | root | host code. Session containers mount `/opt/slack-presence` read-only (`src/host/sandbox/podman-args.ts`), so the path is fixed |
| `/data` | root | host state root (`SP_DATA`). A directory, or a disk the operator mounts there first |
| `/data/people`, `/data/home/agent` | agent | workspaces, session forks, the agent's home |
| `/data/containers/storage` | agent | rootless Podman storage (images, session containers) |
| `/data/state`, `/data/journals` | sp-host | host identity, gateway definition, sandbox records; session journals |
| `/run/slack-presence` | sp-host:agent | runner sockets (tmpfiles) |
| `/run/oc-modelproxy/{api,control}.sock` | modelproxy | sessions' model socket (group agent); host's control socket (group sp-host) |
| gateway volume, mounted at `/data` in the container | the gateway | Miniflare's state (`do/`, `d1/`, `r2/`, `kv/`), `keys.json` and `host-token`. Named volume `gateway-data`, in `oc-gateway`'s Podman storage. It is not the host's `/data`; never bind the host's `/data` into the gateway. Back it up whole |
| `/var/lib/oc-gateway/selfhost`, `/var/lib/oc-gateway/services/managed-agents` | oc-gateway | the compose stack, copied from the host's checkout by `host-install.sh` (compose builds from `/var/lib/oc-gateway`); `selfhost/.env` holds the gateway's secrets (0600) |

## 6. Users

| User | uid | Runs |
|---|---|---|
| `agent` | 1500 (fixed: the image and `podman-args.ts` use 1500) | the user sessions run as inside their rootless Podman containers, and the owner of those containers on the host. Has subuid/subgid, lingering, no sudo on the host (sessions may use sudo inside their container), never in group docker. Never runs the compose stack |
| `sp-host` | system | the host agent. May run commands as `agent` (sudoers); cannot read `selfhost.env` (systemd passes it in) |
| `modelproxy` | system | oc-modelproxy |
| `oc-gateway` (`GATEWAY_USER`) | system, made by `host-install.sh`, home `/var/lib/oc-gateway` (0750) | the compose stack: rootless Podman of its own, subuid/subgid above every other range, lingering, `podman-restart.service` enabled. Its Podman config is its own (`~/.config/containers/storage.conf` and `containers.conf`, rewritten only while they start with `# host-install.sh`): storage under its home, not the system-wide `/data/containers/storage` that is the agent's; networks in `/srv/oc-gateway/networks`, because rootless Podman 4.9 hides `/var/lib` behind a tmpfs in its network namespace; container logs to files (`k8s-file`), since a system user cannot read its journald logs. No sudo, not in groups `agent` or `sp-host`. An existing login user may be named instead; never `agent`, `sp-host` or root |
| `node` | in the container | the gateway |

The compose stack runs as the dedicated `oc-gateway` user (or the one `GATEWAY_USER` names), never as `agent`, `sp-host` or root. `agent` (uid 1500) is only the sessions' user. Sessions run tools as `agent` with no permission prompts, so whatever `agent` can read, a session can read: as `agent`, `podman inspect` would show the gateway's environment, every secret it holds.

## 7. Compose tooling (installed by `host-install.sh`)

| | |
|---|---|
| Compose | `podman-compose` 1.6.0 (`PODMAN_COMPOSE_VERSION`, refused below 1.1.0) in a venv at `/opt/podman-compose`, linked at `/usr/local/bin/podman-compose`, ahead of Ubuntu's 1.0.6 on PATH (1.0.6 ignores `profiles:`, so the tunnel services would not start). `podman compose` runs it. Docker Compose v2 reads the same file, but this script installs no Docker. |
| Reboot and crashes | #1253's `selfhost/systemd/opencomputer-gateway.service`, a user unit of `oc-gateway` (lingering) that runs `podman-compose up --abort-on-container-exit` with `Restart=always`. `restart: always` alone is not enough: rootless Podman leaves a `podman kill`ed container `Exited (137)`. `podman-restart.service` stays enabled for the `restart: always` services. Lingering also gives Podman the user session it needs for healthchecks. |
| Where compose runs | as `oc-gateway`, from `/var/lib/oc-gateway/selfhost`. `host-install.sh` copies `selfhost/` and `services/managed-agents/` there from its checkout's HEAD, owned by `oc-gateway`, on every install (compose builds `selfhost/gateway/Dockerfile` from `/var/lib/oc-gateway`). `.env` there is `oc-gateway`'s, mode 0600, and an install keeps it. |

## 8. Order of start

1. `host-install.sh` installs everything. Without a token the host is installed but stopped.
2. The gateway starts as `oc-gateway`, from `/var/lib/oc-gateway/selfhost` (`podman compose up -d`, or the user unit). On first start it generates its keys and writes `/data/host-token`.
3. `sudo selfhost/host-install.sh --link-gateway` writes the host's URL, id and token (§2) and starts the host. Until the gateway answers, the host retries on its own (`Restart=always`, and the link reconnects).
4. Check: `journalctl -u slack-presence-host | grep 'connected to'`, or `/setup`'s Host step.

## 9. Verified

On an Azure test VM (Ubuntu 24.04, Podman 4.9.3, podman-compose 1.6.0), driven only through `az vm run-command`, with #1253's gateway (compose project under `oc-gateway`) and this script:

- `host-install.sh` built the release, pulled the session image by digest and installed the host as `sp-host` with `SP_LAUNCH=podman` (after the two fixes in `6a8655f5`: `HOME` for `go build`, and Podman's version checked as `agent`).
- The host connected to `ws://127.0.0.1:8080/v1/computer/host?organizationId=org_selfhost` as `org_selfhost` with the token from `/data/host-token`; sessions ran turns in rootless Podman containers (runners up in about 600 ms).
- `--link-gateway` rewrote `selfhost.env` (root:root 0600, the three values identical to the ones tested by hand, the other 51 lines kept), restarted the host, which took back its live session container in 3 ms and reconnected. Run from the checkout under a directory `oc-gateway` cannot enter, it works too (it changes to `/` first).
- The host reconnected on its own after a `podman kill` of the gateway (6.3 s), a gateway restart and a VM reboot (13 s after boot).
