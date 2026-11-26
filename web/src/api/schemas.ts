import { z } from 'zod'

// Runtime schemas for the API responses the live screens render. Types are
// inferred from these (single source of truth) and re-exported from client.ts.
// Status / kind / state fields are kept as z.string() (not z.enum) so a new
// server-side value never fails validation — the UI compares them as strings.

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

export const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
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

export type OrgInfo = z.infer<typeof OrgInfoSchema>
export type MeResponse = z.infer<typeof MeResponseSchema>
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
