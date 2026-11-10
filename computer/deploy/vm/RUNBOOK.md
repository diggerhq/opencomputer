# Computer runbook: the client relay (work 084)

What runs on a computer for the Computer API's WebSocket and `/files`, where
its logs are, and how to find why a client cannot connect. Commands run as
root on the computer (Azure Run Command or a shell through the host).

## The pieces

| Piece | Where | Owns |
|---|---|---|
| Wire Worker | blue, `wire.opencomputer.dev` | Checks the key (Workers KV, `sha256(key)`) or ticket on the upgrade, signs `X-Wire-*` headers, forwards through the computer's tunnel. Nothing per frame. |
| Tunnel | cloudflared, a child of the host (`src/host/cloudflared.ts`) | Ingress `<tunnelId>.w.opencomputer.dev` → `127.0.0.1:7071` (previews keep `127.0.0.1:7070`). Config is the tunnel's, written by blue. |
| Relay | `slack-presence-wire.service`, user `sp-wire`, `dist/wire.js` (`src/wire/`) | Verifies the edge signature, holds connections, frames each session to its writer, serves `/files`. No credential, no session logic. |
| Host wire link | the host (`src/host/wire-link.ts`), `$SP_RUN/wire/wire.sock`, 0660 `:sp-wire` | Gives the relay the edge key, who may attach to what, where each session's writer is, terminals and workspace files. |
| Writer | the session's runner, or the host's session writer while it has none: `$SP_RUN/runners/<id>.api.sock` | The session's journal, replay and writes. |

The relay unit runs only on a computer whose host is `sp-host`
(`/etc/slack-presence/host-user-sp-host`, `deploy/vm/sp-host.sh migrate`) and
whose release has `dist/wire.js`; elsewhere `systemctl status` shows the
condition failed, and that is expected. `sp-host.sh revert` stops it.

The unit: `Restart=always` (1 s), `MemoryMax=256M`, `TasksMax=256`, loopback
only (`IPAddressAllow=localhost`), no capabilities, no sudo, `/data`
inaccessible, none of `host.env`. A restart closes every client with `1012`;
clients reconnect and reattach with `after`, losing nothing.

## Logs and health

```sh
systemctl status slack-presence-wire
journalctl -u slack-presence-wire -n 200 --no-pager      # the relay
journalctl -u slack-presence-host -n 200 --no-pager | grep -i wire   # the host's side of the link
curl -s 127.0.0.1:7071/health                            # {"host":true,"key":true,"connections":N}
ls -l /run/slack-presence/wire/                          # wire.sock: <host user>:sp-wire 0660
id sp-wire; id sp-host                                   # sp-wire in agent; sp-host in agent and sp-wire
sysctl kernel.yama.ptrace_scope                          # 1
```

`/health` answers 503 until the host link is up and the host has sent the edge
key; until then a signed upgrade is accepted and closed with `4503` (an
unsigned one gets HTTP 401 before any handshake).

The relay's counters (connections, attaches, errors by code, detaches by
reason, close codes, per-frame overhead) go to the host each minute over
`wire.sock`, and the host ships them with telemetry label `wire`; they are not
in the relay's journal. Its journal has start, stop, the host link and errors.

## Close codes, as the client sees them

| Code | Meaning | Look at |
|---|---|---|
| HTTP 401 before the upgrade | X-Wire-Auth missing, malformed or outside its expiry window | the caller is not the Worker (a local process), or clock skew |
| HTTP 403 before the upgrade | edge signature does not verify | the Worker's signing key vs the key in the host's `welcome` (a key rotation not yet pushed); clock skew |
| `4503 {"retryAfterMs"}` | relay up, host link or edge key not | `/health`; the host's log; `wire.sock` permissions |
| `4400` | the client did not offer `opc.v1`, or its build is retired | the client |
| `4029` | more than 50 connections for one member | a client leaking connections |
| `4001` | credential expired or revoked (ticket hour, key `expiresAt`, revocation pushed by blue) | expected; the client reconnects with a fresh credential |
| `4008` | the client stopped reading (over 16 MiB waited to be sent) | the client or its network |
| `1009` | a client frame over 1 MiB | the client |
| `1001` | two missed pings | network; cloudflared restarts |
| `1012` | the relay restarted (deploy, crash, OOM) | `journalctl -u slack-presence-wire`; `systemctl show -p NRestarts slack-presence-wire` |
| `1006` (no close frame) | the connection was cut below the relay | the tunnel or the Worker |

## Triage: "the client cannot connect"

Walk the path from the outside in, and stop at the first step that fails.

1. **KV (the credential).** `opc` gets 401 or the Worker refuses the upgrade:
   the key is missing from Workers KV, revoked or expired, or its record names
   another computer or `tunnelId`. Check in blue that the key exists and that
   its KV record (`sha256(key)`) has this computer's current `tunnelId` (a
   tunnel change rewrites every key's record). A revocation takes up to 60 s
   to leave KV.
2. **Worker.** `wrangler tail` on the wire Worker (`wrangler.wire.jsonc`):
   the upgrade arrives, the KV lookup hits, and the tunnel fetch is made.
   An accepted upgrade closed at once with a code is the Worker refusing
   (browsers would see only `1006` for a failed upgrade, so it accepts first).
3. **Tunnel.** On the computer: `journalctl -u slack-presence-host | grep cloudflared`
   (running, registered, not restarting). The tunnel's config must have the
   `w.` ingress to `127.0.0.1:7071`; without it the Worker's fetch gets a
   cloudflared 404 or 502. `curl -s 127.0.0.1:7070/` answering means the
   tunnel's other leg (previews) is fine and the problem is the wire rule.
4. **Relay.** `systemctl status slack-presence-wire` (active? condition
   failed means not sp-host or no `dist/wire.js`: migrate, or redeploy a
   release with the bundle), then `curl 127.0.0.1:7071/health`.
   `"host":false` → step 5's host side; `"key":false` → the host has no edge
   key yet (no `welcome` with it from blue since the host started). A 403 in
   the relay log is a signature the relay could not verify (see the table).
   Many restarts → `journalctl -u slack-presence-wire -p warning`, OOM kills
   in `journalctl -k | grep -i oom`.
5. **Writer.** Connected but a session will not attach or its events stop:
   `session_not_found` → the session is not in this member's access list
   (the host's view from blue); `unavailable` → no writer socket: is the
   runner alive (`ls -l /run/slack-presence/runners/<cs_id>.api.sock`, mode
   0660, group agent) or, with no runner, the host's session writer; a
   suspended session replays but does not resume without `resume`. The host
   log has the writer's side.

## Restarting and rolling back

```sh
systemctl restart slack-presence-wire     # clients see 1012 and reconnect
systemctl stop slack-presence-wire        # the API's live wire is down; HTTP reads still work (served by blue)
```

A release rollback (`self-update.sh` to an older commit) restarts the relay
with that release's bundle. The relay keeps no state of its own: restarting it
never loses an event.
