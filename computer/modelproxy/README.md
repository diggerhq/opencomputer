# oc-modelproxy

A small reverse proxy between the model clients in a computer's sessions (Claude Code, Codex, anything that takes a base URL) and the model APIs. A session's client is configured with a placeholder instead of a credential; the proxy knows which session a request comes from, puts the real credential on it and forwards it. The credential is never in the session's environment, files or logs.

Everything the proxy knows about an upstream is configuration: a **profile** names the upstream, the routes a session may call, the headers that carry the credential, and what to report back. The proxy has no built-in providers.

Go, the standard library and one dependency ([tableflip](https://github.com/cloudflare/tableflip), for the restart). One static binary.

```
session's client ──HTTP──▶ api socket ─────────┐
                                               ├─ oc-modelproxy ──HTTPS──▶ the profile's upstream
binder ──JSON lines──▶ control socket ─────────┘
```

- **API socket**: model clients. An `Authorization` or `X-Api-Key` other than the placeholder is refused.
- **Control socket**: the binder (on a computer, the host). It binds a caller to a profile and the values of its variables, and hears what upstreams answer.

## Profiles

JSON files in `-profiles` (default `/etc/oc-modelproxy/profiles.d/*.json`), each an object of name → profile, read once at start. A file with an unknown field, a profile that fails a check, or a name defined twice stops the proxy at start. `oc-modelproxy -check -profiles <dir>` runs the same load and nothing else: exit 0, or the first error and exit 1.

`profiles/default.json` ships four:

| Profile | Upstream | Routes | Credential |
|---|---|---|---|
| `anthropic-key` | `api.anthropic.com` | `POST /v1/messages`, `/v1/messages/count_tokens` | `X-Api-Key: {token}` |
| `claude-oauth` | `api.anthropic.com` | the same, for Claude Code's requests, and its two account endpoints | `Authorization: Bearer {token}` |
| `openrouter` | `openrouter.ai/api` | `POST /v1/messages`, `/v1/messages/count_tokens` | `Authorization: Bearer {token}` |
| `openai-key` | `api.openai.com` | `POST` and `WS /v1/responses`, `GET /v1/models` | `Authorization: Bearer {token}` |

Each drops the caller's `Cookie` and reports the upstream's rate-limit headers and `retry-after`.

Any Anthropic-compatible or Responses-compatible API is one more entry:

```json
{
  "my-gateway": {
    "upstream": "https://llm.example.com/anthropic",
    "routes": {
      "POST /v1/messages": {},
      "POST /v1/messages/count_tokens": {}
    },
    "set": { "Authorization": "Bearer {token}" },
    "harness": { "claude": { "tokenEnv": "ANTHROPIC_AUTH_TOKEN" } }
  }
}
```

### Reference

| Field | Meaning |
|---|---|
| `upstream` | An `https` base URL. Its path, if any, prefixes every request's. |
| `routes` | The allowlist: `METHOD /path` (GET, POST, PUT, PATCH, DELETE) or `WS /path` for a WebSocket. The path matches exactly; the query passes through. Anything else is a 404. |
| `set` | Request headers to set. Values may use `{variables}`; every variable a profile uses must be in a bind to it. |
| `remove` | Globs of request header names to drop. |
| `report` | Globs of response header names sent to the binder with each `observed`. |
| `concurrency` | `{ "key": "{variable}", "limit": n }`: a cap on requests in flight across every caller whose binding expands `key` alike. Over it: 429, `Retry-After: 1`. |
| `websocket` | `false` refuses the profile's WS routes with 426, so clients go on over HTTP. |
| `harness` | Per harness name, an object passed to the binder in `hello`; the proxy does not read it. It is where a profile says how each model client is configured for it. |
| `errors` | Texts replacing the proxy's own: `require`, `notReady`, `refused`, `refusedPrefix`, `unreachable`, `concurrency`. |

Per route:

| Field | Meaning |
|---|---|
| `to` | The upstream path, when it differs from the route's. |
| `require` | Header globs the request must match (a whole value, or one item of a comma-separated list, parameters ignored), else 403. A header the request's `Connection` lists does not count: it would not reach the upstream. |
| `set`, `default` | Headers for this route; `default` only where the request has none. |
| `name` | Its name in telemetry; by default the path's last element (`messages`, `count_tokens`), `_ws` added for a WS route. |
| `format` | `responses`: the route streams Responses events, which telemetry reads for the first output and the service tier. A WS route always does. |

Globs match case-insensitively; `*` is any run of characters.

### What the proxy does to a request

1. Removes `Authorization` and `X-Api-Key` (the placeholder), then the profile's `remove`.
2. Applies the profile's `set`, the route's `set`, then the route's `default`.
3. Sends it to the profile's upstream, at `to` or the route's path (never the caller's own encoding of it).

Every other header, the query and the body pass untouched: for an upstream that also takes a credential in another header, a cookie or the query, name the headers in `remove` and do not use the proxy for one that authenticates by query. The body is streamed, never read; the response is flushed as it arrives. Hop-by-hop headers and `X-Forwarded-For/-Host/-Proto` are dropped as by any reverse proxy.

A profile's requests only ever go to its own upstream, over its own connections. A session only reaches its binding's profile.

## Refusals

Written by the proxy itself, never the upstream. One body on every route: `{"type":"error","error":{"type","message"}}`. `reason` is what the `model.denied` event says.

| Status | `reason` | When |
|---|---|---|
| 401 | `credentials` | The request carries a credential other than the placeholder. |
| 401 | `unknown_caller` | The connection is not a caller's (`-identity`). |
| 429 | `caller_cap` | The caller is at `-max-inflight-per-caller`. `Retry-After: 1`. |
| 503 | none (`model.held`) | The caller's bind has not arrived within `-hold-timeout`, and the binder named the caller or has not yet said `synced`. `Retry-After: 1`. |
| 401 | `unbound` | No bind within `-hold-timeout` for a caller the binder did not name by `synced`. |
| 401 | `refused` | The binder bound the caller with `mode: "refuse"`; its reason is the text. |
| 404 | `route` | Not a route of the caller's profile. |
| 426 | `websocket` | An upgrade that is not a WS route, or `websocket: false`. |
| 426 | none (`model.request`) | The upstream refused the WebSocket handshake; the event and `observed` carry its status. |
| 403 | `require` | The route's `require` does not match. |
| 429 | `concurrency_cap` | The profile's `concurrency`. `Retry-After: 1`. |
| 503 | `upstream_busy` | Still queued for one of the upstream's connections (`-max-conns-per-host`) after `-hold-timeout`. `Retry-After: 1`. |
| 502 | none (`model.request`) | The upstream could not be reached (10 s to connect, 10 s for TLS); `observed` carries the error. |

On a request to upgrade, every refusal is a 426 with `Use HTTP: ` before the text, so a client goes on over HTTP. A refusal is reported, as a `model.denied` event and a journal line, at most once per caller and reason every 10 s; `suppressed` counts those since the last report.

Before a request is admitted: its headers may be 32 KB (431 past it), and a caller may have `-max-conns-per-caller` connections open (more are closed as accepted).

## Control protocol

JSON lines on the control socket; `hello.protocol` is 1. Unknown `t` values and fields are ignored. One example of every frame: `testdata/control/`; the types: `frames.go`.

| Direction | `t` | |
|---|---|---|
| proxy → binder | `hello` | First line: `{version, protocol, placeholder, profiles, bindings}`. Each profile is `{name, vars, harness}`, sorted by name; `vars` are the names a bind to it must give. `bindings` are the ones the proxy holds, without variables, so the binder re-sends their binds. |
| binder → proxy | `bind` | `{id?, caller, sessionKey, profile, vars, key}`: the caller's requests go to `profile` with `vars`. `key` is the binder's own name for the credential, never the secret. `{caller, sessionKey, mode: "refuse", reason}` makes the caller's requests 401. |
| proxy → binder | `bound` | `{id?, caller, sessionKey, key?}`: in effect for the caller's next request. |
| proxy → binder | `refused` | `{id?, caller, code, message}`: not applied. `code` is `bad_frame`, `unknown_profile`, `missing_var`, `bad_key` or `caller_in_use`. |
| binder → proxy | `release` | `{caller}`: delete the binding. |
| binder → proxy | `synced` | The binder has sent every bind it has. From then on a caller without one is unknown (401), not early (503). |
| proxy → binder | `observed` | What an upstream answered a binding: `{sessionKey, caller, key, profile, status, headers, body}` or `{…, error}`. Headers are the profile's `report`; the body is the start of an error's. What it means is the binder's to decide. Deduplicated: never one per request in the steady state. |
| binder → proxy | `request` | `{id, profile, vars, method, path, query?, headers?, body?}`: one request on a profile's route with these variables, which are not stored. For checking a credential before binding it. |
| proxy → binder | `response` | `{id, status, headers, body}` or `{id, error}`, on the connection that asked. `error` is `unknown_profile`, `unknown_route`, `missing_var`, `bad_request`, `busy` (16 are in flight), `timeout` or `unreachable`. |
| proxy → binder | `event` | A telemetry event to relay (below). |

Rules that hold:

- Every binder → proxy frame is idempotent: the same `bind` twice is answered `bound` twice and changes nothing.
- A caller serves one `sessionKey` from its bind to its release; a bind naming another is `refused` (`caller_in_use`).
- A bind applies to the caller's next request. Streams in flight finish on the credential they started with; a WebSocket is closed after the response in flight, or at once if the client starts another on it first.
- Variables live only in memory. `-bindings-file` keeps caller, session, mode, profile and key, so a restarted proxy holds its callers' requests until the binder re-binds instead of refusing them.
- Only `release` removes a binding. A closed control connection changes nothing; a binder that connects again gets every binding in its `hello`.

### Events

`{t: "event", name, at, outcome, duration_ms?, error_type?, session_key?, profile?, data}`. `data` values are scalars: never a variable, a body or upstream text. One example of each: `testdata/control/event-*.json`.

| `name` | When | `data` |
|---|---|---|
| `model.request` | A request that reached the upstream, once it ends. | `route`, `stream`, `swapped`, `status`, `key`, `conn_wait_ms`, `conn_reused`, `overhead_us`, `ttfb_ms`; on a `responses` route `first_output_ms`, `service_tier`; over a WebSocket `transport`, `responses`, `closed`, `prewarm` |
| `model.held` | A request that waited for its caller's bind. | `held_ms`, `released` (`bound`, `timeout`) |
| `model.denied` | A refusal, at most one per caller and reason every 10 s. | `reason` (the table above), `route`, `suppressed` |
| `model.binding` | A bind, a change of credential, a release, a refused bind. | `action` (`bind`, `swap`, `release`, `refused`), `caller`, `mode`, `key`; `code` when refused |
| `model.pool` | Every minute, per profile with traffic. | `open_conns`, `idle_conns`, `active_streams`, `idle_pool_miss`, `dials`; on the first profile also `bindings`, `dropped_messages` |
| `model.proxy_started` | At start. | `version`, `bindings` |

`outcome` is `completed`, `failed`, `cancelled` or `timed_out`; `error_type` is `provider_error`, `provider_rate_limited`, `timeout`, `socket`, `websocket` or `concurrency`.

## Who is calling

`-identity=cgroup` (default): the caller is `<id>` of the `sp-runner-<id>.service` unit the connection's peer process runs in, read once from its cgroup when the connection is accepted. The outermost such unit in the path wins, so a process cannot rename itself by creating cgroups below its own. This is routing, not isolation: sessions that share a uid can move between each other's units, so do not put mutually untrusted tenants on one computer.

`-identity=single`: every connection is the caller `single`. For a computer that runs one session outside systemd.

## Flags

| Flag | Default | |
|---|---|---|
| `-api-socket` | `/run/oc-modelproxy/api.sock` | the model clients' socket, when not socket-activated |
| `-control-socket` | `/run/oc-modelproxy/control.sock` | the binder's socket, when not socket-activated |
| `-profiles` | `/etc/oc-modelproxy/profiles.d` | directory of profile files |
| `-check` | | load `-profiles`, print the first error, exit 0 or 1 |
| `-placeholder` | `ssh-placeholder` | the only credential a caller may send |
| `-identity` | `cgroup` | `cgroup` or `single` |
| `-bindings-file` | `/run/oc-modelproxy/profile-bindings.json` | persisted bindings, without variables (empty: off) |
| `-hold-timeout` | `10s` | how long a request waits for its caller's bind, and then for a free upstream connection |
| `-drain-timeout` | `630s` | on SIGTERM or after a handoff, how long streams in flight may finish |
| `-max-inflight-per-caller` | `32` | concurrent requests per caller, held ones included (0: no limit) |
| `-max-conns-per-caller` | `128` | connections a caller may have open on the API socket (0: no limit) |
| `-ws-idle-timeout` | `5m` | close a WebSocket idle this long between responses (0: never) |
| `-max-idle-conns-per-host`, `-max-conns-per-host`, `-idle-conn-timeout` | `96`, `256`, `50s` | upstream connection pool, per profile |
| `-debug`, `-version` | | |

Profiles are read at start; to change them, or the binary, send `SIGUSR2`. The proxy starts its replacement with the same command line and the listening sockets, and when that is ready stops accepting and exits once its streams end. No connection is refused in between: the replacement holds each caller's requests until the binder, whose connection the old process closes, has re-bound. A replacement that does not start changes nothing; the old process logs `handoff failed; still serving`. Under systemd the unit needs `Type=notify` and `NotifyAccess=all`, since the replacement reports itself as the new main pid. `SIGTERM` stops the proxy: bindings survive, streams in flight finish first, and new connections wait for the next start only if systemd owns the sockets. The garbage collector runs at `GOGC=400` unless the environment sets `GOGC`.

## Build and test

```sh
cd computer/modelproxy
gofmt -l . && go vet ./...
go test -race -count=1 ./...
MODELPROXY_OVERHEAD_GATE=1 go test -run '^$' -bench ProxyOverhead -benchtime 5000x ./...
CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$(git rev-parse HEAD)" -o oc-modelproxy .
```

The tests run on the shipped profiles and a neutral fixture profile, against fake upstreams; none contacts a real API. The benchmark fails when the proxy's median overhead per request passes 0.1 ms or its allocations per request pass 250.

## Try it

```sh
mkdir -p /tmp/mp && ./oc-modelproxy -identity=single -profiles ./profiles \
  -api-socket /tmp/mp/api.sock -control-socket /tmp/mp/control.sock -bindings-file ""

# the binder's side: bind the single caller to a key
printf '%s\n' '{"t":"bind","caller":"single","sessionKey":"s1","profile":"anthropic-key","vars":{"token":"'"$ANTHROPIC_API_KEY"'"},"key":"mine"}' \
  | nc -U /tmp/mp/control.sock

# a client's side: the placeholder, not the key
curl --unix-socket /tmp/mp/api.sock http://localhost/v1/messages \
  -H 'x-api-key: ssh-placeholder' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}'
```

## Files

One concept per file, each with a header comment that says what it is and what must stay true: `profile.go` and `template.go` (profiles), `bindings.go` and `lease.go` (the table, and a request's hold on it), `proxy.go` (a request's stages), `refuse.go` (refusals), `outbound.go` (the rewrite), `observed.go` and `request.go` (what the binder hears and asks), `control.go` and `frames.go` (the control protocol), `websocket.go`, `wsframe.go`, `wsmessages.go` (WebSocket tunnels), `responses.go` and `telemetry.go` (events), `upstream.go` (connections), `identity.go` and `connlimit.go` (who is calling), `inflight.go`, `persist.go`, `activation.go`.
