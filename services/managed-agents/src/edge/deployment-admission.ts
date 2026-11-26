import type { ResolvedModel } from "../runtime/reactive-agent.js";
import {
  openRouterModelCatalog,
  parseManagedModel,
  sameModel,
  validateModels,
  type ModelCatalogOptions,
} from "./model-catalog.js";

/** Deployment admission shared by `POST /v1/deployments` and template installation. */

export interface DeploymentAdmissionEnv {
  BLUE_DEFAULT_MODEL?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `undefined` when absent, `null` when malformed, otherwise sorted and de-duplicated. */
export function parseModelSelections(
  value: unknown,
): ResolvedModel[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) return null;
  const result: ResolvedModel[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.provider !== "string" ||
      typeof entry.model !== "string" ||
      !entry.provider.trim() ||
      !entry.model.trim() ||
      entry.provider.length > 64 ||
      entry.model.length > 256
    ) {
      return null;
    }
    const selection = { provider: entry.provider, model: entry.model };
    if (!result.some((candidate) => sameModel(candidate, selection))) {
      result.push(selection);
    }
  }
  return result.sort((left, right) =>
    `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`),
  );
}

export function defaultCatalogOptions(): ModelCatalogOptions {
  return { cache: typeof caches === "undefined" ? undefined : caches.default };
}

/** Validates the declared models and the platform default against one catalog fetch; returns the default. */
export async function admitDeploymentModels(
  models: readonly ResolvedModel[],
  env: DeploymentAdmissionEnv,
  options: ModelCatalogOptions = defaultCatalogOptions(),
): Promise<ResolvedModel> {
  const defaultModel = parseManagedModel(env.BLUE_DEFAULT_MODEL);
  const catalog = await openRouterModelCatalog(options);
  validateModels([...models, defaultModel], catalog);
  return defaultModel;
}
