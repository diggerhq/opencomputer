import { defineTool } from "@flue/runtime";
import type {
  AgentInitializerContext,
  ToolDefinition,
} from "@flue/runtime";
import * as v from "valibot";
import { ocResolveEnv } from "./cf-env.js";
import type { OcEnv } from "./gateway.js";

export interface OcRepoEnv extends OcEnv {
  /** Managed repository API base injected by OpenComputer. */
  OC_REPO_API?: string;
}

const ERROR_CODES = [
  "github_not_connected",
  "github_unavailable",
  "github_permission_missing",
  "repository_scope_empty",
  "repository_not_allowed",
  "repository_not_granted",
  "repository_not_found",
  "repository_rate_limited",
  "source_name_taken",
  "source_limit_reached",
  "source_unresolved",
  "source_materialization_failed",
  "source_not_ready",
  "publish_in_progress",
  "publish_failed",
  "stale_deployment_token",
  "deployment_updating",
  "deployment_unverified",
] as const;

export type OcRepoErrorCode = (typeof ERROR_CODES)[number];

export interface OcRepoError {
  code: OcRepoErrorCode;
  message: string;
  retryable: boolean;
  retry_after_seconds?: number;
}

export type OcRepoFailure = {
  ok: false;
  error: OcRepoError;
};

// Platform responses are forward-extensible: validate and return the known
// semantic fields while ignoring additive fields from a newer server. Tool
// inputs below remain strict and bounded so the model cannot smuggle extra
// authority or unbounded work.
const RepoErrorSchema = v.object({
  code: v.picklist(ERROR_CODES),
  message: v.pipe(v.string(), v.minLength(1)),
  retryable: v.boolean(),
  retry_after_seconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(600)),
  ),
});

const RepoFailureSchema = v.object({
  ok: v.literal(false),
  error: RepoErrorSchema,
});

const WorkingRepositorySchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  full_name: v.pipe(v.string(), v.minLength(3)),
  default_branch: v.pipe(v.string(), v.minLength(1)),
});

export interface WorkingRepository {
  id: string;
  full_name: string;
  default_branch: string;
}

const ListWorkingReposSuccessSchema = v.object({
  ok: v.literal(true),
  repositories: v.array(WorkingRepositorySchema),
  truncated: v.boolean(),
});

const SourceNameSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
);

const RepositoryTargetSchema = v.pipe(
  v.string(),
  v.regex(
    /^(?:repo_[a-z0-9]{24}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100})$/,
  ),
);

const RefSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(255),
  v.check((ref) => ref.trim().length > 0, "ref cannot be blank"),
);

const PullRequestBaseSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/),
  v.check((ref) => !ref.includes(".."), "base cannot contain '..'"),
);

const AddSourceSuccessSchema = v.pipe(
  v.object({
    ok: v.literal(true),
    name: SourceNameSchema,
    repository_id: v.pipe(v.string(), v.startsWith("repo_")),
    full_name: v.pipe(v.string(), v.minLength(3)),
    ref: v.pipe(v.string(), v.minLength(1)),
    sha: v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)),
    path: v.pipe(v.string(), v.startsWith("/workspace/sources/")),
  }),
  v.check(
    (result) => result.path === `/workspace/sources/${result.name}`,
    "source path does not match source name",
  ),
);

const PublishNoChangesSchema = v.object({
  ok: v.literal(true),
  no_changes: v.literal(true),
});

const PublishPullRequestSuccessSchema = v.object({
  ok: v.literal(true),
  no_changes: v.literal(false),
  branch: v.pipe(v.string(), v.minLength(1)),
  commit: v.pipe(
    v.string(),
    v.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
  ),
  pull_request: v.object({
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    url: v.pipe(v.string(), v.url()),
  }),
});

const ListWorkingReposResultSchema = v.union([
  ListWorkingReposSuccessSchema,
  RepoFailureSchema,
]);
const AddSourceResultSchema = v.union([
  AddSourceSuccessSchema,
  RepoFailureSchema,
]);
const PublishPullRequestResultSchema = v.union([
  PublishNoChangesSchema,
  PublishPullRequestSuccessSchema,
  RepoFailureSchema,
]);

export type ListWorkingReposResult =
  | {
      ok: true;
      repositories: WorkingRepository[];
      truncated: boolean;
    }
  | OcRepoFailure;

export type AddSourceResult =
  | {
      ok: true;
      name: string;
      repository_id: string;
      full_name: string;
      ref: string;
      sha: string;
      path: string;
    }
  | OcRepoFailure;

export type PublishPullRequestResult =
  | { ok: true; no_changes: true }
  | {
      ok: true;
      no_changes: false;
      branch: string;
      commit: string;
      pull_request: { number: number; url: string };
    }
  | OcRepoFailure;

const ListWorkingReposInputSchema = v.strictObject({
  q: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(100),
      v.description(
        "Optional case-insensitive owner/repository substring. Use the returned exact id or owner/repository; never guess from a bare name.",
      ),
    ),
  ),
});

const AddSourceInputSchema = v.strictObject({
  repository: v.pipe(
    RepositoryTargetSchema,
    v.description(
      "An exact repo_… id returned by list_working_repos, or exact owner/repository coordinates from that list.",
    ),
  ),
  ref: v.pipe(
    RefSchema,
    v.description("The branch, tag, or commit to pin."),
  ),
  name: v.optional(
    v.pipe(
      SourceNameSchema,
      v.description(
        "Optional stable source name used by later repository operations.",
      ),
    ),
  ),
});

const PublishPullRequestInputSchema = v.strictObject({
  source: v.pipe(
    SourceNameSchema,
    v.description(
      "The source name returned by add_source, not a path or repository guess.",
    ),
  ),
  title: v.pipe(
    v.string(),
    v.maxLength(256),
    v.check((title) => title.trim().length > 0, "title cannot be blank"),
  ),
  body: v.optional(v.pipe(v.string(), v.maxLength(65_536))),
  base: v.pipe(
    PullRequestBaseSchema,
    v.description("Exact target branch for the pull request."),
  ),
  draft: v.optional(v.boolean()),
});

type RepoResultSchema =
  | typeof ListWorkingReposResultSchema
  | typeof AddSourceResultSchema
  | typeof PublishPullRequestResultSchema;

const HTTP_BY_ERROR: Readonly<
  Record<OcRepoErrorCode, readonly number[]>
> = {
  github_not_connected: [409],
  github_unavailable: [503],
  github_permission_missing: [409],
  repository_scope_empty: [403],
  repository_not_allowed: [403],
  repository_not_granted: [403],
  repository_not_found: [404],
  repository_rate_limited: [429],
  source_name_taken: [409],
  source_limit_reached: [409],
  source_unresolved: [422],
  source_materialization_failed: [502, 503],
  source_not_ready: [409],
  publish_in_progress: [409],
  publish_failed: [502, 503],
  stale_deployment_token: [409],
  deployment_updating: [503],
  deployment_unverified: [409],
};

const RETRYABLE_BY_ERROR: Readonly<
  Partial<Record<OcRepoErrorCode, boolean>>
> = {
  github_not_connected: false,
  github_unavailable: true,
  github_permission_missing: false,
  repository_scope_empty: false,
  repository_not_allowed: false,
  repository_not_granted: false,
  repository_not_found: false,
  repository_rate_limited: true,
  source_name_taken: false,
  source_limit_reached: false,
  source_not_ready: true,
  publish_in_progress: true,
  stale_deployment_token: false,
  deployment_updating: true,
  deployment_unverified: false,
};

function invalidResponse(status: number): Error {
  return new Error(
    `[oc-flue] repository API returned an invalid response (status ${status}).`,
  );
}

function validateResult<TSchema extends RepoResultSchema>(
  schema: TSchema,
  status: number,
  payload: unknown,
): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, payload);
  if (!parsed.success) throw invalidResponse(status);

  const result = parsed.output;
  if (result.ok) {
    if (status < 200 || status >= 300) throw invalidResponse(status);
    return result;
  }

  if (!HTTP_BY_ERROR[result.error.code].includes(status)) {
    throw invalidResponse(status);
  }
  const expectedRetryable = RETRYABLE_BY_ERROR[result.error.code];
  if (
    expectedRetryable !== undefined &&
    result.error.retryable !== expectedRetryable
  ) {
    throw invalidResponse(status);
  }
  if (
    result.error.code === "repository_rate_limited" !==
    (result.error.retry_after_seconds !== undefined)
  ) {
    throw invalidResponse(status);
  }
  return result;
}

function endpoint(
  env: OcRepoEnv,
  sessionId: string,
  resource: string,
  query?: URLSearchParams,
): string {
  const base = env.OC_REPO_API?.replace(/\/+$/, "");
  if (!base || !env.OC_SESSION_TOKEN) {
    throw new Error(
      "[oc-flue] ocRepoTools requires managed repository API bindings.",
    );
  }
  const suffix = query && query.size > 0 ? `?${query.toString()}` : "";
  return `${base}/flue/sessions/${encodeURIComponent(sessionId)}/${resource}${suffix}`;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

async function fetchWithOneTransportRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (init.signal?.aborted || isAbortError(error)) {
        throw error;
      }
      if (attempt === 1) {
        throw new Error(
          "[oc-flue] repository API request failed before a response was received.",
        );
      }
    }
  }
  throw new Error("[oc-flue] repository API request failed.");
}

async function request<TSchema extends RepoResultSchema>(
  schema: TSchema,
  env: OcRepoEnv,
  sessionId: string,
  resource: string,
  options: {
    method?: "GET" | "POST";
    query?: URLSearchParams;
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<v.InferOutput<TSchema>> {
  const url = endpoint(env, sessionId, resource, options.query);
  const response = await fetchWithOneTransportRetry(url, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.OC_SESSION_TOKEN}`,
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    signal: options.signal,
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw error;
    throw invalidResponse(response.status);
  }
  return validateResult(schema, response.status, payload);
}

function randomIdempotencyKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  if (bytes.every((byte) => byte === 0)) {
    throw new Error(
      "[oc-flue] secure randomness is unavailable for pull-request publishing.",
    );
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Standard hosted-repository tools for an OpenComputer Flue session.
 *
 * The initializer captures only the session id and the runtime-owned
 * environment reference, not a spread/snapshot. Managed bindings are resolved
 * inside each tool run so request-time secrets on that reference are visible;
 * ambient plain bindings are layered in by `ocResolveEnv`.
 */
export function ocRepoTools(
  ctx: AgentInitializerContext<OcRepoEnv>,
): ToolDefinition[] {
  const sessionId = ctx.id;
  const env = ctx.env;

  const listWorkingRepos = defineTool({
    name: "list_working_repos",
    description:
      "List repositories this agent may use. Call this before repository work. Match the user's exact owner/repository or returned repo_ id; a bare name may be selected only when this list has exactly one match, otherwise ask. Never assume the deployment source is the target. State the resolved owner/repository before adding it.",
    input: ListWorkingReposInputSchema,
    output: ListWorkingReposResultSchema,
    async run({ input, signal }) {
      const query = new URLSearchParams();
      if (input.q !== undefined) query.set("q", input.q);
      return request(
        ListWorkingReposResultSchema,
        ocResolveEnv<OcRepoEnv>(env),
        sessionId,
        "repositories",
        { query, signal },
      );
    },
  });

  const addSource = defineTool({
    name: "add_source",
    description:
      "Pin and materialize one exact repository source after list_working_repos resolved it. Tell the user the exact owner/repository first, await this tool before filesystem work, then use only the returned /workspace/sources/... path. If the session has reached its source limit, reuse an existing source or start a new session. On any product error, explain its stated recovery instead of guessing another target.",
    input: AddSourceInputSchema,
    output: AddSourceResultSchema,
    async run({ input, signal }) {
      return request(
        AddSourceResultSchema,
        ocResolveEnv<OcRepoEnv>(env),
        sessionId,
        "sources",
        { method: "POST", body: input, signal },
      );
    },
  });

  const publishPullRequest = defineTool({
    name: "github_publish_pull_request",
    description:
      "Publish the inspected changes from one added source as an OpenComputer-authored GitHub pull request. First inspect and test the diff, then restate the exact repository, base branch, and intended diff. Report the returned pull-request URL; if there are no changes or a product error, report that result and its recovery exactly.",
    input: PublishPullRequestInputSchema,
    output: PublishPullRequestResultSchema,
    async run({ input, signal }) {
      const idempotencyKey = randomIdempotencyKey();
      return request(
        PublishPullRequestResultSchema,
        ocResolveEnv<OcRepoEnv>(env),
        sessionId,
        "pull-requests",
        {
          method: "POST",
          body: { ...input, idempotency_key: idempotencyKey },
          signal,
        },
      );
    },
  });

  return [listWorkingRepos, addSource, publishPullRequest];
}
