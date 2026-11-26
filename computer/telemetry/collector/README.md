# Telemetry collector

A standalone, stateless Cloudflare Worker between Calvin's hosts and Tinybird
(work 054, "Independence from the product").
It verifies a host's signed credential offline, rate-limits per host, stamps
`org_id`/`host_id` from the credential, re-validates every record with the
shared catalog in `src/telemetry/`, replaces repository names with a keyed
digest, and forwards to the Tinybird Events API. No storage, no Durable
Objects, no service bindings, no calls to the backend: a product outage cannot
stop collection. `npm test` enforces the import boundary (`scripts/imports.mjs`).

## Host contract (S3 builds against this)

`POST /v1/events`, `Authorization: Bearer <credential>`, JSON body:

```json
{ "host_boot_id": "<uuid per host process>", "batch_seq": 0, "events": [...], "turns": [...] }
```

- `events` are `TelemetryEvent`s with `data` as an object; `turns` are `TurnRow`s (`src/telemetry/envelope.ts`). At most 1 000 records and 1 MiB per batch.
- `batch_seq` starts at 0 per `host_boot_id` and increases by one per batch; the collector records each accepted batch as a `telemetry.batch` event, so a missing number is a lost batch.
- `repo` in `data` is the workspace-local repository name; it never reaches Tinybird (HMAC-SHA256 under `REPO_DIGEST_KEY`, first 12 hex). Recompute a digest to map it back.
- Records that fail validation are dropped and counted (`telemetry.dropped{reason: invalid}`, written by the collector); the rest of the batch goes through.

| status | meaning | host does |
|---|---|---|
| 200 | forwarded; body `{events, turns, invalid}` | delete the segment |
| 202 | telemetry off (no `TINYBIRD_APPEND_TOKEN`): accepted and discarded | delete the segment |
| 400, 413 | malformed or oversized batch | drop it, count `rejected` |
| 401 | credential missing, malformed, unsigned, expired or denylisted | drop it, count `rejected` |
| 429 | over the per-host rate (`Retry-After`) | keep it, back off, retry |
| 503 | Tinybird failed or the collector is misconfigured | keep it, back off, retry |

## Credentials (S5 issues them)

`v1.<base64url(JSON {org_id, host_id, exp})>.<base64url(Ed25519 signature)>`,
signed over the ASCII of `v1.<payload>`; `exp` in seconds since epoch.
`org_id` and `host_id` match `[A-Za-z0-9_.:-]{1,128}`. `src/credential.ts`
`sign()` is the reference issuer and `generateKeys()` makes a pair (the public
half, raw and base64url, is `CREDENTIAL_PUBLIC_KEY`).

## Configuration

| name | kind | what |
|---|---|---|
| `TINYBIRD_APPEND_TOKEN` | secret | `calvin_append_collector`. Unset: telemetry off, everything answered 202 and discarded |
| `TINYBIRD_API_URL` | var | regional API base, e.g. `https://api.us-west-2.aws.tinybird.co` |
| `REPO_DIGEST_KEY` | secret | HMAC key for repository digests |
| `CREDENTIAL_PUBLIC_KEY` | secret | the backend's Ed25519 public key; comma-separate two during rotation |
| `CREDENTIAL_DENYLIST` | var | revoked `host_id`s and `org:<org_id>` entries, comma-separated |
| `VERSION` | var | set by CI at deploy (`--var VERSION:<sha>`) |
| `RATE_LIMITER` | binding | 120 requests / 60 s per `host_id` |

With the token set but any of `TINYBIRD_API_URL`, `REPO_DIGEST_KEY` or
`CREDENTIAL_PUBLIC_KEY` missing, the collector answers 503 so hosts keep
spooling rather than lose data.

## Deploy

`npx wrangler deploy` deploys `wrangler.jsonc` as it is: a workers.dev Worker
named `calvin-telemetry-dev`. Give a production deployment its own name, route
and rate-limit namespace in a config of your own. Secrets are set once per
Worker: `npx wrangler secret put TINYBIRD_APPEND_TOKEN`.

```bash
npm ci && npm test          # tsc, unit tests, import boundary
npx wrangler dev            # local; pass --var NAME:value for config
```
