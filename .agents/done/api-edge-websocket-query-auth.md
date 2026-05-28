# API edge WebSocket query auth

Status: **completed**. PR #339 merged.
Implementation commit: `b6e9070`.

## Summary

SDK WebSocket attach worked when pointed directly at a cell endpoint, but
failed through `app.opencomputer.dev` with:

```text
401 {"error":"missing or invalid API key"}
```

The failure was specific to WebSocket attach for sandbox exec sessions.
Buffered exec and exec-session creation through the app endpoint still worked.

## Findings

The TypeScript SDK builds exec attach URLs with `?api_key=` because browser
WebSocket APIs cannot set custom headers:

```text
wss://app.opencomputer.dev/api/sandboxes/{sandboxID}/exec/{sessionID}?api_key=...
```

The regional Go control plane already accepts query-string API keys for
WebSocket-style routes through `auth.PGAPIKeyMiddleware`, which is why the same
attach URL pattern succeeded when pointed directly at the cell endpoint.

The global `api-edge` Worker did not match that contract. Its
`authenticate()` helper only read `X-API-Key`, so the edge rejected SDK
WebSocket attaches before it could mint the short-lived bearer token used for
the cell hop.

The app endpoint could still create exec sessions because those requests are
normal HTTP requests from the SDK, which use the `X-API-Key` header.

## Root Cause

The edge-first SDK proxy path changed the auth boundary for sandbox runtime
calls:

```text
SDK -> app.opencomputer.dev/api-edge -> cell control plane -> worker
```

For normal HTTP, the SDK sends `X-API-Key`, and `api-edge` authenticates it.
For WebSocket attach, the SDK sends `?api_key=`, matching the documented
WebSocket API and the Go cell middleware. `api-edge` had not implemented that
WebSocket-specific query-auth compatibility.

## Proposed Solution

Make `api-edge` accept `?api_key=` only for WebSocket Upgrade requests, then
strip that query parameter before forwarding to the cell. The cell should see
only the edge-minted bearer token, not the customer's original API key.

This keeps the compatibility surface narrow:

- `X-API-Key` remains the normal HTTP auth path.
- `?api_key=` is accepted only for WebSocket Upgrade requests.
- The customer API key is not forwarded to the cell after edge auth succeeds.
- Non-WebSocket HTTP requests with only `?api_key=` remain rejected.

## Implemented Shape

`cloudflare-workers/api-edge/src/index.ts` now has:

- `isWebSocketUpgrade(req)` for one consistent upgrade check.
- `apiKeyFromRequest(req)` that reads `X-API-Key`, then falls back to
  `?api_key=` only for upgrades.
- `stripEdgeAuthQueryParam(target)` to remove `api_key` from the forwarded
  cell URL.

The WebSocket proxy branch now clones the inbound request against the stripped
target URL, sets `Authorization: Bearer <edge-token>`, deletes `X-API-Key`, and
lets Cloudflare forward the WebSocket upgrade transparently.

## Regression Tests

Added `cloudflare-workers/api-edge/src/index.test.ts` with focused coverage:

1. WebSocket sandbox exec attach using `?api_key=` authenticates at the edge,
   proxies to the owning cell, preserves unrelated query params, strips
   `api_key`, and injects bearer auth.
2. Non-WebSocket HTTP with only `?api_key=` still returns `401` and does not
   proxy.

## Verification

Local checks:

```text
cd cloudflare-workers/api-edge
npm test -- --run
npx tsc --noEmit
```

Both passed after installing package dependencies from the lockfile.

`tsc` also surfaced an existing Worker WebSocket typing issue in
`src/dashboard.ts` around `ArrayBufferView.buffer` possibly being a
`SharedArrayBuffer`. The fix copies the view into a fresh `ArrayBuffer` before
sending it over the WebSocket.

## Rollout

Deploy only the `api-edge` Worker. The Go cell control planes and workers do
not need changes for this specific bug because their auth and attach paths
already accept the SDK's WebSocket URL shape.

Post-deploy smoke test:

1. Create a fresh sandbox through `https://app.opencomputer.dev`.
2. Start an exec session through the SDK.
3. Attach through the SDK without overriding `sandbox.exec.apiUrl`.
4. Expect WebSocket open to succeed and `exec.shell().run("echo ok")` or
   equivalent streaming exec to return exit code `0`.

Also verify the negative case:

```text
GET /api/sandboxes/{id}/exec/{sessionID}?api_key=...
```

without `Upgrade: websocket` should still return `401`.

## Follow-ups

The edge Worker and Go control plane should keep WebSocket auth behavior aligned
as a public API contract. Any future WebSocket route added to the SDK should get
an edge-level test for query-param auth, plus a negative HTTP test so query
auth does not quietly expand across the whole API.

## Design Concern: API Keys In WebSocket URLs

The hotfix intentionally preserves the current public contract, but the contract
itself is not ideal: long-lived API keys in URL query parameters are easier to
leak than credentials in headers.

Common leak paths:

- HTTP access logs at proxies, CDNs, tunnels, or app servers.
- Browser and SDK error messages that include the failed WebSocket URL.
- Copy-pasted repro commands, screenshots, support tickets, and telemetry.
- Referrer-like propagation in unusual browser/tooling contexts.

The reason this exists is pragmatic, not because it is the best security shape:
browser WebSocket clients cannot set arbitrary `X-API-Key` or `Authorization`
headers. Node/Bun clients can often send headers depending on the WebSocket
library, but the public SDK needs a browser-compatible path.

Short-term stance:

- Keep accepting `?api_key=` for WebSocket Upgrade requests for compatibility.
- Keep it narrowly scoped to Upgrade requests only.
- Strip it at the edge before proxying to the cell.
- Redact credentials from SDK WebSocket error messages.

Longer-term proposal:

1. SDK makes a normal HTTPS request with `X-API-Key` to create or authorize an
   attach operation.
2. API returns a short-lived, scoped attach token or attach URL.
3. SDK opens the WebSocket with `?token=<short-lived-token>`, not the long-lived
   API key.

The token should be scoped at least to:

- org ID
- sandbox ID
- exec/PTY/agent session ID
- operation, for example `exec_attach`

Recommended properties:

- 30-120 second TTL.
- Signed by the control plane or edge.
- Optionally one-time-use if the storage path is cheap enough.
- No broad API capability if replayed.

This keeps browser compatibility while reducing the blast radius of URL leaks.
It also matches the existing direct-worker model, where SDKs already prefer a
sandbox-scoped `?token=` when available.
