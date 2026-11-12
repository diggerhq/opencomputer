# oc-modelproxy

A small reverse proxy between the model clients in a computer's sessions (Claude Code, Codex, anything that takes a base URL) and the model APIs. A session's client is configured with a placeholder instead of a credential; the proxy knows which session a request comes from, puts the real credential on it and forwards it. The credential is never in the session's environment, files or logs.

Everything the proxy knows about an upstream is configuration: a **profile** names the upstream, the routes a session may call, the headers that carry the credential, and what to report back. The proxy has no built-in providers.

Go, standard library only. One static binary.

```
session's client ──HTTP──▶ api socket ─┐
                                       ├─ oc-modelproxy ──HTTPS──▶ the profile's upstream
host agent ──JSON lines──▶ control socket ─┘
```

- **API socket**: model clients. An `Authorization` or `X-Api-Key` other than the placeholder is refused.
- **Control socket**: the host. It binds a session's unit to a profile and the values of its variables, and hears what upstreams answer.

## Profiles

JSON files in `-profiles` (default `/etc/oc-modelproxy/profiles.d/*.json`), each an object of name → profile, read once at start. A file with an unknown field, a profile that fails a check, or a name defined twice stops the proxy at start.

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
    "client": { "claude": "ANTHROPIC_AUTH_TOKEN" }
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
| `report` | Globs of response header names sent to the host with each `observed`. |
| `concurrency` | `{ "key": "{variable}", "limit": n }`: a cap on requests in flight across every session whose binding expands `key` alike. Over it: 429, `Retry-After: 1`. |
| `websocket` | `false` refuses the profile's WS routes with 426, so clients go on over HTTP. |
| `client`, `runner` | Passed to the host in `hello`; the proxy does not read them. By convention `client` says how each model client is configured for the profile. |
| `errors` | Texts replacing the proxy's own: `require`, `notReady`, `refused`, `refusedPrefix`, `unreachable`, `concurrency`. |

Per route:

| Field | Meaning |
|---|---|
| `to` | The upstream path, when it differs from the route's. |
| `require` | Header globs the request must match (a whole value, or one item of a comma-separated list, parameters ignored), else 403. |
| `set`, `default` | Headers for this route; `default` only where the request has none. |
| `name` | Its name in telemetry; by default the path's last element (`messages`, `count_tokens`), `_ws` added for a WS route. |
| `format` | `messages` or `responses`: which stream format telemetry reads. By default `responses` for a path ending in `/responses`. |

Globs match case-insensitively; `*` is any run of characters.

### What the proxy does to a request

1. Removes `Authorization` and `X-Api-Key` (the placeholder), then the profile's `remove`.
2. Applies the profile's `set`, the route's `set`, then the route's `default`.
3. Sends it to the profile's upstream, at `to` or the route's path (never the caller's own encoding of it).

Every other header, the query and the body pass untouched: for an upstream that also takes a credential in another header, a cookie or the query, name the headers in `remove` and do not use the proxy for one that authenticates by query. The body is streamed, never read; the response is flushed as it arrives. Hop-by-hop headers and `X-Forwarded-For/-Host/-Proto` are dropped as by any reverse proxy.

A profile's requests only ever go to its own upstream, over its own connections. A session only reaches its binding's profile.

## Refusals

Written by the proxy itself, as Anthropic-shaped JSON errors (`{"type":"error","error":{"type","message"}}`):

| Status | When |
|---|---|
| 401 | The request carries a credential other than the placeholder; the caller is not a known session; the host bound the session with `mode: "refuse"` (its reason is the text). |
| 403 | The route's `require` does not match. |
| 404 | Not a route of the session's profile. |
| 426 | A WebSocket upgrade the proxy will not serve (not a WS route, `websocket: false`, the upstream refused the handshake). On an upgrade every refusal is a 426, with `Use HTTP: ` before the text. |
| 429 | The session's in-flight cap (`-max-inflight-per-unit`) or the profile's `concurrency`. `Retry-After: 1`. |
| 502 | The upstream could not be reached. |
| 503 | The session's credential has not arrived yet (held up to `-hold-timeout` first), or a change of profile is waiting for the session's streams to end. `Retry-After: 1`. |

## Control protocol

JSON lines on the control socket, one host at a time. Unknown `t` values and fields are ignored. Golden examples of every message: `testdata/control/`.

| Direction | `t` | |
|---|---|---|
| proxy → host | `hello` | First line: the version, the profiles loaded (with their `client` and `runner`), and the bindings the proxy knows, so the host re-sends their binds. |
| host → proxy | `bind` | `{unit, sessionKey, profile, vars, key}`: the unit's requests go to `profile` with `vars`. `key` is the host's own name for the credential (a fingerprint, never the secret). `{unit, sessionKey, mode: "refuse", reason}` makes the unit's requests 401. |
| proxy → host | `bound` / `refused` | The bind took effect, or why it did not. |
| host → proxy | `release` | `{unit}`: forget the binding. |
| host → proxy | `synced` | The host has re-sent every bind after a `hello`. |
| proxy → host | `observed` | What an upstream answered a binding: `{sessionKey, unit, key, profile, status, headers, body}` or `{…, error}`. Headers are the profile's `report`; the body is the start of an error's. What it means (a spent quota, a revoked credential) is the host's to decide. Only for a binding with a `key`. Deduplicated: never one per request in the steady state. |
| host → proxy | `request` | `{id, profile, vars, method, path, query, headers, body}`: make one request on a profile's route with these variables, which are not stored. For checking a credential before binding it. |
| proxy → host | `response` | `{id, status, headers, body}` or `{id, error}`, on the connection that asked. At most 16 in flight; past that the error is `busy`. |
| proxy → host | `event` | A telemetry event for the host to relay: `model.request`, `model.held`, `model.denied`, `model.binding`, `model.pool`, `model.proxy_started`. Never a variable, a body or upstream text. |

Rules that hold:

- A unit serves one `sessionKey` for its life.
- A new credential for a bound unit takes effect only between its streams, never mid-stream.
- Variables live only in memory. `-bindings-file` keeps unit, session, profile and key, so a restarted proxy holds its sessions' requests until the host re-binds instead of refusing them.
- A closed control connection changes nothing: bindings stay and serving continues.

A host from before profiles has its `bind` (`mode`, `provider`, `token`, `accountId`, `fingerprint`) understood and answered in its own terms: `provider` is read as the profile's name, and `-default-profile` names the profile of a bind without one. The same holds for a bindings file written before profiles. Its `probe` is not answered and it is not sent `health`: `request` and `observed` replace them.

## Who is calling

`-identity=cgroup` (default): the caller's systemd unit, from the connection's peer pid and its cgroup; sessions run as `sp-runner-<id>.service`. This is routing, not isolation between sessions that share a uid.

`-identity=single`: every caller is `sp-runner-single.service`. For a computer that runs one session outside systemd.

## Flags

| Flag | Default | |
|---|---|---|
| `-api-socket` | `/run/oc-modelproxy/api.sock` | the model clients' socket, when not socket-activated |
| `-control-socket` | `/run/oc-modelproxy/control.sock` | the host's socket, when not socket-activated |
| `-profiles` | `/etc/oc-modelproxy/profiles.d` | directory of profile files |
| `-default-profile` | | profile of a bind that names none |
| `-placeholder` | `ssh-placeholder` | the only credential a caller may send |
| `-identity` | `cgroup` | `cgroup` or `single` |
| `-bindings-file` | `/run/oc-modelproxy/bindings.json` | persisted bindings, without variables (empty: off) |
| `-hold-timeout` | `10s` | how long a request waits for its unit's credential |
| `-drain-timeout` | `630s` | on SIGTERM, how long streams in flight may finish |
| `-max-inflight-per-unit` | `32` | concurrent requests per unit (0: no limit) |
| `-ws-idle-timeout` | `5m` | close a WebSocket idle this long between responses (0: never) |
| `-warm-conns` | `4` | pre-dialed TLS connections kept per upstream (0: off) |
| `-max-idle-conns-per-host`, `-max-conns-per-host`, `-idle-conn-timeout` | `96`, `256`, `50s` | upstream connection pool |
| `-proc`, `-debug`, `-gc-percent`, `-version` | | |

Profiles are read at start; to change them, restart the proxy. Bindings survive the restart and streams in flight finish first.

## Build and test

```sh
cd computer/modelproxy
gofmt -l . && go vet ./...
go test -race -count=1 ./...
MODELPROXY_OVERHEAD_P99_MS=2 go test -run '^$' -bench ProxyOverhead -benchtime 5000x ./...
CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$(git rev-parse HEAD)" -o oc-modelproxy .
```

The tests run on the shipped profiles and a neutral fixture profile, against fake upstreams; none contacts a real API.

## Try it

```sh
mkdir -p /tmp/mp && ./oc-modelproxy -identity=single -profiles ./profiles \
  -api-socket /tmp/mp/api.sock -control-socket /tmp/mp/control.sock -bindings-file ""

# the host's side: bind the single unit to a key
printf '%s\n' '{"t":"bind","unit":"sp-runner-single.service","sessionKey":"s1","profile":"anthropic-key","vars":{"token":"'"$ANTHROPIC_API_KEY"'"},"key":"mine"}' \
  | nc -U /tmp/mp/control.sock

# a client's side: the placeholder, not the key
curl --unix-socket /tmp/mp/api.sock http://localhost/v1/messages \
  -H 'x-api-key: ssh-placeholder' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}'
```

## Files

One concept per file, each with a header comment that says what it is and what must stay true: `profile.go` (profiles), `bindings.go` (the table), `proxy.go` (a request's path), `outbound.go` (the rewrite), `observed.go` and `request.go` (what the host hears and asks), `control.go` and `messages.go` (the control protocol), `websocket.go`, `wsframe.go`, `wsmessages.go` (WebSocket tunnels), `responses.go` and `telemetry.go` (events), `upstream.go` (connections), `identity.go`, `inflight.go`, `persist.go`, `activation.go`.
