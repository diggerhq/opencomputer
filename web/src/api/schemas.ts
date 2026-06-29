import { z } from 'zod'

// Runtime schemas for the API responses the live screens render. Types are
// inferred from these (single source of truth) and re-exported from client.ts.
// Status / kind / state fields are kept as z.string() (not z.enum) so a new
// server-side value never fails validation — the UI compares them as strings.

const record = z.record(z.string(), z.unknown())

export const OrgInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPersonal: z.boolean(),
  isActive: z.boolean(),
})

export const MeResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  orgId: z.string(),
  orgs: z.array(OrgInfoSchema).optional(),
})

export const SandboxSchema = z.object({
  id: z.string(),
  sandboxId: z.string(),
  orgId: z.string(),
  template: z.string(),
  region: z.string(),
  workerId: z.string(),
  status: z.string(),
  startedAt: z.string(),
  stoppedAt: z.string().optional(),
  errorMsg: z.string().optional(),
})
export const SandboxListSchema = z.array(SandboxSchema)

export const PreviewURLSchema = z.object({
  id: z.string(),
  sandboxId: z.string(),
  orgId: z.string(),
  hostname: z.string(),
  customHostname: z.string().optional(),
  port: z.number(),
  cfHostnameId: z.string().optional(),
  sslStatus: z.string(),
  authConfig: record,
  createdAt: z.string(),
})

export const SandboxDetailSchema = z.object({
  id: z.string(),
  sandboxId: z.string(),
  template: z.string(),
  status: z.string(),
  startedAt: z.string(),
  stoppedAt: z.string().optional(),
  errorMsg: z.string().optional(),
  config: z
    .object({
      timeout: z.number().optional(),
      cpuCount: z.number().optional(),
      memoryMB: z.number().optional(),
      networkEnabled: z.boolean().optional(),
      envs: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  checkpoint: z
    .object({
      checkpointKey: z.string(),
      sizeBytes: z.number(),
      hibernatedAt: z.string(),
    })
    .optional(),
  previewUrls: z.array(PreviewURLSchema).optional(),
})

export const SandboxStatsSchema = z.object({
  cpuPercent: z.number(),
  memUsage: z.number(),
  memLimit: z.number(),
  netInput: z.number(),
  netOutput: z.number(),
  pids: z.number(),
})

export const CheckpointItemSchema = z.object({
  id: z.string(),
  sandboxId: z.string(),
  orgId: z.string(),
  name: z.string(),
  status: z.string(),
  kind: z.string().optional(),
  promotionStatus: z.string().optional(),
  promotedCheckpointId: z.string().optional(),
  sizeBytes: z.number(),
  activeForks: z.number(),
  totalForks: z.number(),
  createdAt: z.string(),
  errorMsg: z.string().optional(),
  failedAt: z.string().optional(),
})

export const CheckpointsResponseSchema = z.object({
  checkpoints: z.array(CheckpointItemSchema),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
})

export const ImageCacheItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  contentHash: z.string(),
  checkpointId: z.string().optional(),
  name: z.string().optional(),
  manifest: record,
  status: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
})

export const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: z.string(),
  maxConcurrentSandboxes: z.number(),
  maxSandboxTimeoutSec: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  customDomain: z.string().optional(),
  cfHostnameId: z.string().optional(),
  domainVerificationStatus: z.string(),
  domainSslStatus: z.string(),
  verificationTxtName: z.string().optional(),
  verificationTxtValue: z.string().optional(),
  sslTxtName: z.string().optional(),
  sslTxtValue: z.string().optional(),
  workosOrgId: z.string().optional(),
  isPersonal: z.boolean(),
  creditBalanceCents: z.number(),
})

export const APIKeySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  keyPrefix: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  lastUsed: z.string().optional(),
  expiresAt: z.string().optional(),
  createdAt: z.string(),
})

export const CreatedAPIKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  keyPrefix: z.string(),
  createdAt: z.string(),
})

export const OrgMemberSchema = z.object({
  membershipId: z.string().optional(),
  workosUserId: z.string().optional(),
  id: z.string().optional(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  status: z.string().optional(),
})

export const OrgInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  state: z.string(),
  role: z.string().optional(),
  expiresAt: z.string(),
  createdAt: z.string(),
})

export const CreditsSchema = z.object({
  balanceCents: z.number(),
  isPersonal: z.boolean(),
})

export const BillingStateSchema = z.object({
  plan: z.string(),
  stripeCreditCents: z.number(),
  maxConcurrentSandboxes: z.number(),
  hasPaymentMethod: z.boolean(),
  freeCreditsRemainingCents: z.number(),
  billingProvider: z.string().optional(),
  // Managed model access (token-billing §6.6): the single gating authority for
  // offering the "Managed · billed to credits" credential option. Optional so an
  // older edge without the field validates (treated as unavailable).
  managedAvailable: z.boolean().optional(),
})

export const AutumnAutoTopupSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number(),
  quantity: z.number(),
})

export const AutumnBillingSchema = z.object({
  creditsRemainingCents: z.number(),
  maxConcurrentSandboxes: z.number(),
  concurrencyPlan: z.string(),
  isHalted: z.boolean(),
  hasToppedUp: z.boolean(),
  autoTopup: AutumnAutoTopupSchema.nullable(),
})

export const StripeInvoiceSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  amountDue: z.number(),
  amountPaid: z.number(),
  currency: z.string(),
  created: z.number(),
  hostedUrl: z.string(),
  pdfUrl: z.string(),
})

export const InvoicesResponseSchema = z.object({
  invoices: z.array(StripeInvoiceSchema),
})

export const SandboxUsageRowSchema = z.object({
  sandboxId: z.string(),
  status: z.string(),
  createdAt: z.number().optional(),
  seconds: z.number(),
  costCents: z.number(),
})

export const SandboxUsageSchema = z.object({
  windowDays: z.number(),
  totalCents: z.number(),
  sandboxes: z.array(SandboxUsageRowSchema),
})

// Sandbox lifecycle webhooks (Svix-backed, served by the edge /api/webhooks*).
// Org-scoped; shapes mirror the edge's toWire()/listDeliveries() camelCase.
export const SandboxWebhookSchema = z.object({
  id: z.string(),
  url: z.string(),
  eventTypes: z.array(z.string()).nullish(), // empty/absent = all events
  sandboxId: z.string().nullish(),
  name: z.string().nullish(),
  enabled: z.boolean(),
  hasSecret: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  secret: z.string().optional(), // returned once on create / rotate
})
export const SandboxWebhookListSchema = z.object({
  data: z.array(SandboxWebhookSchema),
})

export const SandboxWebhookDeliverySchema = z.object({
  id: z.string(), // message id — the redeliver/get key
  attemptId: z.string().optional(),
  status: z.string().optional(), // success | pending | failed
  responseStatusCode: z.number().nullish(),
  timestamp: z.string().optional(),
})
export const SandboxWebhookDeliveryListSchema = z.object({
  data: z.array(SandboxWebhookDeliverySchema),
})

// ── Durable Agent Sessions ───────────────────────────────────────────────────
// Mirrors the sessions-api contract verbatim (snake_case as the API returns
// it) — no transform layer to keep in sync. Reached via the edge proxy; lenient
// string fields so a new server enum never fails validation.

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string().nullish(),
  prompt_hash: z.string().nullish(),
  model: z.string(),
  runtime: z.string(),
  credential_id: z.string().nullable().optional(),
  revision: z.number().optional(),
  limits: record.nullish(),
  created_at: z.string(),
})
// List endpoints wrap rows in { data: [...], next_cursor? }.
export const AgentListSchema = z.object({
  data: z.array(AgentSchema),
  next_cursor: z.string().nullish(),
})

// Credentials — the reusable model-provider keys an agent/session resolves. The
// raw key is write-only; the API returns only metadata (last4 for display).
export const CredentialSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string().nullish(),
  last4: z.string().nullable().optional(),
  is_default: z.boolean().optional(),
  created_at: z.string(),
})
export const CredentialListSchema = z.object({
  data: z.array(CredentialSchema),
  next_cursor: z.string().nullish(),
})

// Slack connection (sessions-api `serializeSlackApp`) — an agent's BYO Slack app.
// Never carries secrets (bot token / signing secret stay in the secret backend).
// `handle` is the agent's name; slack_app_id/team_id/account_login fill in once
// connected. status: pending | active | revoked | error.
export const SlackConnectionSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  handle: z.string().nullish(),
  slack_app_id: z.string().nullable().optional(),
  team_id: z.string().nullable().optional(),
  account_login: z.string().nullable().optional(),
  status: z.string(),
  bot_token_verified: z.boolean().optional(),
  signing_verified: z.boolean().optional(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
})
// START intent: the generated manifest (an object to copy), the Slack apps URL,
// and the ordered human steps the wizard renders.
export const SlackManifestResponseSchema = z.object({
  manifest: record,
  create_url: z.string(),
  steps: z.array(z.string()),
  status: z.string(),
})

export const SessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  agent_id: z.string().nullable().optional(),
  credential_id: z.string().nullable().optional(),
  head: z.coerce.number().optional(), // current event seq; API returns it as a string ("0")
  last_turn: record.nullish(),
  usage: record.nullish(),
  limits: record.nullish(),
  metadata: record.nullish(),
  // The OC sandboxes this session runs on (agent-sandbox-ownership Phase 1).
  sandboxes: z
    .object({
      brain: z.string().nullish(),
      hands: z.string().nullish(),
    })
    .nullish(),
  created_at: z.string(),
})
export const SessionListSchema = z.object({
  data: z.array(SessionSchema),
  next_cursor: z.string().nullish(),
})

export const ActorSchema = z.object({
  id: z.string().optional(),
  display: z.string().optional(),
  type: z.string().optional(),
})

export const SessionEventSchema = z.object({
  id: z.string(),
  seq: z.number(),
  session: z.string().optional(), // owning session id (present on SSE frames)
  type: z.string(),
  level: z.string(),
  actor: ActorSchema.optional(),
  body: z.unknown().optional(),
  content_ref: z.string().nullish(), // set when body spilled to blob storage
  refs: record.nullish(),
  source: z.string().optional(),
  turn_id: z.string().nullable().optional(),
  ts: z.string().optional(),
  created_at: z.string().optional(),
})
export const SessionEventListSchema = z.object({
  data: z.array(SessionEventSchema),
  next_cursor: z.string().nullish(),
})

export const TurnSchema = z.object({
  id: z.string(),
  state: z.string(),
  yield_reason: z.string().nullable().optional(),
  attempt: z.number().optional(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  usage: record.optional(),
  error: z.string().nullable().optional(),
})

export const DestinationSchema = z.object({
  id: z.string(),
  url: z.string(),
  level: z.string().optional(),
  types: z.array(z.string()).nullish(),
  include_raw: z.boolean().optional(),
  enabled: z.boolean(),
  has_secret: z.boolean().optional(),
  created_after_seq: z.number().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
})

export const DeliverySchema = z.object({
  id: z.string(),
  destination: z.string().optional(), // the API field is `destination`, not `destination_id`
  event_id: z.string().optional(),
  event_seq: z.number().optional(),
  status: z.string(),
  attempts: z.number().optional(),
  last_attempt_at: z.string().nullable().optional(),
  response_code: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  created_at: z.string(),
})

export type Agent = z.infer<typeof AgentSchema>
export type Credential = z.infer<typeof CredentialSchema>
export type SlackConnection = z.infer<typeof SlackConnectionSchema>
export type SlackManifestResponse = z.infer<typeof SlackManifestResponseSchema>
export type Session = z.infer<typeof SessionSchema>
export type SessionEvent = z.infer<typeof SessionEventSchema>
export type Turn = z.infer<typeof TurnSchema>
export type Destination = z.infer<typeof DestinationSchema>
export type Delivery = z.infer<typeof DeliverySchema>

export type OrgInfo = z.infer<typeof OrgInfoSchema>
export type MeResponse = z.infer<typeof MeResponseSchema>
export type Sandbox = z.infer<typeof SandboxSchema>
export type PreviewURL = z.infer<typeof PreviewURLSchema>
export type SandboxDetail = z.infer<typeof SandboxDetailSchema>
export type SandboxStats = z.infer<typeof SandboxStatsSchema>
export type CheckpointItem = z.infer<typeof CheckpointItemSchema>
export type CheckpointsResponse = z.infer<typeof CheckpointsResponseSchema>
export type ImageCacheItem = z.infer<typeof ImageCacheItemSchema>
export type Org = z.infer<typeof OrgSchema>
export type APIKey = z.infer<typeof APIKeySchema>
export type OrgMember = z.infer<typeof OrgMemberSchema>
export type OrgInvitation = z.infer<typeof OrgInvitationSchema>
export type Credits = z.infer<typeof CreditsSchema>
export type BillingState = z.infer<typeof BillingStateSchema>
export type AutumnAutoTopup = z.infer<typeof AutumnAutoTopupSchema>
export type AutumnBilling = z.infer<typeof AutumnBillingSchema>
export type StripeInvoice = z.infer<typeof StripeInvoiceSchema>
export type SandboxUsageRow = z.infer<typeof SandboxUsageRowSchema>
export type SandboxUsage = z.infer<typeof SandboxUsageSchema>
export type SandboxWebhook = z.infer<typeof SandboxWebhookSchema>
export type SandboxWebhookDelivery = z.infer<
  typeof SandboxWebhookDeliverySchema
>
