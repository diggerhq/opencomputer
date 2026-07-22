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
})

export const AutumnAutoTopupSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number(),
  quantity: z.number(),
})

export const AutumnModelUsageSchema = z.object({
  enabled: z.boolean(),
  status: z.string(),
  markupBps: z.number(),
  providerSpendCents: z.number(),
  billedCreditsCents: z.number(),
  activeKeyCount: z.number(),
})

export const AutumnBillingSchema = z.object({
  creditsRemainingCents: z.number(),
  maxConcurrentSandboxes: z.number(),
  concurrencyPlan: z.string(),
  isHalted: z.boolean(),
  hasToppedUp: z.boolean(),
  autoTopup: AutumnAutoTopupSchema.nullable(),
  modelUsage: AutumnModelUsageSchema.optional(),
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

// ── Durable Agent Sessions ───────────────────────────────────────────────────
// Mirrors the sessions-api contract verbatim (snake_case as the API returns
// it) — no transform layer to keep in sync. Reached via the edge proxy; lenient
// string fields so a new server enum never fails validation.

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  invoke_url: z.string(),
  prompt: z.string().nullish(),
  prompt_hash: z.string().nullish(),
  model: z.string(),
  runtime: z.string(),
  credential_id: z.string().nullable().optional(),
  revision: z.number().optional(),
  // Agent Revisions (design 009): the active production pointer + a summary of it.
  active_revision_id: z.string().nullish(),
  active_revision: z
    .object({ id: z.string(), number: z.number(), digest: z.string() })
    .nullish(),
  limits: record.nullish(),
  deployment_status: z
    .object({
      deployment_id: z.string().nullish(),
      state: z.string(),
      result: z.string().nullish(),
      error_class: z.string().nullish(),
      live_touched: z.boolean(),
      live_status: z.string().nullish(),
      legacy_live_compatible: z.boolean().optional(),
      updated_at: z.string().nullish(),
    })
    .optional(),
  flue: z
    .object({
      agent_name: z.string().nullish(),
      live: z
        .object({
          deployment_id: z.string().nullish(),
          worker_version_id: z.string().nullish(),
          status: z.string().nullish(),
          guarded_at: z.string().nullish(),
          deadline_at: z.string().nullish(),
          updated_at: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
  created_at: z.string(),
})
// List endpoints wrap rows in { data: [...], next_cursor? }.
export const AgentListSchema = z.object({
  data: z.array(AgentSchema),
  next_cursor: z.string().nullish(),
})

// Agent Revisions (design 009) — immutable deployed versions of an agent's behavior.
// `active` flags the production pointer; rollback = activate an earlier revision.
export const AgentRevisionSchema = z.object({
  id: z.string(),
  number: z.number(),
  digest: z.string(),
  created_at: z.string(),
  active: z.boolean(),
  sha: z.string().nullish(), // commit that produced it (null for dashboard/inline revisions)
  ref: z.string().nullish(), // branch the commit came from
})
export const AgentRevisionListSchema = z.object({
  data: z.array(AgentRevisionSchema),
})
// A deploy event (provenance + state); one revision can be produced by many deploys.
export const AgentDeploySchema = z.object({
  id: z.string(),
  state: z.string(), // validating | uploading | ready | failed
  result: z.string().nullish(), // created | deduped | failed
  source: record.nullish(), // { via, repo_id?, path?, git_sha? }
  actor: z.string().nullish(),
  revision_id: z.string().nullish(),
  created_at: z.string(),
})
export const AgentDeployListSchema = z.object({
  data: z.array(AgentDeploySchema),
})

// Managed repository deployments (work 025). The identity and canonical state
// are required; phase detail is additive so an older dashboard can keep
// rendering when the control plane gains new metadata.
export const AgentDeploymentErrorSchema = z
  .object({
    class: z.string(),
    phase: z.string().optional(),
    message: z.string().optional(),
    retryable: z.boolean().optional(),
    exit_code: z.number().optional(),
  })
  .nullish()

export const AgentDeploymentBuildSchema = z
  .object({
    schema_version: z.number().optional(),
    attempts: z.number().optional(),
    lockfile_version: z.number().optional(),
    source_bytes: z.number().optional(),
    source_files: z.number().optional(),
    artifact_bytes: z.number().optional(),
    root: z.string().optional(),
    node: z.string().optional(),
    npm: z.string().optional(),
    builder: z.string().optional(),
    snapshot: z.string().optional(),
    artifact_digest: z.string().optional(),
  })
  .nullish()

export const AgentDeploymentSourceRelationSchema = z
  .object({
    repo: z
      .object({
        id: z.string(),
        full_name: z.string().nullish(),
      })
      .nullish(),
    path: z.string().nullish(),
    production_ref: z.string().nullish(),
    status: z.string().nullish(),
    ref: z.string().nullish(),
    sha: z.string().nullish(),
    commit_url: z.string().nullish(),
  })
  .nullish()

export const AgentDeploymentLiveSchema = z
  .object({
    deployment_id: z.string().optional(),
    worker_version_id: z.string().optional(),
    status: z.string().optional(),
    guarded_at: z.string().optional(),
    deadline_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .nullish()

export const AgentDeploymentSchema = z.object({
  id: z.string(),
  state: z.string(),
  phase: z.string(),
  terminal: z.boolean(),
  result: z.string().nullish(),
  input_type: z.string(),
  revision_id: z.string().nullish(),
  revision: z
    .object({
      id: z.string(),
      number: z.number().nullish(),
      digest: z.string().nullish(),
      created_at: z.string().nullish(),
    })
    .nullish(),
  source: record.nullish(),
  source_relation: AgentDeploymentSourceRelationSchema,
  actor: z
    .object({
      kind: z.string().optional(),
      id: z.string().optional(),
      login: z.string().optional(),
    })
    .nullish(),
  ref: z.string().nullish(),
  sha: z.string().nullish(),
  error: AgentDeploymentErrorSchema,
  error_class: z.string().nullish(),
  build: AgentDeploymentBuildSchema,
  configuration: z
    .object({
      entrypoint: z.string().optional(),
      model: z.string().optional(),
      runtime: z.object({ family: z.string(), type: z.string() }).optional(),
      variable_names: z.array(z.string()).default([]),
    })
    .nullish(),
  log_bytes: z.number(),
  log_truncated: z.boolean(),
  live_touched: z.boolean(),
  agent_live: AgentDeploymentLiveSchema,
  restore_eligibility: z.string(),
  redeploy_of: z.unknown().nullish(),
  allowed_actions: z.array(z.string()).default([]),
  active: z.boolean(),
  timing: z.object({
    accepted_at: z.string().nullish(),
    started_at: z.string().nullish(),
    finished_at: z.string().nullish(),
    cancel_requested_at: z.string().nullish(),
    queue_ms: z.number().nullish(),
    run_ms: z.number().nullish(),
    total_ms: z.number().nullish(),
  }),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
})

export const AgentDeploymentListSchema = z.object({
  data: z.array(AgentDeploymentSchema),
  next_cursor: z.string().nullable(),
})

export const AgentDeploymentCommandResponseSchema = z.object({
  deployment: z.object({
    id: z.string(),
    state: z.string(),
    revision_id: z.string().nullish(),
    active: z.boolean(),
  }),
})

export const AgentDeploymentLogSchema = z.object({
  // Postgres bigint serializers may return a decimal string. Treat this as an
  // opaque cursor/identity in the dashboard rather than narrowing it to JS's
  // potentially lossy number range.
  seq: z.string(),
  cursor: z.string(),
  recorded_at: z.string(),
  phase: z.string(),
  stream: z.string(),
  chunk: z.string(),
})

export const AgentDeploymentLogsSchema = z.object({
  data: z.array(AgentDeploymentLogSchema).default([]),
  next_cursor: z.string().nullish(),
  has_more: z.boolean(),
})
// The pointer-move response from POST …/revisions/:rev/activate.
export const ActivateRevisionSchema = z.object({
  active_revision_id: z.string(),
})
// A file within a skill (path/mode/size).
export const SkillFileSchema = z.object({
  path: z.string(),
  mode: z.number(),
  size: z.number(),
})
// A skill — the domain unit: a folder with a SKILL.md (name + description from frontmatter).
export const SkillItemSchema = z.object({
  name: z.string(),
  description: z.string().nullish(),
  files: z.array(SkillFileSchema).default([]),
})
// The agent's skills (GET …/skills) — the active revision's skills, enumerated.
export const AgentSkillsSchema = z.object({
  revision: z
    .object({ id: z.string(), number: z.number(), digest: z.string() })
    .nullish(),
  skill_bundle_digest: z.string().nullish(),
  skills: z.array(SkillItemSchema).default([]),
})
// The deploy-shaped response from POST …/revisions.
export const DeployResultSchema = z.object({
  deploy_id: z.string(),
  state: z.string(),
  result: z.string().nullish(),
  revision: z
    .object({
      id: z.string(),
      number: z.number(),
      digest: z.string(),
      active: z.boolean(),
    })
    .nullish(),
})

// Deployment source — the agent ⟷ repo dir bind for push-to-deploy (deploy-from-github).
export const DeploymentSourceSchema = z.object({
  agent_id: z.string(),
  repo_id: z.string(),
  path: z.string(),
  production_ref: z.string(),
  status: z.string(), // active | source_profile_changed | path_missing | ref_missing | auth_required | repo_not_selected | app_suspended | error
  latest_seen_sha: z.string().nullish(),
  active_deployed_sha: z.string().nullish(),
  full_name: z.string().nullish(), // "owner/repo" (joined from the repo row)
  source_profile: z.literal('flue-app-v1').nullish(),
  source_profile_version: z.literal(1).nullish(),
  review_fingerprint: z.string().nullish(),
})
export const DeploymentSourceResponseSchema = z.object({
  source: DeploymentSourceSchema,
})

// The OC GitHub App (deploy) install-state + pickable repos — admin/operator surface.
export const DeployAppRepoSchema = z.object({
  // Older installations can briefly lack their registered repo_ coordinate
  // during rollout. The import picker filters those rows until registration
  // reconciliation completes.
  id: z.string().nullish(),
  full_name: z.string(),
  default_branch: z.string().nullish(),
  private: z.boolean().nullish(),
  linked_sources: z
    .array(
      z.object({
        path: z.string(),
        production_ref: z.string(),
        status: z.string(),
        agent: z.object({ id: z.string(), name: z.string() }),
      }),
    )
    .default([]),
})
export const DeployAppSchema = z.object({
  installed: z.boolean(),
  install_url: z.string().nullish(),
  configure_url: z.string().nullish(),
  account: z.string().nullish(),
  repository_selection: z.enum(['all', 'selected']).nullish(),
  repositories: z.array(DeployAppRepoSchema).default([]),
})

// GitHub repositories a Flue agent may use as working sources. This is
// intentionally separate from DeploymentSourceSchema: a deployment source
// provides the agent's code, while this policy bounds repositories the running
// agent may check out and publish to.
export const RepositoryAccessPolicySchema = z.union([
  z.object({ mode: z.literal('all') }),
  z.object({
    mode: z.literal('selected'),
    repository_ids: z.array(z.string()),
  }),
])
export const RepositoryAccessRepositorySchema = z.object({
  id: z.string(),
  full_name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
})
export const RepositoryAccessSchema = z.object({
  policy: RepositoryAccessPolicySchema,
  grant: z.object({
    status: z.enum(['active', 'not_installed', 'unavailable']),
    account: z.string().nullable(),
    repository_selection: z.enum(['all', 'selected']).nullable(),
    install_url: z.string(),
    configure_url: z.string().nullable(),
    truncated: z.boolean(),
  }),
  effective_repositories: z.array(RepositoryAccessRepositorySchema).nullable(),
  unavailable_selected_repositories: z
    .array(z.object({ id: z.string(), full_name: z.string() }))
    .default([]),
})
export const LinkResultSchema = z.object({
  source: DeploymentSourceSchema,
  deployment_id: z.string().nullish(),
  deploy_error: z.object({ type: z.string(), message: z.string() }).nullish(),
})

export const RepositoryReviewIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
})

export const RepositoryCandidateRootSchema = z.object({
  path: z.string(),
  source_profile: z.literal('flue-app-v1').nullable(),
  summary: z.string(),
  marker: z.enum([
    'agent.toml',
    'flue.config.ts',
    'flue.config.js',
    'flue.config.mjs',
    'flue.config.cjs',
  ]),
})

export const FlueSourceProfileSchema = z.object({
  source_profile: z.literal('flue-app-v1'),
  source_profile_version: z.literal(1),
  manifest: z.object({
    schema_version: z.literal(1),
    entrypoint: z.string(),
    model: z.string(),
    runtime: z.object({
      family: z.literal('flue'),
      type: z.string(),
    }),
    vars: z.record(z.string(), z.string()),
  }),
  package: z.object({
    name: z.string().nullish(),
    node_engine: z.string(),
    flue_cli: z.string(),
  }),
  lockfile: z.object({ version: z.number() }),
  builder: z.object({ node: z.string() }),
  source: z.object({ files: z.number(), bytes: z.number() }),
  variable_names: z.array(z.string()).default([]),
  warnings: z.array(RepositoryReviewIssueSchema).default([]),
})

const ExactRepositorySourceInterpretationSchema = z.object({
  disposition: z.literal('exact'),
  source_profile: z.literal('flue-app-v1'),
  source_profile_version: z.literal(1),
  summary: z.string(),
  reason_code: z.string(),
  assumptions: z.array(z.string()).default([]),
  agent: z.object({
    runtime: z.literal('flue'),
    model: z.string(),
  }),
})

const InvalidRepositorySourceInterpretationBase = z.object({
  disposition: z.literal('invalid'),
  summary: z.string(),
  reason_code: z.string(),
  issues: z.array(RepositoryReviewIssueSchema).default([]),
})

const InvalidRepositorySourceInterpretationSchema = z.union([
  InvalidRepositorySourceInterpretationBase.extend({
    source_profile: z.literal('flue-app-v1'),
    source_profile_version: z.literal(1),
  }),
  InvalidRepositorySourceInterpretationBase.extend({
    source_profile: z.null(),
    source_profile_version: z.null(),
  }),
])

const UnrecognizedRepositorySourceInterpretationSchema = z.object({
  disposition: z.literal('unrecognized'),
  source_profile: z.null(),
  source_profile_version: z.null(),
  summary: z.string(),
  reason_code: z.literal('unrecognized_source'),
})

export const RepositorySourceInterpretationSchema = z.union([
  ExactRepositorySourceInterpretationSchema,
  InvalidRepositorySourceInterpretationSchema,
  UnrecognizedRepositorySourceInterpretationSchema,
])

export const RepositorySourceInspectionSchema = z
  .object({
    repository: z.object({
      id: z.string(),
      full_name: z.string(),
      default_branch: z.string().nullish(),
    }),
    root: z.string(),
    production_ref: z.string(),
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
    interpretation: RepositorySourceInterpretationSchema,
    profile: FlueSourceProfileSchema.nullable(),
    review_fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    candidate_roots: z.array(RepositoryCandidateRootSchema).max(20).default([]),
    candidate_roots_truncated: z.boolean(),
  })
  .superRefine((review, context) => {
    const exact = review.interpretation.disposition === 'exact'
    if (exact !== (review.profile !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['profile'],
        message: exact
          ? 'an exact source interpretation requires its profile projection'
          : 'a non-exact source interpretation cannot include a deployable profile',
      })
    }
  })

export const ImportAgentResponseSchema = z.object({
  agent: AgentSchema,
  source: DeploymentSourceSchema,
  deployment: AgentDeploymentSchema,
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
  open_url: z.string().nullable().optional(),
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

export const ManagedSlackConnectionSchema = z.object({
  mode: z.literal('managed'),
  status: z.enum(['active', 'disconnected', 'error', 'revoked']),
  workspace: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
  app: z.object({ id: z.string(), handle: z.string().nullish() }).nullish(),
  open_url: z.string().nullish(),
  connected_at: z.string().nullish(),
  error_code: z.string().nullish(),
})

export const ManagedSlackWorkspaceConnectionSchema =
  ManagedSlackConnectionSchema.extend({
    agent: z.object({ id: z.string(), name: z.string() }),
  })

export const ManagedSlackWorkspaceConnectionListSchema = z.object({
  data: z.array(ManagedSlackWorkspaceConnectionSchema),
})

// A race-safe authorize is idempotent: if the connection became active after
// the dashboard status read, the API returns that active connection instead of
// minting another OAuth intent.
export const ManagedSlackAuthorizeResponseSchema = z.union([
  z.object({
    mode: z.literal('managed'),
    status: z.literal('pending'),
    authorize_url: z.string(),
    expires_at: z.string(),
  }),
  ManagedSlackConnectionSchema.refine((value) => value.status === 'active'),
])

export const ManagedSlackDisconnectResponseSchema = z.object({
  ok: z.literal(true),
  status: z.literal('disconnected'),
})

// The pinned effective agent tuple (design 009 §3.5) the session ran with. `runtime`
// is what distinguishes flue from the brain-box runtimes (claude/codex/pi) in read views.
export const AgentSnapshotSchema = z.object({
  runtime: z.string().nullish(),
  model: z.string().nullish(),
  prompt_hash: z.string().nullish(),
  revision: z.union([z.string(), z.number()]).nullish(),
  agent_revision_number: z.number().nullish(),
  digest: z.string().nullish(),
  skill_bundle_digest: z.string().nullish(),
})

const UsageAttributionSchema = z.enum(['exact', 'best_effort'])
const ReportedTurnUsageSchema = z.object({
  reported: z.literal(true),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative().optional(),
  attribution: UsageAttributionSchema.optional(),
})
const UnreportedTurnUsageSchema = z.object({
  reported: z.literal(false),
  attribution: UsageAttributionSchema.optional(),
})
const HistoricalEmptyUsageSchema = z.object({}).strict()
export const TurnUsageSchema = z.union([
  ReportedTurnUsageSchema,
  UnreportedTurnUsageSchema,
  HistoricalEmptyUsageSchema,
])
export const SessionUsageSchema = z.union([
  z.object({
    active_seconds: z.number().int().nonnegative(),
    reported_turns: z.number().int().nonnegative(),
    unreported_turns: z.number().int().nonnegative(),
    complete: z.boolean(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    tokens: z.number().int().nonnegative().optional(),
    total_cost_usd: z.number().nonnegative().optional(),
    attribution: UsageAttributionSchema.optional(),
  }),
  HistoricalEmptyUsageSchema,
])

export const SessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  agent_id: z.string().nullable().optional(),
  agent_snapshot: AgentSnapshotSchema.nullish(),
  credential_id: z.string().nullable().optional(),
  head: z.coerce.number().optional(), // current event seq; API returns it as a string ("0")
  last_turn: record.nullish(),
  usage: SessionUsageSchema.nullish(),
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

export const SessionSourceSchema = z.object({
  name: z.string(),
  status: z.enum([
    'pending',
    'materializing',
    'resolved',
    'failed',
    'unavailable',
    'auth_required',
  ]),
  path: z.string(),
  sha: z.string(),
  resolved_sha: z.string().optional(),
  repo_id: z.string().optional(),
  full_name: z.string().optional(),
  requested_ref: z.string().optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  retryable: z.boolean().optional(),
})
export const SessionSourceListSchema = z.array(SessionSourceSchema)

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
  // Set together when the body spilled to blob storage (body > 32KB): the inline
  // `body` is absent/partial, `content_ref` points at the blob, `body_bytes` is the size.
  content_ref: z.string().nullish(),
  body_truncated: z.boolean().nullish(),
  // PostgreSQL bigint values are serialized as strings by the sessions API.
  // Coerce here so spilled event bodies remain visible in the live timeline.
  body_bytes: z.coerce.number().nullish(),
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
  active_seconds: z.number().nullish(),
  result_event_id: z.string().nullish(),
  usage: TurnUsageSchema.nullish(),
  error: z.unknown().nullish(), // server serializes the error as an opaque object, not a string
})
export const SessionTurnListSchema = z.object({
  data: z.array(TurnSchema),
  next_cursor: z.string().nullish(),
})
// GET /v3/sessions/:id/result → the latest turn + its result event (if any).
export const SessionResultSchema = z.object({
  last_turn: TurnSchema.nullable(),
  result: SessionEventSchema.nullable(),
})

export const AgentHookSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  name: z.string(),
  status: z.enum(['active', 'expired', 'revoked']),
  secret_last4: z.string(),
  revoked_reason: z.enum(['manual', 'secret_exposure']).nullable(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
})
export const AgentHookListSchema = z.object({
  data: z.array(AgentHookSchema),
  next_cursor: z.string().nullable(),
})
export const AgentHookCreateSchema = z.object({
  hook: AgentHookSchema,
  hook_url: z.string(),
})

export const AgentInvokeReceiptSchema = z.object({
  request_id: z.string(),
  session: z.object({
    id: z.string(),
    status: z.string(),
    head: z.coerce.number(),
  }),
  client_token: z.string(),
  links: z.object({ events: z.string(), messages: z.string() }),
  replayed: z.boolean(),
})

export const AgentSecurityNotificationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  hookId: z.string(),
  kind: z.literal('secret_exposure'),
  occurredAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
})
export const AgentSecurityNotificationListSchema = z.object({
  data: z.array(AgentSecurityNotificationSchema),
  next_cursor: z.string().nullable(),
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
export type AgentRevision = z.infer<typeof AgentRevisionSchema>
export type AgentSkills = z.infer<typeof AgentSkillsSchema>
export type SkillItem = z.infer<typeof SkillItemSchema>
export type AgentDeploy = z.infer<typeof AgentDeploySchema>
export type AgentDeployment = z.infer<typeof AgentDeploymentSchema>
export type AgentDeploymentLog = z.infer<typeof AgentDeploymentLogSchema>
export type DeploymentSource = z.infer<typeof DeploymentSourceSchema>
export type DeployApp = z.infer<typeof DeployAppSchema>
export type RepositoryAccessPolicy = z.infer<
  typeof RepositoryAccessPolicySchema
>
export type RepositoryAccessRepository = z.infer<
  typeof RepositoryAccessRepositorySchema
>
export type RepositoryAccess = z.infer<typeof RepositoryAccessSchema>
export type RepositorySourceInspection = z.infer<
  typeof RepositorySourceInspectionSchema
>
export type Credential = z.infer<typeof CredentialSchema>
export type SlackConnection = z.infer<typeof SlackConnectionSchema>
export type SlackManifestResponse = z.infer<typeof SlackManifestResponseSchema>
export type ManagedSlackAuthorizeResponse = z.infer<
  typeof ManagedSlackAuthorizeResponseSchema
>
export type ManagedSlackConnection = z.infer<
  typeof ManagedSlackConnectionSchema
>
export type ManagedSlackWorkspaceConnection = z.infer<
  typeof ManagedSlackWorkspaceConnectionSchema
>
export type ManagedSlackDisconnectResponse = z.infer<
  typeof ManagedSlackDisconnectResponseSchema
>
export type Session = z.infer<typeof SessionSchema>
export type SessionSource = z.infer<typeof SessionSourceSchema>
export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>
export type SessionEvent = z.infer<typeof SessionEventSchema>
export type Turn = z.infer<typeof TurnSchema>
export type SessionResult = z.infer<typeof SessionResultSchema>
export type TurnUsage = z.infer<typeof TurnUsageSchema>
export type SessionUsage = z.infer<typeof SessionUsageSchema>
export type AgentHook = z.infer<typeof AgentHookSchema>
export type AgentHookCreate = z.infer<typeof AgentHookCreateSchema>
export type AgentInvokeReceipt = z.infer<typeof AgentInvokeReceiptSchema>
export type AgentSecurityNotification = z.infer<
  typeof AgentSecurityNotificationSchema
>
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
export type BrowserSession = z.infer<typeof BrowserSessionSchema>
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>
export type SandboxWebhook = z.infer<typeof SandboxWebhookSchema>
export type SandboxWebhookDelivery = z.infer<
  typeof SandboxWebhookDeliverySchema
>
