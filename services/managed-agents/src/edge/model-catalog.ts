import type { ResolvedModel } from "../runtime/reactive-agent.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_MODEL_CATALOG_CACHE_KEY =
  "https://model-catalog.opencomputer.invalid/openrouter/v1";
const FRESH_MS = 5 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;
// A runtime's "context" hook waits on this catalog before every response and
// OpenCode fails the turn after five minutes; an unbounded fetch to OpenRouter
// was seen to take four (work 078). A fetch that exceeds the bound falls back
// to the stale snapshot like any other failure.
export const CATALOG_FETCH_TIMEOUT_MS = 15_000;

export const DEFAULT_MANAGED_MODEL: ResolvedModel = {
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.6",
};

export class ModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelValidationError";
  }
}

export class ModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCatalogError";
  }
}

interface CatalogSnapshot {
  fetchedAt: number;
  ids: string[];
}

export interface ModelCatalogOptions {
  cache?: Cache;
  fetch?: typeof fetch;
  now?: () => number;
}

function parseSnapshot(value: unknown): CatalogSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { fetchedAt?: unknown; ids?: unknown };
  if (
    typeof candidate.fetchedAt !== "number" ||
    !Array.isArray(candidate.ids) ||
    !candidate.ids.every((id) => typeof id === "string" && id.length > 0)
  ) {
    return undefined;
  }
  return { fetchedAt: candidate.fetchedAt, ids: candidate.ids };
}

async function cachedSnapshot(cache?: Cache): Promise<CatalogSnapshot | undefined> {
  if (!cache) return undefined;
  const response = await cache.match(OPENROUTER_MODEL_CATALOG_CACHE_KEY);
  if (!response) return undefined;
  return parseSnapshot(await response.json().catch(() => undefined));
}

async function fetchSnapshot(
  fetcher: typeof fetch,
  fetchedAt: number,
): Promise<CatalogSnapshot> {
  const response = await fetcher(OPENROUTER_MODELS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ModelCatalogError(
      `OpenRouter model catalog returned ${response.status}`,
    );
  }
  const body = (await response.json()) as unknown;
  const data =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(data)) {
    throw new ModelCatalogError("OpenRouter model catalog is malformed");
  }
  const ids = data
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!ids.length) {
    throw new ModelCatalogError("OpenRouter model catalog contains no models");
  }
  return { fetchedAt, ids: [...new Set(ids)].sort() };
}

export async function openRouterModelCatalog(
  options: ModelCatalogOptions = {},
): Promise<ReadonlySet<string>> {
  const now = (options.now ?? Date.now)();
  const cached = await cachedSnapshot(options.cache);
  if (cached && now - cached.fetchedAt <= FRESH_MS) {
    return new Set(cached.ids);
  }
  try {
    const snapshot = await fetchSnapshot(options.fetch ?? fetch, now);
    if (options.cache) {
      await options.cache.put(
        OPENROUTER_MODEL_CATALOG_CACHE_KEY,
        new Response(JSON.stringify(snapshot), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${STALE_MS / 1000}`,
          },
        }),
      );
    }
    return new Set(snapshot.ids);
  } catch (error) {
    if (cached && now - cached.fetchedAt <= STALE_MS) {
      return new Set(cached.ids);
    }
    throw error;
  }
}

export function parseManagedModel(value?: string): ResolvedModel {
  const configured = value?.trim();
  if (!configured) return DEFAULT_MANAGED_MODEL;
  const separator = configured.indexOf("/");
  if (separator <= 0 || separator === configured.length - 1) {
    throw new ModelValidationError(
      "BLUE_DEFAULT_MODEL must use provider/model format",
    );
  }
  return {
    provider: configured.slice(0, separator),
    model: configured.slice(separator + 1),
  };
}

export function openRouterCatalogId(model: ResolvedModel): string {
  if (model.provider === "openrouter") return model.model;
  if (model.provider === "openai" || model.provider === "anthropic") {
    return `${model.provider}/${model.model}`;
  }
  throw new ModelValidationError(
    `Unsupported model provider ${JSON.stringify(model.provider)}`,
  );
}

export function validateModels(
  models: readonly ResolvedModel[],
  catalog: ReadonlySet<string>,
): void {
  for (const model of models) {
    if (!model.provider.trim() || !model.model.trim()) {
      throw new ModelValidationError("Model provider and id must be non-empty");
    }
    const id = openRouterCatalogId(model);
    if (!catalog.has(id)) {
      throw new ModelValidationError(
        `Model ${JSON.stringify(`${model.provider}/${model.model}`)} is not available in the OpenRouter catalog`,
      );
    }
  }
}

export function sameModel(left: ResolvedModel, right: ResolvedModel): boolean {
  return left.provider === right.provider && left.model === right.model;
}

/** Protocol adapters may rename a direct provider as `openrouter`; compare the exact upstream id. */
export function deploymentAllowsGatewayModel(
  allowed: readonly ResolvedModel[],
  requested: ResolvedModel,
): boolean {
  const requestedId = openRouterCatalogId(requested);
  return allowed.some((candidate) => openRouterCatalogId(candidate) === requestedId);
}
