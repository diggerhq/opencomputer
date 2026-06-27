# Secret material → managed Infisical Cloud (typed SecretBackend)

Status: **design + implementation plan**, in active development. Decision:
risk-tiered — move **high-sensitivity** customer credentials (model keys, GitHub
App keys, broker secrets) to managed **Infisical Cloud** (DB holds only a
reference); keep `webhook-signing` secrets in the encrypted DB; give single-use
repo tokens a real bounded-lifetime store. The in-progress code uses a placeholder
store ("B1") — AES-256-GCM in Postgres — for *all* secret classes; this doc
defines the proper design and the path to it. Technical / security / reliability
scope; the dashboard Credentials page is the last step and is out of scope here
(an API-readiness cross-check is included).

**In scope:** customer/BYO secrets (the five classes below). **Not this track:**
OC's *own* platform secrets — its GitHub App key, provider keys, the Infisical
bootstrap client secret — which stay where they are; a later platform-secrets
track can revisit them.

(Note: `v3` in existing paths/routes/env vars — `src/v3/…`, `/v3/…`,
`V3_SECRET_STORE_KEY` — is historical. v1/v2 were prototypes; this is the current
and only real surface, not a versioning scheme. Real identifiers are kept as-is
below so the doc points at actual code; new names introduced here are unprefixed.)

The core idea: treat the external-secret lifecycle as a **real durable
subsystem** — a typed backend, a local metadata ledger, typed errors,
per-purpose routing, and explicit delete/rotate semantics — not a swapped-out
crypto helper.

## Decisions (locked)

- **Rotation propagation:** next-turn/wake (bounded staleness ≤ 1 turn). No
  immediate mid-session push in v1.
- **Infisical tier:** non-Enterprise. We forgo the SLA + audit-log *streaming*;
  our own telemetry + Infisical's (non-streamed) audit log cover observability.
- **Region:** single-region **US** Infisical Cloud. Accepted limit: EU
  data-residency customers aren't served by this; self-host is the only lever if
  that changes.
- **Auth method:** **token-auth** — a machine-identity access token
  (`INFISICAL_TOKEN`, ~30-day static, IP-restricted, **rotate on a schedule**; no
  client-secret→short-token exchange). Provisioned for dev in `sessions-api/.env.v3`.
- **`repo-inline-token`:** store in **Infisical** (uniform custody) with the
  ledger's `expires_at` + sweep mandatory (Infisical static secrets don't
  auto-expire) and best-effort post-use delete.
- **copy-3 (snapshot-meta):** **reference-only + re-resolve on wake** (egress
  gated) — eliminates plaintext-on-disk and fixes stale-key-on-wake. Not
  encrypt-in-place.
- **`secret_ref` on delete:** **leave the dangling ref** on the tombstone (opaque
  id, not a secret; resolving a purged ref fails closed). No nullable migration.
- **read-in-proxy:** **later**, and only with **per-session scoped tokens**
  (otherwise it enlarges the identity blast radius onto the cell fleet). Not v1.

## The seam is broader than "model credentials"

`sessions-api/src/v3/core/secrets.ts` (4 functions, keyed by `(owner,
secret_ref)`) is the single at-rest path for **every** secret class:

| Purpose (slug) | Write site | Read (hot path) | Frequency |
|---|---|---|---|
| `model-credential` (Anthropic/OpenAI key) | `core/credentials.ts:56,137` | `runtime/credential.ts:102` (seal) | **per turn** (`turn.ts:215`) |
| `github-app-key` (BYO App private key PEM) | `core/github-apps.ts:198,220,301` | `runtime/repo-op.ts:122` | per repo-op |
| `github-broker-secret` | `core/github-apps.ts:226,315` | broker auth | per broker call |
| `webhook-signing` (destination secret) | `delivery/destinations.ts:71,162` | `internal/deliveries.ts:127` | **per delivery** (high vol) |
| `repo-inline-token` (`risky_short_lived_token`) | `sources/repo.ts:38` | `sources/repo.ts:193` | per checkout |

## Per-purpose routing (don't send everything to Infisical)

The classes differ in sensitivity, durability, and hot-path volume, so the typed
backend routes per purpose rather than all-to-Infisical (which would make an
Infisical hiccup break deliveries + repo ops + GitHub, not just sealing). Routing
is **static dispatch** — each purpose has exactly one backend, fixed at design
time. This is **not** a runtime `pg|infisical` selector for the same secret;
there is no such toggle (see Build-out):

| Purpose | Sensitivity | Lifetime | Home |
|---|---|---|---|
| `model-credential` | high (customer cloud account) | durable | **Infisical** |
| `github-app-key` | high (repo write) | durable | **Infisical** |
| `github-broker-secret` | high | durable | **Infisical** |
| `webhook-signing` | **integrity** (HMAC; leak ⇒ forge platform events to customer endpoints; no external-account access) | durable | **DB (encrypted PG), separate key** — lower-custody, keeps the per-delivery hot path + delivery availability off Infisical; **must fail closed** |
| `repo-inline-token` | medium (grants repo access) | meant single-use | **Infisical** (uniform custody) with the **ledger `expires_at` + sweep mandatory** (Infisical static secrets don't auto-expire) + best-effort post-use delete. **Not ephemeral today** — stored at create (`repo.ts:38`), purged only after a successful checkout (`repo.ts:144`), so durable if checkout is delayed/crashes/never runs; the TTL+sweep fixes that. |

## Where secret material lives at rest (full inventory)

Infisical fixes the *primary* copy but is not the only durable one:

1. **(primary)** `agent_auth.credential_secrets` (+ the other classes' refs) in
   sessions-api Postgres, AES-256-GCM under `V3_SECRET_STORE_KEY` (or an HKDF
   fallback off `V3_INTERNAL_AUTH_SECRET` — a double-duty the proper design
   drops). The **high-sensitivity classes move to Infisical**; **`webhook-signing`
   stays here on purpose** (integrity secret, no external-account access, hot
   per-delivery path) under a **separate, key-versioned key** so the high-value
   key can be crypto-shredded (below). `repo-inline-token` moves to **Infisical**
   (TTL-bounded + swept via the ledger).
2. **(derived)** `secret_store_entries` (Cloudflare D1) — the per-session sealed
   copy, AES-256-GCM under a **single global** `SECRET_ENCRYPTION_KEY`
   (`api-edge/src/secret_stores.ts:192`).
3. **(derived, PLAINTEXT on disk)** `snapshot-meta.json` — at hibernate/checkpoint,
   `secretsProxy.GetSessionTokens()` (sealed-token→**plaintext** map) is written
   as JSON, mode 0644, for wake/restore (`internal/qemu/snapshot.go:164`,
   re-registered on wake at `snapshot.go:599`).

## The local secret-ref ledger (the spine of the subsystem)

Add **`agent_auth.secret_refs`** — a durable local record of **every** secret ref
across **all** backends (not only Infisical), **values never stored**:

```
secret_ref (PK) · purpose · owner_id · backend (infisical | pg | pg-ttl)
· external_path (Infisical path/name; null for pg)
· status (reserved | active | superseded | pending_delete | deleted)
· expires_at (nullable; for pg-ttl repo-inline-token)
· created_at · updated_at · deletion_attempts · last_error
```

Covering PG-backed `webhook-signing` and TTL-backed `repo-inline-token` too keeps
lifecycle, expiry, sweep, telemetry, and delete **unified**, not split by backend.
It is the source of truth for cleanup, migration, observability, and prod
assertions, and it closes the crash-window gap: if the process dies after the
external write but before the pointer update, the `reserved` row is the durable
evidence the sweep needs. (Consumer tables keep only `secret_ref` + non-secret
display fields like `last4`.)

## Atomicity — reserve/finalize, never an HTTP call inside a PG txn

The placeholder writes the secret *inside* a PG transaction
(`agents.ts:137`→`credentials.ts:56`). External writes are HTTP and **must not**
be held inside a DB lock. Sequence instead:

1. **txn A (fast):** INSERT `secret_refs` row `status=reserved` (mint `secret_ref`).
2. **HTTP (no lock held):** write the value to Infisical at `external_path`
   (for PG-backed purposes this is a normal encrypted-row write).
3. **txn B (narrow pointer-swap):** set the consumer pointer (e.g.
   `credential_metadata.secret_ref`) + `secret_refs.status=active` (+ `last4`).

**Rotate = versioned write:** new `secret_ref` via the same 1→2→3; in txn B mark
the old row `superseded`.

**Delete (note: `credential_metadata.secret_ref` is `NOT NULL`, and credentials
soft-delete today, `credentials.ts:95`):** the consumer applies its existing
semantics (credentials → `deleted_at` tombstone; destinations/others → row
delete) **and** the ledger row goes `active → pending_delete`; a worker performs
the external delete with retries (`deletion_attempts`/`last_error`), then
`deleted`. Deletion does **not** rely on nulling the consumer pointer — the
tombstone keeps its `secret_ref` until the ledger confirms external purge; make
`secret_ref` nullable only if we want to scrub tombstones. **The ledger, not a
nulled pointer, is the delete state machine.** A **reconciliation sweep**
(authoritative, not just the outbox) lists each backend, diffs against the ledger,
removes orphans, expires `pg-ttl` rows past `expires_at`, and drives
`reserved`-too-long / `pending_delete` rows to resolution.

## Typed errors — missing vs unavailable (never silently downgrade)

The backend returns **typed results**, not `string | null`. Critically,
distinguish **"no secret configured"** from **"backend unavailable / resolve
failed."** Today webhook delivery does `dest_secret_ref ? resolve() : null` and
would **send unsigned** if a configured secret fails to resolve
(`internal/deliveries.ts:126`). Regardless of backend, a configured-but-unavailable
secret must become a **retryable (or permanent) failure**, never an unsigned send.
Every consumer maps the typed error to its correct behavior (fail the delivery,
fail-closed the seal, fail the checkout).

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
  credential, `setSecret` the new value (triggers the edge live-refresh to the
  running box). Costs a fan-out but propagates mid-session.

**Conditional-seal state must be an explicit durable binding** — not an in-process
cache, and not a vague "D1 entry exists" check (the D1 entry is named by env var,
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, **not** `secret_ref`, so it can't tell you
whether the store holds the *current* ref). Persist:

```
session_secret_bindings: { session_id, store_name, env_name,
                           credential_id, secret_ref, sealed_at }
```

Re-seal only when the credential's current `secret_ref` differs from the binding
(rotation), the binding/D1 entry is missing, or the ledger row isn't `active`
(revoked). Otherwise a missing entry could be wrongly skipped, or a revoked key
kept alive on wake.

## Derived runtime copies — and the dangerous wake ordering

- **Copy 2 (D1):** on rotate/delete the per-session entry must be refreshed/
  purged; wake must re-resolve (see conditional-seal) and **fail closed** on
  delete.
- **Copy 3 (snapshot-meta plaintext) + wake ordering — the most dangerous gap.**
  On wake/restore OC re-registers the persisted sealed-token→**plaintext** map
  into the proxy (`snapshot.go:599` `ReregisterSession`) **before** sessions-api
  can re-seal — so a key rotated/revoked during hibernation would be **live on the
  woken box** until (if ever) the next re-seal. Fix: for agent-session stores, **do
  not persist/re-register plaintext** — persist a *reference* and **re-resolve
  before any model egress is allowed** (gate egress on the re-seal), or at minimum
  overwrite before the runtime can call out. `snapshot.go:164/599` handle proxy
  state **generically** for *all* OC SecretStore users, so either tag the
  agent-session stores distinctly or define a generic "re-resolve on wake"
  contract user-created OC SecretStores can satisfy too — **don't** change behavior
  for non-session consumers.

## Hot path & rate limits

The worst hot path — `webhook-signing`, read **per delivery** — **stays in PG**,
so it's off Infisical entirely (an Infisical outage can't break deliveries).
What's left on Infisical: `model-credential` seal (per turn) and `github-*`
(infrequent). Conditional seal collapses model-cred reads to ~once/session +
once/rotation, so Infisical **Cloud** per-minute limits become a minor concern
rather than a launch blocker. Size remaining volume against Cloud limits;
**Enterprise** (custom limits) is likely **not** needed for rate alone, though it
may still be wanted for SLA/audit streaming.

## Stronger posture (worth considering): read in the proxy

Today sessions-api (a large attack surface) resolves plaintext and pushes it via
`setSecret`. The egress proxy already holds plaintext in its session map — it's
the narrow component. If the **proxy** fetched from Infisical at swap time using a
scoped token and sessions-api only passed **references**, the big app would never
touch plaintext. Bigger change (proxy is in the Go core), but it most shrinks the
in-memory custody window. Flagged as a direction, not Phase 1.

## Residual threats & detection

After Infisical, the realistic compromise is **"read everything"** — a leaked
machine identity or compromised sessions-api bulk-reads customer secrets.
Least-privilege + rotation limit scope but don't *detect* it. Add: anomaly
detection on bulk/cross-owner reads, per-time rate-limiting of the machine
identity, and alerting when read volume diverges from session volume.

## Instrumentation & observability

The typed `SecretBackend` is the **single choke point**: route *all* secret
access through it (no consumer touches a raw store) so instrumentation is
centralized and **coverage is assertable** — the underlying stores have no call
sites outside the backend. A seam that bypasses it is a bug, not an exception.

**Event taxonomy (value-free — refs / hashes / status only):**
- **Lifecycle** — every ledger transition (`reserved → active → superseded →
  pending_delete → deleted`, TTL `expired`): `purpose`, `secret_ref`, `backend`,
  `owner-hash`.
- **Access** — every `put / get / rotate / delete`: op, purpose, backend, result,
  duration, retryable-class.
- **Backend calls** — each Infisical/PG call: latency, status, and explicit
  classification of 429 / auth-failure / timeout (so rate-limit + identity
  failures are first-class signals).
- **Seal path** — conditional-seal **hit vs miss/re-seal**, wake **re-resolve**,
  and the egress-proxy **swap** (which env-name was swapped for which host,
  success/fail — emitted from the Go side).
- **Sweep/reconciler** — runs, orphans found/removed, TTL expirations, delete
  retries and exhaustion.

**Traceability:** thread the existing `TraceContext` (`telemetry/index.ts`,
already on the seal path) through **every** seam and **across repos** into the Go
proxy/wake, keyed by `session_id` / `turn_id` / `secret_ref`, so one journey is
reconstructable end-to-end: *resolve ref X (12ms) → seal into store Y → egress
swap to `api.anthropic.com` → turn*. Cross-repo trace propagation (sessions-api →
edge → cell/proxy) is the part most likely to be dropped — make it explicit.

**Errors — capture every failure mode, loud where it matters.** Each typed error
emits an event with its retryable class; the security-relevant ones **alert**, not
just log:
- **wake re-resolve failure** (a box could otherwise run on a stale/revoked key)
  — highest priority.
- **fail-closed** seals/deliveries/checkouts (Infisical down / bad config /
  secret unavailable) — the deploy-health signal.
- **machine-identity auth failure** + **rate-limit saturation** (429 vs limit).
- **delete-retry exhaustion** / **reserved-too-long orphans** (atomicity health).

**Metrics / SLIs:** seal latency + **conditional-seal hit-rate** (proves the
per-turn-read fix is actually working), Infisical read/write latency + error rate,
rate-limit headroom, ledger state-counts + sweep lag, fail-closed counts, wake
re-resolve count + failures, and bulk/cross-owner read rate (feeds the detection
above). These are the same signals the deploy "watch" list draws on.

**Audit completeness:** every read of a customer secret is recorded (machine
identity, owner-hash, purpose, op, time) via our telemetry **and** Infisical's own
audit log. Read seams that must each emit an access+audit event:
`runtime/credential.ts` (seal), `runtime/repo-op.ts`, `internal/deliveries.ts`,
`sources/repo.ts`, and the egress-proxy swap — none may read without one.

**Redaction:** events/logs carry refs, hashes, status — **never values** (`last4`
is the sole allowed exception, per Auth). Verifying the Infisical SDK + proxy
don't log request/response bodies is part of Verification.

## Auth, config & operational (fail-closed)

- Config: **`INFISICAL_TOKEN`** (machine-identity access token, token-auth),
  `INFISICAL_PROJECT_ID`, **`INFISICAL_ENVIRONMENT`** (the APIs are project +
  environment + path), `INFISICAL_SITE_URL`. **Fail startup if prod config is
  incomplete.**
- **Separate dev/prod identities + projects.** Token-auth = a ~30-day static,
  IP-restricted access token → **rotate on a schedule** (there's no
  client-secret→short-token exchange to renew); keep the IP restriction on.
- **Fail closed:** if Infisical is unreachable, the operation **fails** — there
  is no runtime PG-fallback to silently degrade to (none is built; see Build-out).
- **Machine identity** is the most sensitive credential in the system (reads
  every customer secret): least-privilege scope, rotate, alert.
- **Bootstrap secret:** the Infisical client secret is the one secret that can't
  live in Infisical → Fly secret; rotation requires a deploy.
- **Edge calls too:** `SecretStore.create/list/update/setSecret` run via the edge
  on a short-lived provision token and can fail independently → retry/circuit-
  breaker, and fix the TOCTOU in create-or-reuse under concurrent turns.
- **Telemetry/logging hygiene:** every secret op logs `purpose`, `secret_ref`,
  **owner-hash**, status, duration, retryable-class — **never values**. `last4` is
  the **one allowed** secret-derived field (it's already returned by the API as a
  display hint), so the current `sealCredentialForSession` last4 emit
  (`credential.ts:135`) is acceptable — but it is the only exception.

## Path scheme (sanitized, unambiguous)

Infisical folder names allow letters/numbers/dashes; owner ids carry colons/
prefixes (`keyhash:`, `oc-org:`), and purpose slugs use dashes. Split path vs name:

```
secretPath = /owners/<sha256(owner)>/secrets/<purpose-slug>
secretName = <safe(secret_ref)>
```

Real owner id stays only in PG + telemetry, never in the Infisical path.

## Trust boundary, exit & residency

- Managed Cloud = **Infisical operators can technically see plaintext** (not
  client-side encrypted). Acceptable, but state it — part of "defensible."
- **Exit:** the `SecretBackend` abstraction + the ledger make provider-swap real,
  not theoretical; keep it genuinely swappable.
- **Residency:** single-region Cloud may not satisfy EU data-residency — the one
  thing that could re-open self-host for a customer subset.
- **DR:** Infisical is the only copy of these keys (by design). Data-loss ⇒
  customers re-enter keys; acceptable for re-enterable secrets, but say so.

## Build-out plan

- **Phase 0 — Infisical setup.** Per-env projects + separate machine identities +
  least-privilege scope + finite client-secret TTL. Client module + config (incl.
  `INFISICAL_ENVIRONMENT`) in sessions-api via Fly secrets; dev first.
- **Phase 1 — ledger + typed backend.** Create `agent_auth.secret_refs` (+
  `session_secret_bindings`); implement the typed `SecretBackend` (purpose-routed,
  typed errors, per-backend impls); reserve/finalize + pointer-swap; reconciliation
  sweep + telemetry.
- **Phase 2 — migrate consumers, each with explicit delete/rotate behavior:**
  - `model-credential`: `create`/`rotate` via versioned write; **delete is
    soft-only today** (`credentials.ts:95`) → also drive ledger external purge.
  - `webhook-signing`: **stays in PG** under a **key-versioned** key; typed-error
    fail-closed in delivery; **destination delete removes only the row today**
    (`destinations.ts:193`) → also purge the secret.
  - `github-app-key` / `github-broker-secret`: rotate/delete already call
    `deleteSecret` (`github-apps.ts:381`) → map to ledger states.
  - `repo-inline-token`: move to **Infisical**; the ledger's `expires_at` + sweep
    guarantee an un-materialized token is purged even if checkout never runs;
    post-use delete is best-effort-with-retry.
- **Phase 3 — derived copies.** Conditional seal (durable binding); rotation
  propagation choice; fix wake ordering (reference + re-resolve, egress gated on
  re-seal) without breaking generic OC stores.
- **Phase 4 — purge migrated classes + crypto-shred.** Delete the migrated
  high-sensitivity rows; ensure retained PG secrets use **separate, key-versioned**
  keys (`WEBHOOK_SIGNING_KEY` with a key-id column, so future rotation decrypts old
  rows while re-encrypting — no repeat of today's all-or-nothing key); then
  **destroy `V3_SECRET_STORE_KEY`** so high-value ciphertext lingering in
  backups/WAL/replicas is unrecoverable (a row-delete alone is not destruction).

**No backend selector, no parallel live paths.** Per-purpose routing is static
(one backend per purpose). There is no runtime `pg|infisical` toggle for the same
secret — that would double the audit/test surface of the most sensitive code and
risk prod silently using the insecure path. With no production data, the
placeholder is **deleted** for the migrated classes; any pre-cutover rollback is
version control.

## Deployment, testing & rollback

**Components (cross-repo — coordinate):**
- **sessions-api** (Fly: `bolt-platform-dev` → `bolt-platform`; deploys on merge
  to main): the typed SecretBackend, the `secret_refs` + `session_secret_bindings`
  migrations, consumer changes, Infisical client/config.
- **OC Go core / cells:** the wake-ordering + `snapshot-meta` change
  (`snapshot.go`), egress gating, the secrets proxy.
- **OC edge** (`deploy-api-edge.yml`, `target=dev|prod`): only if D1 secret-store
  behavior changes — minimal, the broker stays.

**Migrations are additive-first** (`migrations-v3`): `secret_refs`,
`session_secret_bindings`, the webhook key-id column. Additive ⇒ deploy ahead of
code, safe to leave in place on rollback. No destructive migration before Phase 4.

**Deploy order (dev before prod, each phase):** additive migrations → Infisical
Phase 0 (project + identity, dev first) → sessions-api backend → the Go
wake-ordering change. **The one real coordination:** the OC Go side must
**tolerate both** old (plaintext) and new (reference-only) `snapshot-meta`
*before* sessions-api stops persisting plaintext, so in-flight hibernated boxes
don't break on wake; flip to reference-only after.

**Testing:**
- Run the Verification matrix (below) in CI.
- **Dev caveat:** use `bolt-platform-dev` + a **dev Infisical project** for the
  app/DB paths, but the **dev box is not a faithful prod replica** (secret-store
  sync / capacity / runtime artifacts may be missing) — exercise the
  seal/wake/egress paths on a **real cell** end-to-end; don't trust dev alone for
  those.
- **Natural canary:** the credential feature is **not user-facing until the
  Credentials page (the last step)**, so the backend can land on prod and be
  exercised with an **internal test org/key** before any customer touches it — no
  runtime selector required.

**Rollback:**
- **Phases 0–3 are reversible:** redeploy the prior sessions-api image / cell
  build (`git revert` + deploy). Additive migrations stay; no data loss (no
  production data).
- **Phase 4 is the point of no return** — deleting placeholder rows +
  **crypto-shredding `V3_SECRET_STORE_KEY`** is irreversible. Gate it on the
  **prod preflight** (zero high-sensitivity B1 rows) + a soak on Phases 1–3.
  Don't shred until confident.
- Keep `snapshot-meta` **backward-compatible** so reverting the Go change never
  strands hibernated boxes.

**Watch on each deploy:** seal failure rate (fail-closed surfaces a bad config /
outage as *failures*, not silent insecurity) and ledger health (stuck
`reserved` / `pending_delete` rows, sweep lag).

## Verification

- **Prod preflight (executable, not assumed):** a startup/migration assertion that
  high-sensitivity B1 rows in `credential_secrets` are **zero** before Infisical-
  only is enabled — or, if any exist, a required migration path. Don't leave "no
  production data" as a human assumption.
- **No-plaintext assertions** extended to the new paths (mirror the `sk-ant-`
  checkpoint scanner); confirm the Infisical SDK never logs values/headers on error.
- **Fail-closed tests:** Infisical down ⇒ seal/delivery/checkout fail cleanly;
  deleted/revoked credential ⇒ wake fails closed; webhook with unavailable secret
  ⇒ retry, never unsigned; rotated-while-hibernated ⇒ woken box does **not** use the
  old key.
- **Round-trip + ledger integrity:** create/rotate/delete reconcile ledger ↔
  backend ↔ consumer pointer; sweep removes injected orphans + expires TTL rows.
- **Instrumentation coverage:** assert no secret access bypasses the typed backend
  (the underlying stores have no call sites outside it), and that each enumerated
  read seam emits an access+audit event + a trace span.

## Credentials API cross-check (for the eventual UI)

Surface (`api/credentials.ts`): `POST` · `GET` · `PUT /default` · `GET/:id` ·
`DELETE /:id` (soft). Close, not blocking. Gaps a Credentials page needs:
standalone `PATCH /v3/credentials/:id {key}` (→ versioned rotate); `in_use_by`
count (warn before delete); delete must purge external + decide block-vs-warn when
in use; `proxyToV3` must forward `/v3/credentials/*` (UI step). (These apply to
`model-credential`; the other purposes have their own surfaces.)

## Open questions / to confirm at build

(The design forks are decided — see **Decisions (locked)**. These remain:)
- **Infisical project config:** `INFISICAL_PROJECT_ID` + `INFISICAL_ENVIRONMENT`,
  and confirm the `/owners/<hash>/secrets/<purpose>` folder layout — dev first,
  then prod.
- **Infisical terms to verify:** exact non-Enterprise per-minute limits (confirm
  our volume fits) and destructive-delete + retention semantics (how strongly
  "delete" destroys).
- **SDK redaction:** confirm the Infisical client never logs values/bodies on
  error; wrap if needed (build-time).

## Pointers

- Seam: `sessions-api/src/v3/core/secrets.ts`. Consumers: `core/credentials.ts`,
  `core/github-apps.ts`, `delivery/destinations.ts`, `sources/repo.ts`; reads at
  `runtime/credential.ts`, `runtime/repo-op.ts`, `internal/deliveries.ts`; seal at
  `runtime/turn.ts:215`.
- Derived copies: `api-edge/src/secret_stores.ts:192` (D1),
  `internal/qemu/snapshot.go:164` (persist) + `snapshot.go:599` (wake re-register)
  + `manager.go:3245`, `internal/secretsproxy/proxy.go` (the broker we keep).
- Schema: `credential_metadata.secret_ref` is `NOT NULL` (`migrations-v3/001_init.sql:278`).
- Config: `sessions-api/src/v3/config.ts`.
- Related: `token-billing.md` (managed-key default), Tier-0 provider notes
  (Anthropic WIF, OpenAI scoped keys).
