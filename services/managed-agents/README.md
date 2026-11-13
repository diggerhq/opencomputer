# OpenComputer managed-agent backend

This directory contains the control plane and runtime that execute
OpenComputer managed agents. It is the backend behind the product, not a
separate product, CLI, SDK, authentication surface, or user-facing service.

Users build and operate agents with the `opencomputer` CLI, the public
OpenComputer API, and `app.opencomputer.dev`. Customer-facing code and
documentation must not direct users to this backend's service endpoints.

## Owned components

- Cloudflare edge control plane and Durable Object session coordination
- deployment and runtime service adapters
- model gateway and runtime token consumption
- MicroVM supervisor and OpenCode runtime integration
- managed connections and Slack channel delivery
- internal protocols and implementation tests

Public API adapters, the TypeScript `opencomputer` CLI, agent authoring
packages, dashboard journeys, and public documentation live elsewhere in
this repository.

## Development

Install dependencies and run the repository checks from this directory:

```bash
npm install
npm run check
npm test
```

Worker entrypoints are `src/edge/index.ts` and `src/platform/index.ts`; runtime
entrypoints live under `src/runtime/` and `src/microvm/`. Wrangler configuration
is checked in at this directory's root: `wrangler.jsonc` for local development, and
example configurations of the five deployed Workers (`wrangler.production.jsonc`,
`wrangler.platform.jsonc`, `wrangler.workerd.jsonc`, `wrangler.wire.jsonc`,
`wrangler.previews.jsonc`) with placeholder ids and hostnames.

Do not deploy from an orientation or documentation task. Development deploys
must use an explicitly named development configuration. Never target production
without a new request that names and authorizes the exact production target.

## Contract boundaries

- The public OpenComputer API authenticates users and forwards scoped managed-
  agent requests to this backend.
- Agent artifacts are built by the OpenComputer CLI and treated here as
  immutable deployment inputs.
- Channel credentials remain in the control plane and are never written into
  agent artifacts or MicroVM workspaces.
- Infrastructure bindings and resource identifiers are deployment contracts.

## Computers

When starting a Slack thread, `@Computer +claude +smart <task>` or
`@Computer +codex +smart <task>` overrides the owner's default harness for
that thread. The harness prefix goes first; the model tier (`+smart`,
`+fast`, `+default`) is optional and is resolved by the selected harness.
Without a harness prefix, the owner's existing Connections/subscription
selection applies. Prefixes only choose a harness when the session is
created; existing threads still use `!codex` and `!codex off`. An explicit
Codex choice uses the usual ChatGPT availability checks and refusal path.

Every organization gets a computer: a dedicated VM running Calvin's host,
reached from Slack through one organization-level OpenComputer Slack app
(design: the internal work doc for work 052). Code:
`src/computer/` (edge) and `src/platform/computers/` (Azure, platform Worker
only).

- `ComputerDurableObject` (binding `COMPUTERS`), one per organization
  (`accountId`): the computer row and its lifecycle (idempotent ARM PUTs on an
  alarm; free organizations park after 30 idle minutes (`COMPUTER_PARK_AFTER_MINUTES`), paid ones never), the
  host WebSocket, the delivery queue, sessions, people, session secrets and
  the linked Slack workspace's bot token. Objects named
  `computer-slack-team:<teamId>` record which organization a Slack workspace
  is linked to; `computer-pool` and `pool-<random>` are the warm pool (below).
  A computer's resource names (`oc-…`, `-nic`, `-data`, `-os`) are stored on
  its row, so a computer keeps its name when it changes hands.
- The platform Worker owns the cloud credentials and answers
  `POST /v1/computers/arm` on its service binding (`RUNTIMES`); the edge never
  sees a resource id, region or service-principal secret.

Routes. Dashboard, behind the edge assertion: `GET`/`POST /v1/computer`,
`GET /v1/computer/sessions`, `POST /v1/computer/slack/install`,
`DELETE /v1/computer/slack`. Without the assertion: `GET
/v1/computer/slack/callback` (install nonce), `POST
/v1/webhooks/computer/slack/events` and `.../interactivity` (Slack signature),
`GET /v1/computer/host?organizationId=<id>` (WebSocket, the organization's
host token).

Sessions API rollout gate (work 084). `COMPUTER_API_ORGS` (edge var) names the
organizations whose hosts are spoken to at protocol v4: empty or unset, none;
`*`, all; otherwise comma-separated organization ids. Any other organization's
host is welcomed at protocol 3 with no `wire` key and treated as a v3 host
(no access, epoch or revoked frames, Slack deliveries as v3), and every
sessions API call but `/me` answers `409 feature_unavailable`. A change applies
at each host's next hello; a deploy restarts the objects and closes their host
sockets, so every host says hello again. Production ships it empty.

Warm pool. With `COMPUTER_POOL_SIZE` = N (edge var; `"0"` or unset: no pool)
the `computer-pool` object keeps N computers booted and connected, created
like a free organization's (free size, default disk) under slot ids
`pool-<random>` and tagged `organization=pool`; they never park. When an
organization without a computer creates one (dashboard or first Slack
message) and its size is the free size, it claims a warm one instead of
waiting minutes for a VM: its row starts `ready` on that computer, the host
gets Calvin's `assign` (the organization's id, host token and URL) and
reconnects as the organization within seconds, and the resources' tags move
to the organization. An empty pool falls back to creating one; every claim
refills (at most three provisioning at a time). Cost: each warm computer
costs what a free organization's running computer does, about $80 a month,
so 25 warm is about $2,000 a month; raise it deliberately. Logs:
`computer.pool_*` (`pool_claim` carries the claim's milliseconds,
`pool_assign_unacknowledged` a host that never came back as the
organization).

Billing, the same as a serverless agent's (2026-10-11):

- Runtime. A session's working time (a `starting`/`busy` report until the
  next `idle`/`stopped`/`error`, or until the host's socket goes) is billed as
  `agent_runtime_2gb_1vcpu` through the same signed
  `/internal/agent-runtime-usage` request the Session object uses
  (`src/edge/runtime-usage.ts`; `OPENCOMPUTER_APP_URL`,
  `BLUE_USAGE_HMAC_SECRET`). Long turns bill every five minutes; each piece's
  ID is its idempotency key. Idle and parked time, and pool computers, never
  bill (`src/computer/billing.ts`).
- Credits. A Slack message passes the autonomous sessions' admission
  (`OPENCOMPUTER_BILLING`) before delivery; a refused organization's thread
  is told once to add credits at `<COMPUTER_PUBLIC_ORIGIN>/billing`.
- Models. Claude Code spends the organization's managed OpenRouter key
  (`managed_model_credentials`, metered as `model_spend`) at
  `https://openrouter.ai/api`; an organization without one is provisioned
  through the public edge's `/internal/model-billing/enable`
  (`OC_MANAGED_CRED_HMAC_SECRET`) and runs on the shared key below until it
  lands (`computer.model_key_fallback`).

Configuration (empty values make computer creation answer
`computer_not_configured` and log `computers are not configured: missing X`):

| Worker | Secrets | Vars |
|---|---|---|
| edge | `COMPUTER_HOST_TOKEN_KEY`, `SLACK_COMPUTER_CLIENT_ID`, `SLACK_COMPUTER_CLIENT_SECRET`, `SLACK_COMPUTER_SIGNING_SECRET`, `COMPUTER_ANTHROPIC_API_KEY` (fallback model credentials), `BLUE_USAGE_HMAC_SECRET` and `OC_MANAGED_CRED_HMAC_SECRET` (shared with serverless agents) | `COMPUTER_HOST_GATEWAY_URL` (wss origin the VM dials), `COMPUTER_DEFAULT_SIZE`, `COMPUTER_MAX_SIZE` (the $200 "max" usage plan's size; `COMPUTER_PAID_SIZE` is read when it is unset), `COMPUTER_DEFAULT_DISK_GIB`, `COMPUTER_MAX_DISK_GIB` (the data disk grows on its own at 80% used up to this, default 1024), `COMPUTER_POOL_SIZE`, `COMPUTER_VMS` (`self-managed`: the operator creates and runs each organization's VM, the gateway only accepts its host's connection and needs no platform Worker), `COMPUTER_API_ORGS`, `COMPUTER_PUBLIC_ORIGIN`, `SLACK_COMPUTER_SCOPES` |
| platform | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | `AZURE_SUBSCRIPTION_ID`, `AZURE_COMPUTER_RESOURCE_GROUP`, `AZURE_COMPUTER_REGION`, `AZURE_COMPUTER_SUBNET_ID`, `AZURE_COMPUTER_IDENTITY_ID`, `AZURE_COMPUTER_IDENTITY_CLIENT_ID`, `COMPUTER_BOOTSTRAP_URL` |

A production deploy sets these Worker secrets, under the same names: edge `COMPUTER_HOST_TOKEN_KEY`,
`SLACK_COMPUTER_CLIENT_ID`, `SLACK_COMPUTER_CLIENT_SECRET`,
`SLACK_COMPUTER_SIGNING_SECRET`, `COMPUTER_ANTHROPIC_API_KEY`;
platform `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. Each is optional: one that is
unset is left out of the Worker's secrets file, so it never wipes a value
already set on the Worker. The vars live in `wrangler.production.jsonc` and
`wrangler.platform.jsonc` (`COMPUTER_POOL_SIZE` stays `"0"` and the Azure ids
empty until the production infrastructure exists).

Size (2026-10-13): only the $200 usage plan ("max", the billing
admission's `usagePlan`) gets `COMPUTER_MAX_SIZE`; Pro and free get the
default. Every organization claims the warm pool's default-size computer; a
"max" organization's grows once it is connected and idle (the VM restarts;
Slack messages wait, and the thread is told once). A computer never shrinks
while running: a downsize happens on its next wake. A billing service that
does not report `usagePlan` resizes nothing.

Telemetry (Calvin's performance telemetry, work 054;
code in `src/computer/telemetry/`). Every Slack message gets a trace at the
events webhook (`message.received`); its context rides in the Slack queue and
dispatch payloads and on `deliver` to the host (`trace`, optional in Calvin's
protocol). The gateway's own events (`message.*`, `queue.*`, `command.handled`,
`ack.done`, `dispatch.*`, `host.*`, `interaction.received`) go straight to
Tinybird's Events API, one post per invocation from `waitUntil`; they never
delay or fail a message, and drops are counted. `catalog.ts`, `envelope.ts`,
`validate.ts` and `emitter.ts` are copies of Calvin's `src/telemetry/` and must
stay identical to it (`test/telemetry-*.test.ts` are its tests).

| Setting | Kind | Effect when unset |
|---|---|---|
| `TINYBIRD_API_URL` | edge var: the workspace's regional API base | nothing is sent |
| `TINYBIRD_APPEND_TOKEN` | edge secret: `calvin_append_gateway` | nothing is sent |
| `TELEMETRY_SIGNING_KEY` | edge secret: Ed25519 PKCS#8, base64 | hosts get no telemetry credential |
| `CF_VERSION_METADATA` | version metadata binding (production config) | events say version `dev` |

Host credentials: hosts send their own telemetry to Calvin's standalone
collector, not here, with a credential this Worker signs:
`v1.<base64url {org_id, host_id, exp}>.<Ed25519 signature over v1.<payload>>`,
byte-identical to the collector's reference issuer, valid 90 days, and fresh
in every `welcome` for an organization's host (`org_id` is the organization
the host token is bound to; pool computers get none until claimed). The
collector holds only the public key. To make the key pair, or a credential for
a `host.env` before a host first connects:

```bash
npm run telemetry-credential -- keygen
TELEMETRY_SIGNING_KEY=… npm run telemetry-credential -- issue --org <organization id> --host <SP_HOST_ID>
```

The production workflow passes `TINYBIRD_APPEND_TOKEN` and
`TELEMETRY_SIGNING_KEY` from the `managed-agents-production` environment like
the computer secrets (left out when unset). Not here: work 054's canary (a
Cron Trigger), since this edge Worker has no scheduled handler and production
deploys with `wrangler versions upload`, which does not change triggers.

Rollout:

- `ComputerDurableObject` is a new Durable Object class (migration `v5`).
  The first production edge deploy that carries it must run the production
  workflow with `edge_deploy_mode=full`; versions uploads cannot apply class
  migrations.
- Infrastructure per region (an Owner on the subscription; 052, "What a
  computer is, in Azure"): resource group, subnet with NAT and an NSG denying
  inbound, the `computer-bootstrap` identity, and a service principal with
  Contributor on the group and Managed Identity Operator on the identity,
  whose credentials become the platform secrets above.
- The distributed OpenComputer Slack app: OAuth redirect
  `https://app.opencomputer.dev/api/managed-agents/computer/slack/callback`,
  event requests `https://app.opencomputer.dev/api/managed-agents/computer/slack/events`
  (bot events `app_mention`, `message.im`, `message.channels`,
  `message.groups`, `agent_session_stopped` if offered, and `app_uninstalled`
  and `tokens_revoked`, which free the workspace for another organization,
  and `team_leave` and `user_change`, which delete the Claude subscription of
  a member who leaves, is deactivated or becomes a guest),
  interactivity
  `https://app.opencomputer.dev/api/managed-agents/computer/slack/interactivity`,
  scopes as `SLACK_COMPUTER_SCOPES`. The public edge forwards these to the
  routes above.
- The warm pool needs a Calvin release that handles `assign` (persist the
  identity, reconnect) before `COMPUTER_POOL_SIZE` goes above `"0"`; a host
  that ignores it stays connected as its pool id and the claiming
  organization's computer shows `connected: false`.
