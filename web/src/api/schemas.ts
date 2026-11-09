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
  infrastructureEnabled: z.boolean(),
  /** Work 052 rollout: the organization has its computer. Absent on older edges. */
  computerEnabled: z.boolean().optional(),
  /** Administrator-selected workspace landing experience; absent on older edges. */
  onboardingExperience: z
    .enum(['computer', 'automations'])
    .nullable()
    .optional(),
  authMode: z.string().optional(),
  capabilities: z
    .object({
      signOut: z.boolean(),
      manageMembers: z.boolean(),
      switchOrganizations: z.boolean(),
    })
    .optional(),
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
  expiresAt: z.string().optional(),
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
})

export const AutumnAutoTopupSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number(),
  quantity: z.number(),
  budget: z.number().nullable(),
})

export const AutumnModelUsageSchema = z.object({
  enabled: z.boolean(),
  status: z.string(),
  markupBps: z.number(),
  providerSpendCents: z.number(),
  billedCreditsCents: z.number(),
  activeKeyCount: z.number(),
  billingStartedAt: z.string().nullable().optional(),
})

export const AutumnBillingSchema = z.object({
  creditsRemainingCents: z.number(),
  creditBreakdown: z.object({
    available: z.boolean(),
    planRemainingCents: z.number(),
    topupRemainingCents: z.number(),
    otherRemainingCents: z.number(),
    planResetsAt: z.string().nullable(),
  }),
  maxConcurrentSandboxes: z.number(),
  concurrencyPlan: z.string(),
  // `trial` is the 3-day trial; `base` is the pre-trial free tier, kept until
  // every free org is migrated (serverless-agents-ws 086).
  usagePlan: z.enum(['trial', 'base', 'pro', 'max']),
  isHalted: z.boolean(),
  haltReason: z.string().nullable().optional(),
  // orgs.billing_warning: trial_minutes | trial_days | trial_tokens |
  // allowance_80 | credits_low | payment_failed.
  warning: z.string().nullable().optional(),
  paymentPastDueAt: z.string().nullable().optional(),
  trialStartedAt: z.string().nullable().optional(),
  trialEndsAt: z.string().nullable().optional(),
  workMinutes: z
    .object({
      granted: z.number(),
      remaining: z.number(),
      resetsAt: z.string().nullable(),
    })
    .nullable()
    .optional(),
  periodEndsAt: z.string().nullable().optional(),
  // A change Autumn applies at the end of the paid period.
  scheduledChange: z
    .object({
      to: z.enum(['pro', 'cancel']),
      at: z.string().nullable(),
    })
    .nullable()
    .optional(),
  hasToppedUp: z.boolean(),
  hasPaidSubscription: z.boolean(),
  autoTopup: AutumnAutoTopupSchema.nullable(),
  modelUsage: AutumnModelUsageSchema.optional(),
})

export const AgentSessionUsageRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  deploymentId: z.string(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  source: z.string(),
  status: z.string(),
  title: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  modelCalls: z.number(),
  modelProviderCostUsd: z.number(),
  modelUsage: z.array(z.object({ timestamp: z.string(), costUsd: z.number() })),
  runtimeSecondsByTier: z.record(z.string(), z.number()),
})

export const AgentSessionUsageSchema = z.object({
  sessions: z.array(AgentSessionUsageRowSchema),
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

export const BrowserSessionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  provider_session_id: z.string(),
  status: z.string(),
  cdp_ws_url: z.string(),
  webdriver_ws_url: z.string(),
  live_view_url: z.string().nullable().optional(),
  base_url: z.string().nullable().optional(),
  headless: z.boolean().optional(),
  stealth: z.boolean().optional(),
  gpu: z.boolean().optional(),
  timeout_seconds: z.number().optional(),
  replay_id: z.string().optional(),
  replay_view_url: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable().optional(),
  provider_deleted_at: z.string().nullable().optional(),
  metered_at: z.string().nullable().optional(),
  metered_seconds: z.number().nullable().optional(),
  metered_usage_micro: z.number().nullable().optional(),
  metering_error: z.string().nullable().optional(),
  billable_seconds: z.number().optional(),
  estimated_cost_usd: z.number().optional(),
})
export const BrowserSessionListSchema = z.object({
  browsers: z.array(BrowserSessionSchema),
})

export const BrowserUsageSchema = z.object({
  total_sessions: z.number(),
  active_sessions: z.number(),
  total_billable_seconds: z.number(),
  total_usage_micro: z.number(),
  total_cost_usd: z.number(),
})

export const BrowserProfileSchema = z.object({
  id: z.string(),
  provider: z.string(),
  provider_profile_id: z.string(),
  name: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  deleted_at: z.string().nullable().optional(),
  provider_created_at: z.string().optional(),
  provider_updated_at: z.string().optional(),
  provider_last_used_at: z.string().optional(),
})
export const BrowserProfileListSchema = z.object({
  profiles: z.array(BrowserProfileSchema),
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
export type AgentSessionUsageRow = z.infer<typeof AgentSessionUsageRowSchema>
export type AgentSessionUsage = z.infer<typeof AgentSessionUsageSchema>
export type StripeInvoice = z.infer<typeof StripeInvoiceSchema>
export type SandboxUsageRow = z.infer<typeof SandboxUsageRowSchema>
export type SandboxUsage = z.infer<typeof SandboxUsageSchema>
export type BrowserSession = z.infer<typeof BrowserSessionSchema>
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>
export type SandboxWebhook = z.infer<typeof SandboxWebhookSchema>
export type SandboxWebhookDelivery = z.infer<
  typeof SandboxWebhookDeliverySchema
>
