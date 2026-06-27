# Secret material → managed Infisical Cloud (typed SecretBackend)

Status: **design + implementation plan**, in active development. Decision:
risk-tiered — move **high-sensitivity** customer credentials (model keys, GitHub
App keys, broker secrets) to managed **Infisical Cloud** (DB holds only a
reference); keep **low-sensitivity** `webhook-signing` secrets in the encrypted
DB; keep single-use repo tokens ephemeral. The in-progress code uses a placeholder
store ("B1") — AES-256-GCM in Postgres — for *all* secret classes; this doc
defines the proper design and the path to it. Technical / security / reliability
scope; the dashboard Credentials page is the last step and is out of scope here
(an API-readiness cross-check is included).

(Note: `v3` in existing paths/routes/env vars — `src/v3/…`, `/v3/…`,
`V3_SECRET_STORE_KEY` — is historical. v1/v2 were prototypes; this is the current
and only real surface, not a versioning scheme. Real identifiers are kept as-is
below so the doc points at actual code; new names introduced here are unprefixed.)

The core idea: treat the external-secret lifecycle as a **real durable
subsystem** — a typed backend, a local metadata ledger, typed errors,
per-purpose routing, and explicit delete/rotate semantics — not a swapped-out
crypto helper.

## The seam is broader than "model credentials"

`sessions-api/src/v3/core/secrets.ts` (4 functions, keyed by `(owner,
secret_ref)`) is the single at-rest path for **every** secret class:

| Purpose (slug) | Write site | Read (hot path) | Frequency |
|---|---|---|---|
| `model-credential` (Anthropic/OpenAI key) | `core/credentials.ts:56,137` | `runtime/credential.ts:102` (seal) | **per turn** (`turn.ts:215`) |
| `github-app-key` (BYO App private key PEM) | `core/github-apps.ts:198,220,301` | `runtime/repo-op.ts:122` | per repo-op |
| `github-broker-secret` | `core/github-apps.ts:226,315` | broker auth | per broker call |
| `webhook-signing` (destination secret) | `delivery/destinations.ts:71,162` | `internal/deliveries.ts:127` | **per delivery** (high vol) |
| `repo-inline-token` (`risky_short_lived_token`) | `sources/repo.ts:38` | `sources/repo.ts:193` | per checkout (then deleted) |

## Per-purpose routing (don't send everything to Infisical)

The classes differ in sensitivity, durability, and hot-path volume, so the typed
backend routes per purpose rather than all-to-Infisical (which would make an
Infisical hiccup break deliveries + repo ops + GitHub, not just sealing):

| Purpose | Sensitivity | Lifetime | Proposed home |
|---|---|---|---|
| `model-credential` | high (customer cloud account) | durable | **Infisical** |
| `github-app-key` | high (repo write) | durable | **Infisical** |
| `github-broker-secret` | high | durable | **Infisical** |
| `webhook-signing` | **low** (HMAC; leak ⇒ forge *our* webhook signatures, no customer-account access) | durable | **DB (encrypted PG), separate key** — keeps the per-delivery hot path + delivery availability off Infisical; **must still fail closed** |
| `repo-inline-token` | medium, **single-use** (already create→use→`deleteSecret`, `sources/repo.ts:144`) | ephemeral | keep **ephemeral**; durable external vaulting adds little — resolve-once-then-purge |

## Where secret material lives at rest (full inventory)

Infisical fixes the *primary* copy but is not the only durable one:

1. **(primary)** `agent_auth.credential_secrets` (+ the other classes' refs) in
   sessions-api Postgres, AES-256-GCM under `V3_SECRET_STORE_KEY` (or an HKDF
   fallback off `V3_INTERNAL_AUTH_SECRET` — a double-duty the proper design
   drops). The **high-sensitivity classes move to Infisical**; **`webhook-signing`
   stays here on purpose** (low sensitivity, hot per-delivery path) but under a
   **separate key** so the high-value key can be crypto-shredded (below).
2. **(derived)** `secret_store_entries` (Cloudflare D1) — the per-session sealed
   copy, AES-256-GCM under a **single global** `SECRET_ENCRYPTION_KEY`
   (`api-edge/src/secret_stores.ts:192`).
3. **(derived, PLAINTEXT on disk)** `snapshot-meta.json` — at hibernate/checkpoint,
   `secretsProxy.GetSessionTokens()` (sealed-token→**plaintext** map) is written
   as JSON, mode 0644, for wake/restore (`internal/qemu/snapshot.go:164`,
   `internal/qemu/manager.go:3245`).

## The local secret-ref ledger (the spine of the subsystem)

Add **`agent_auth.secret_refs`** — a durable local record of every external
secret, **values never stored**:

```
secret_ref (PK) · purpose · owner_id · external_path (Infisical path/name)
· status (reserved | active | superseded | pending_delete | deleted)
· created_at · updated_at · deletion_attempts · last_error
```

It is the source of truth for **cleanup, migration, observability, and prod
assertions**, and it closes the crash-window gap: if the process dies after the
Infisical write but before the pointer update, the `reserved` row is the durable
evidence the sweep needs. (Consumer tables keep only `secret_ref` + non-secret
display fields like `last4`.)

## Atomicity — reserve/finalize, never an HTTP call inside a PG txn

The placeholder writes the secret *inside* a PG transaction
(`agents.ts:137`→`credentials.ts:56`). Infisical writes are HTTP and **must not**
be held inside a DB lock. Sequence instead:

1. **txn A (fast):** INSERT `secret_refs` row `status=reserved` (mint `secret_ref`).
2. **HTTP (no lock held):** write the value to Infisical at `external_path`.
3. **txn B (narrow pointer-swap):** set the consumer pointer (e.g.
   `credential_metadata.secret_ref`) + `secret_refs.status=active` (+ `last4`).

**Rotate = versioned write:** new `secret_ref` via the same 1→2→3; in txn B mark
the old row `superseded`. **Delete:** txn sets the pointer null + row
`pending_delete`; a worker performs the external delete with retries
(`deletion_attempts`/`last_error`), then `deleted`. A **reconciliation sweep**
(authoritative, not just the outbox) lists Infisical, diffs against the ledger,
and removes orphans / drives `reserved`-too-long and `pending_delete` rows to
resolution.

## Typed errors — missing vs unavailable (never silently downgrade)

The backend returns **typed results**, not `string | null`. Critically,
distinguish **"no secret configured"** from **"backend unavailable / resolve
failed."** Today webhook delivery does `dest_secret_ref ? resolve() : null` and
would **send unsigned** if a configured secret fails to resolve
(`internal/deliveries.ts:126`). Regardless of backend (webhook secrets stay in
PG), a configured-but-unavailable secret must become a **retryable (or permanent)
failure**, never an unsigned send. Every consumer maps the typed error to its
correct behavior (fail the delivery, fail-closed the seal, fail the checkout).

## Rotation & the per-turn seal (correcting an earlier claim)

**There is no rotation fan-out for sessions-api credentials.** `rotateCredentialKey`
(`core/credentials.ts:137`) only updates the PG secret + `last4`; it does **not**
touch the per-session OC SecretStore. The thing that makes a rotated key take
effect is the **per-turn re-seal** in `runtime/credential.ts:102`, which
re-resolves and re-`setSecret`s every turn. (The OC `secret_refresh.go` fan-out
is for OC SecretStore *PUTs* via the edge — unrelated to credential rotation.)

So if we make seal **conditional** (to stop the per-turn SoT read that would blow
Cloud limits), rotation propagation must be handled explicitly. Two options:
- **Default — next-seal/wake semantics:** a rotation (new `secret_ref`) is picked
  up on the session's next turn/wake. Simple; bounded staleness = one turn.
- **Immediate — explicit push:** on rotate, for each active session using that
  credential, `setSecret` the new value (which triggers the edge live-refresh to
  the running box). Costs a fan-out but propagates mid-session.

**Conditional-seal state must be durable, not an in-process cache.** Persist the
session's sealed `secret_ref` (on `agent_core.sessions` or a
`session_secret_bindings` table) and seal only when: the credential's current
`secret_ref` differs (rotation), **or** the D1 store entry is missing, **or** the
ledger row isn't `active` (revoked). I.e. "ref unchanged **and** still present in
the SoT **and** the D1 entry exists" — otherwise a deleted/missing entry could be
wrongly skipped, and a revoked key could keep working on wake.

## Hot path & rate limits

The worst hot path — `webhook-signing`, read **per delivery** — **stays in PG**,
so it is off Infisical entirely (and an Infisical outage cannot break
deliveries). What's left on Infisical: `model-credential` seal (per turn) and
`github-*` (infrequent). Conditional seal (above) collapses model-cred reads to
~once/session + once/rotation, so Infisical **Cloud** per-minute limits become a
minor concern rather than a launch blocker. Size the remaining volume against
Cloud limits; **Enterprise** (custom limits) is likely **not** needed for rate
alone, though it may still be wanted for SLA/audit streaming.

## Derived runtime copies (and don't break generic OC stores)

- **Copy 2 (D1):** on rotate/delete, the per-session entry must be refreshed/
  purged; wake must re-resolve (see conditional-seal) and **fail closed** on
  delete.
- **Copy 3 (snapshot-meta plaintext):** stop persisting plaintext — persist a
  **reference** and re-resolve on wake (preferred), or encrypt the blob. **But**
  `snapshot.go:164` persists proxy state **generically** for *all* OC SecretStore
  users, not just the agent-session stores. So either tag the session stores
  distinctly and only change their path, or define a generic "re-resolve on wake"
  contract that user-created OC SecretStores can satisfy too. Don't silently
  change behavior for non-session consumers.

## Stronger posture (worth considering): read in the proxy

Today sessions-api (a large attack surface) resolves plaintext and pushes it via
`setSecret`. The egress proxy already holds plaintext in its session map — it's
the narrow component. If the **proxy** fetched from Infisical at swap time using a
scoped token and sessions-api only passed **references**, the big app would never
touch plaintext. Bigger change (proxy is in the Go core), but it's the move that
most shrinks the in-memory custody window. Flagged as a direction, not Phase 1.

## Residual threats & detection

After Infisical, the realistic compromise is **"read everything"** — a leaked
machine identity or compromised sessions-api bulk-reads customer secrets.
Least-privilege + rotation limit scope but don't *detect* it. Add: anomaly
detection on bulk/cross-owner reads, per-time rate-limiting of the machine
identity, and alerting when read volume diverges from session volume.

## Auth, config & operational (fail-closed)

- Config: `INFISICAL_CLIENT_ID/SECRET`, `INFISICAL_PROJECT_ID`,
  **`INFISICAL_ENVIRONMENT`** (the APIs are project + environment + path — make
  the env slug explicit), `INFISICAL_SITE_URL`. **Fail startup if prod config is
  incomplete.**
- **Separate dev/prod identities + projects.** Client secrets default to
  infinite TTL/uses → set finite TTL + use cap, rotate. Access tokens ~7200s →
  implement renewal.
- **Fail closed in prod:** no silent fallback to the PG placeholder if Infisical
  is unreachable (the `SECRET_BACKEND=pg` flag is **dev-only**).
- The **machine identity** is the most sensitive credential in the system (reads
  every customer secret): least-privilege scope, rotate, alert.
- **Bootstrap secret:** the Infisical client secret is the one secret that can't
  live in Infisical → Fly secret; rotation requires a deploy.
- **Retries/idempotency on the edge calls too:** `SecretStore.create/list/update/
  setSecret` run via the edge on a short-lived provision token and can fail
  independently; give them retry/circuit-breaker, and fix the TOCTOU in
  create-or-reuse under concurrent turns.

## Path scheme (sanitized, unambiguous)

Infisical folder names allow letters/numbers/dashes; owner ids carry colons/
prefixes (`keyhash:`, `oc-org:`), and purpose slugs use dashes (not underscores).
Split path vs name:

```
secretPath = /owners/<sha256(owner)>/secrets/<purpose-slug>
secretName = <safe(secret_ref)>
```

Real owner id stays only in PG + telemetry, never in the Infisical path.

## Trust boundary, exit & residency

- Managed Cloud = **Infisical operators can technically see plaintext** (not
  client-side encrypted). Acceptable, but state it — it's part of "defensible."
- **Exit:** the `SecretBackend` abstraction + the ledger make provider-swap real,
  not theoretical; keep it genuinely swappable.
- **Residency:** single-region Cloud may not satisfy EU data-residency — the one
  thing that could re-open self-host for a customer subset.
- **DR:** Infisical is now the only copy of these keys (by design). Its data-loss
  ⇒ customers re-enter keys; acceptable for re-enterable secrets, but say so.

## Build-out plan

- **Phase 0 — Infisical setup.** Per-env projects + separate machine identities +
  least-privilege scope + finite client-secret TTL. Client module + config
  (incl. `INFISICAL_ENVIRONMENT`) in sessions-api via Fly secrets; dev first.
- **Phase 1 — ledger + typed backend.** Create `agent_auth.secret_refs`;
  implement the typed `SecretBackend` (purpose-routed, typed errors); the
  reserve/finalize + pointer-swap flow; reconciliation sweep + telemetry.
- **Phase 2 — migrate consumers, each with explicit delete/rotate behavior** (not
  just "migrate all five"):
  - `model-credential`: `create`/`rotate` via versioned write; **delete is
    soft-only today** (`credentials.ts:95`) → must also purge the external secret.
  - `webhook-signing`: **stays in PG** (under its own key); typed-error
    fail-closed in delivery; **destination delete removes only the row today**
    (`destinations.ts:193`) → also delete the secret.
  - `github-app-key` / `github-broker-secret`: rotate/delete already call
    `deleteSecret` (`github-apps.ts:381`) → map to ledger states.
  - `repo-inline-token`: keep ephemeral (create→use→purge); confirm no durable
    Infisical residue.
- **Phase 3 — derived copies.** Conditional seal (durable binding); rotation
  propagation choice; remove plaintext from snapshot-meta (reference + re-resolve)
  without breaking generic OC stores.
- **Phase 4 — purge migrated classes + crypto-shred.** Delete the migrated
  high-sensitivity rows; re-encrypt the retained `webhook-signing` secrets under a
  **separate key** (`WEBHOOK_SIGNING_KEY`); then **destroy `V3_SECRET_STORE_KEY`**
  so high-value ciphertext lingering in backups/WAL/replicas is unrecoverable (a
  row-delete alone is not destruction). The retained low-value webhook secrets
  keep their own key, which is *not* shredded.

Reversibility is dev-only (`SECRET_BACKEND=pg`).

## Verification

- **No-plaintext assertions** extended to the new paths (mirror the `sk-ant-`
  checkpoint scanner); confirm the Infisical SDK never logs values/headers on
  error.
- **Fail-closed tests:** Infisical down ⇒ seal/delivery/checkout fail cleanly;
  deleted/revoked credential ⇒ wake fails closed; webhook with unavailable secret
  ⇒ retry, never unsigned.
- **Round-trip + ledger integrity:** create/rotate/delete reconcile ledger ↔
  Infisical ↔ consumer pointer; sweep removes injected orphans.

## Credentials API cross-check (for the eventual UI)

Surface (`api/credentials.ts`): `POST` · `GET` · `PUT /default` · `GET/:id` ·
`DELETE /:id` (soft). Close, not blocking. Gaps a Credentials page needs:
standalone `PATCH /v3/credentials/:id {key}` (→ versioned rotate); `in_use_by`
count (warn before delete); delete must purge external + decide block-vs-warn
when in use; `proxyToV3` must forward `/v3/credentials/*` (UI step). (These apply
to `model-credential`; the other purposes have their own surfaces.)

## Open questions

- Rotation: next-seal/wake (simple) vs immediate push to active sessions.
- Copy 3: reference-only (preferred) vs encrypt-in-place, without changing generic
  OC SecretStore behavior.
- Enterprise tier (limits + SLA + audit streaming) — required for launch?
- Read-in-proxy posture — pursue now or later?

## Pointers

- Seam: `sessions-api/src/v3/core/secrets.ts`. Consumers: `core/credentials.ts`,
  `core/github-apps.ts`, `delivery/destinations.ts`, `sources/repo.ts`; reads at
  `runtime/credential.ts`, `runtime/repo-op.ts`, `internal/deliveries.ts`; seal at
  `runtime/turn.ts:215`.
- Derived copies: `api-edge/src/secret_stores.ts:192` (D1),
  `internal/qemu/snapshot.go:164` + `manager.go:3245` (checkpoint),
  `internal/secretsproxy/proxy.go` (the broker we keep).
- Config: `sessions-api/src/v3/config.ts`.
- Related: `token-billing.md` (managed-key default), Tier-0 provider notes
  (Anthropic WIF, OpenAI scoped keys).
