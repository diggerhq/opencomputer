# Self-hosted computer: the host ↔ gateway contract

One VM runs two things:

- **The gateway**: a container built from `computer/Dockerfile`, run by
  `selfhost/compose.yaml` (stream B). It handles Slack, `/setup`, SQLite and the tunnel.
- **The host agent and its sessions**: systemd services and rootless Podman, set up by
  `selfhost/host-install.sh` (stream A, this directory).

This file is everything one side assumes about the other. Unmarked facts come from the code, with the file named. Anything marked **PROPOSED** is a choice made here that the code does not fix yet; stream B should match it or change it here. The names below were checked against stream B's `selfhost/compose.yaml`, `selfhost/.env.example` and `docs/self-hosting/single-vm.mdx` (PR #1203 at 9d75f9c9).

## 1. The connection

| | Value | Source |
|---|---|---|
| Direction | host → gateway, outbound only. The gateway never calls a service on the host (not the host agent, not oc-modelproxy); it sends hosts their credentials over the host's WebSocket. | `src/host/gateway-link.ts` |
| Protocol | WebSocket on path **`/host`**. The gateway destroys an upgrade on any other path. | `src/gateway/hosts.ts:103-108` |
| Auth | `Authorization: Bearer <SP_HOST_TOKEN>` on the upgrade. A bad token gets a 401. | `gateway-link.ts:46`, `hosts.ts` |
| Host id | `hostId` field of the `hello` message (not a header). Defaults to the hostname. | `src/host/identity.ts:45` |
| Gateway port in the container | **8080**. The image sets `PORT=8080`; the gateway listens on `0.0.0.0:$PORT`. Without the image's env the default is 3170. | `computer/Dockerfile`, `src/gateway/main.ts:57` |
| Published port on the VM | **`127.0.0.1:${GATEWAY_PORT:-8080}:8080`**: loopback only. `GATEWAY_PORT` is in compose's `.env`. | `selfhost/compose.yaml` (#1203) |
| Host's URL | **`SP_GATEWAY_URL=ws://127.0.0.1:8080/host`**: plain ws over loopback, never through the tunnel. If `GATEWAY_PORT` changes, change this port with it; nothing checks that the two match. | `selfhost/selfhost.env.example` |
| Health check | `GET`/`HEAD /healthz` on the same port returns 200 with `{"ok":true,"mode":"setup"\|"slack","version":"…","hosts":<connected hosts>}`. `hosts` is how to check that the host connected. | `src/gateway/main.ts:199-200` |

The gateway's `/setup` "Host" step prints `SP_GATEWAY_URL=<SP_ORIGIN>`, which is the bare public `https://…` origin, not a `ws(s)://…/host` URL (`src/setup/index.ts:388-398`). Two consequences on a self-hosted computer:

- Do not paste that value as the host's URL. Use the loopback URL above.
- The token that step prints is fine to use (see §2).

## 2. The host token

| | |
|---|---|
| Host side | `SP_HOST_TOKEN`, in `/etc/opencomputer/selfhost.env` (root:root 0600, read by systemd only). |
| Gateway side, either | `SP_HOST_TOKENS`, a comma-separated list in the gateway container's environment, compared as is (`src/gateway/main.ts:121`); |
| or | a token issued by `POST /setup/host`: `sph_` + base64url(32 random bytes), shown once, only its sha256 kept in SQLite `host_tokens` (`src/setup/hosts.ts:19`). |
| Format | Any non-empty string without commas or whitespace works for `SP_HOST_TOKENS`. |

**PROPOSED flow (one token, generated once on the VM):**

1. stream B's setup step (or the operator) runs `openssl rand -hex 32` once;
2. it writes the value into `/var/lib/oc-gateway/opencomputer/selfhost/.env` as `SP_HOST_TOKENS=<value>`;
3. it writes the same value into `/etc/opencomputer/selfhost.env` as `SP_HOST_TOKEN=<value>`;
4. it runs `sudo selfhost/host-install.sh` (or `systemctl restart slack-presence-host`).

The value is never printed, never committed and never passed on a command line. Issuing it from `/setup` instead also works and needs no gateway env, but it adds a manual browser step before the host can connect.

`host-install.sh` never writes `selfhost.env` and never generates the token. It starts the host only once `SP_HOST_TOKEN` there is non-empty.

## 3. Environment variables

### Host: `/etc/opencomputer/selfhost.env` (operator's; `selfhost/selfhost.env.example`)

| Var | Req | Default | Meaning |
|---|---|---|---|
| `SP_GATEWAY_URL` | yes | `ws://localhost:3171/host` (code) | `ws://127.0.0.1:8080/host` here **PROPOSED** |
| `SP_HOST_TOKEN` | yes, **secret** | empty → 401 | §2 |
| `SP_HOST_ID` | no | hostname | `selfhost` in the example. Keep it stable across reinstalls. |
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

### Gateway container (stream B; listed so nothing is set on the wrong side)

| Var | Req | Secret | Notes |
|---|---|---|---|
| `PORT` | no | | 8080 from the image; keep it |
| `SP_DB` | no | | `/data/gateway.db` from the image |
| `SP_ORIGIN` | **yes** | | public `https://` origin of the tunnel (OAuth redirects, `/setup` output) |
| `SETUP_TOKEN` | **yes** | yes | `/setup` answers 503 without it |
| `SP_STORE_KEY` | **yes** | yes | `openssl rand -hex 32`. Encrypts the setup store and session-secret vault; without it nothing can be saved |
| `SP_HOST_TOKENS` | yes (PROPOSED flow) | yes | §2. Optional in compose (`/setup` can issue one instead) |
| `GATEWAY_PORT` | no | | compose only: the VM side of the loopback port, default 8080 (§1) |
| `GITHUB_ORG` | for `/setup`'s GitHub step | | |
| `SP_PEOPLE`, `PERMISSION_MODE`, `SLACK_APP_NAME`, `MODEL`, `SP_GITHUB_API_URL`, `SP_VERSION` | no | | |
| Slack, model and GitHub credentials (`SLACK_*`, `MODEL_PROFILE`/`MODEL_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_*`) | via env or `/setup` | yes | read env first, then the encrypted store (`src/gateway/main.ts:80`) |

None of the gateway's variables are needed on the host, and none of the host's on the gateway, except the shared token value.

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
| gateway volume, mounted at `/data` in the container | node (entrypoint chowns) | `gateway.db`. Named volume `gateway-data`, in `oc-gateway`'s Podman storage. It is not the host's `/data`; never bind the host's `/data` into the gateway |
| `/var/lib/oc-gateway/opencomputer/{selfhost,computer}` | oc-gateway | the compose stack's copy of the repository; `selfhost/.env` holds the gateway's secrets (0600) |

## 6. Users

| User | uid | Runs |
|---|---|---|
| `agent` | 1500 (fixed: the image and `podman-args.ts` use 1500) | session containers, rootless Podman. Has subuid/subgid, lingering, no sudo, never in group docker |
| `sp-host` | system | the host agent. May run commands as `agent` (sudoers); cannot read `selfhost.env` (systemd passes it in) |
| `modelproxy` | system | oc-modelproxy |
| `oc-gateway` (`GATEWAY_USER`) | system, made by `host-install.sh`, home `/var/lib/oc-gateway` (0750) | the compose stack: rootless Podman of its own, subuid/subgid above every other range, lingering, `podman-restart.service` enabled. Its Podman config is its own (`~/.config/containers/storage.conf` and `containers.conf`, rewritten only while they start with `# host-install.sh`): storage under its home, not the system-wide `/data/containers/storage` that is the agent's; networks in `/srv/oc-gateway/networks`, because rootless Podman 4.9 hides `/var/lib` behind a tmpfs in its network namespace; container logs to files (`k8s-file`), since a system user cannot read its journald logs. No sudo, not in groups `agent` or `sp-host`. An existing login user may be named instead; never `agent`, `sp-host` or root |
| `node` | in the container | the gateway |

The stack must not run as `agent`. Sessions run tools as `agent` with no permission prompts, and as `agent`, `podman inspect` would show the gateway's environment: every secret it holds.

## 7. Compose tooling (installed by `host-install.sh`)

| | |
|---|---|
| Compose | `podman-compose` 1.6.0 (`PODMAN_COMPOSE_VERSION`, refused below 1.1.0) in a venv at `/opt/podman-compose`, linked at `/usr/local/bin/podman-compose`, ahead of Ubuntu's 1.0.6 on PATH (1.0.6 ignores `profiles:`, so the tunnel services would not start). `podman compose` runs it. Docker Compose v2 reads the same file, but this script installs no Docker. |
| Reboot | `podman-restart.service` (user unit of `oc-gateway`, lingering) starts the stack's containers at boot. Ubuntu 24.04's (Podman 4.9.3) starts only `restart-policy=always`, so every service in `compose.yaml` uses `restart: always`; `unless-stopped` would not come back. Lingering also gives Podman the user session it needs for healthchecks. |
| Where compose runs | as `oc-gateway`, from `/var/lib/oc-gateway/opencomputer/selfhost`: the operator copies the checkout's `selfhost/` and `computer/` (compose builds `../computer`) into `/var/lib/oc-gateway/opencomputer`, owned by `oc-gateway`. `host-install.sh` creates that directory empty (0750). `.env` there is `oc-gateway`'s, mode 0600. |

## 8. Order of start

1. `host-install.sh` installs everything. Without a token the host is installed but stopped.
2. The gateway container starts: `podman compose up -d` as `oc-gateway`, from `/var/lib/oc-gateway/opencomputer/selfhost` (stream B).
3. The token goes into both places (§2), then the host starts or restarts. Until the gateway answers, the host retries on its own (`Restart=always`, and the link reconnects). Either side can start first.
4. Check: `curl -s 127.0.0.1:8080/healthz` shows `"hosts":1`.
