import type {
  ProjectEnvironmentMode,
  ProjectEnvironmentName,
} from "../protocol.js";

/**
 * The one place that turns a caller's environment choice into the canonical
 * scope key of a project. Every environment-scoped operation (secrets,
 * variables, tokens, model access, connections, channels, schedules, webhooks,
 * memory, logs, deployment aliases and session admission) goes through here
 * so that no route selects its own fallback or casts a string to a scope.
 *
 * Legacy projects keep Development and Production exactly as before. A
 * single-mode project has one scope, `default`; the older CLI's Development
 * default is translated onto it because the caller's intent is unambiguous,
 * while an explicit Production request is refused so two values an old caller
 * believes are isolated can never overwrite the same record.
 */

export const ENVIRONMENT_MODES: readonly ProjectEnvironmentMode[] = ["single", "legacy"];

/** Mode every project row predating the `environment_mode` column carries. */
export const LEGACY_ENVIRONMENT_MODE: ProjectEnvironmentMode = "legacy";

/** Mode newly created projects receive when the caller does not choose. */
export const DEFAULT_NEW_PROJECT_ENVIRONMENT_MODE: ProjectEnvironmentMode = "single";

/** Canonical scope key of a single-mode project. */
export const SINGLE_ENVIRONMENT: ProjectEnvironmentName = "default";

export const LEGACY_ENVIRONMENTS: readonly ProjectEnvironmentName[] = [
  "development",
  "production",
];

/**
 * First published CLI whose single-mode commands carry no environment or
 * alias choice. Named in the typed rejection so an older caller knows what to
 * upgrade to; it is guidance, not a version check the backend enforces.
 */
export const SINGLE_ENVIRONMENT_MIN_CLI_VERSION = "0.7.17";

export interface ResolvedProjectScope {
  projectId: string;
  mode: ProjectEnvironmentMode;
  environment: ProjectEnvironmentName;
  /**
   * Present when an older caller's Development default was translated onto a
   * single-mode project's canonical scope. Kept for audit and telemetry;
   * storage and authorization never see it.
   */
  compatibility?: "legacy-development-default";
}

export interface ProjectScopeError {
  status: 400 | 409;
  code: "invalid_environment" | "single_environment_project";
  message: string;
}

export type ProjectScopeResolution =
  | { ok: true; scope: ResolvedProjectScope }
  | { ok: false; error: ProjectScopeError };

export interface ResolveProjectScopeOptions {
  /**
   * A legacy project with no stated environment: `development` mirrors the
   * long-standing default of most routes; `required` refuses the request for
   * routes whose existing contract demands an explicit choice. Single-mode
   * projects resolve `default` either way.
   */
  legacyDefault?: "development" | "required";
}

export function isProjectEnvironmentMode(
  value: unknown,
): value is ProjectEnvironmentMode {
  return value === "single" || value === "legacy";
}

export function isProjectEnvironmentName(
  value: unknown,
): value is ProjectEnvironmentName {
  return value === "default" || value === "development" || value === "production";
}

/** Reads a stored mode. Rows predating the column normalize to legacy; anything else fails closed. */
export function environmentModeFromStorage(
  value: string | null | undefined,
): ProjectEnvironmentMode {
  if (value === null || value === undefined || value === "") {
    return LEGACY_ENVIRONMENT_MODE;
  }
  if (isProjectEnvironmentMode(value)) return value;
  throw new Error(`Project has an unknown environment mode: ${value}`);
}

/**
 * The alias as a scope the project of this mode holds rows under, or
 * undefined: a legacy project publishing under `default`, like one publishing
 * under `preview`, names a deployment alias and not an environment.
 */
export function environmentOfMode(
  mode: ProjectEnvironmentMode,
  alias: unknown,
): ProjectEnvironmentName | undefined {
  return isProjectEnvironmentName(alias) && canonicalEnvironments(mode).includes(alias)
    ? alias
    : undefined;
}

/** The canonical scope keys a project of this mode may hold rows under. */
export function canonicalEnvironments(
  mode: ProjectEnvironmentMode,
): readonly ProjectEnvironmentName[] {
  return mode === "single" ? [SINGLE_ENVIRONMENT] : LEGACY_ENVIRONMENTS;
}

function requestedName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolves what a caller asked for against the project's mode.
 *
 * `requested` is the raw wire value (query parameter, body field, or the
 * alias part of `agent@alias`); undefined, null and empty strings mean the
 * caller stated nothing.
 */
export function resolveProjectScope(
  project: { id: string; environmentMode: ProjectEnvironmentMode },
  requested: unknown,
  options: ResolveProjectScopeOptions = {},
): ProjectScopeResolution {
  const name = requestedName(requested);
  const base = { projectId: project.id, mode: project.environmentMode } as const;

  if (project.environmentMode === "single") {
    if (name === undefined || name === SINGLE_ENVIRONMENT) {
      return { ok: true, scope: { ...base, environment: SINGLE_ENVIRONMENT } };
    }
    if (name === "development") {
      return {
        ok: true,
        scope: {
          ...base,
          environment: SINGLE_ENVIRONMENT,
          compatibility: "legacy-development-default",
        },
      };
    }
    if (name === "production") {
      return {
        ok: false,
        error: {
          status: 409,
          code: "single_environment_project",
          message:
            "This project has one current deployment and no separate production environment. " +
            `Omit the environment, or upgrade to opencomputer CLI ${SINGLE_ENVIRONMENT_MIN_CLI_VERSION} or later, ` +
            "whose commands no longer ask for one. Use a separate project for an isolated production target.",
        },
      };
    }
    return {
      ok: false,
      error: {
        status: 400,
        code: "invalid_environment",
        message: `Unknown environment "${name}"; this project has one current deployment`,
      },
    };
  }

  if (name === undefined) {
    if (options.legacyDefault === "required") {
      return {
        ok: false,
        error: {
          status: 400,
          code: "invalid_environment",
          message: "Expected an explicit development or production environment",
        },
      };
    }
    return { ok: true, scope: { ...base, environment: "development" } };
  }
  if (name === "development" || name === "production") {
    return { ok: true, scope: { ...base, environment: name } };
  }
  return {
    ok: false,
    error: {
      status: 400,
      code: "invalid_environment",
      message: `Expected development or production, not "${name}"`,
    },
  };
}

/**
 * The wire alias a legacy-shaped caller may use for a single-mode project's
 * one scope during the compatibility window. Translating a stored canonical
 * key back for a response never happens: responses carry the canonical name.
 */
export function acceptsAlias(
  mode: ProjectEnvironmentMode,
  alias: string,
): boolean {
  return resolveProjectScope({ id: "", environmentMode: mode }, alias).ok;
}
