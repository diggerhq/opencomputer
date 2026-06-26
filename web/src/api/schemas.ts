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

export const SessionSchema = z.object({
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
export const SessionListSchema = z.array(SessionSchema)

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

export const SessionDetailSchema = z.object({
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

export type OrgInfo = z.infer<typeof OrgInfoSchema>
export type MeResponse = z.infer<typeof MeResponseSchema>
export type Session = z.infer<typeof SessionSchema>
export type PreviewURL = z.infer<typeof PreviewURLSchema>
export type SessionDetail = z.infer<typeof SessionDetailSchema>
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
