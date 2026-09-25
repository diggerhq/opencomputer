import type { ProjectEnvironment, ProjectEnvironmentMode } from "./api.js";
import { CLIError } from "./errors.js";

/**
 * How a command names an environment for the project it acts on. A legacy
 * project keeps Development and Production and its flags choose between them;
 * a single-mode project has one scope, `default`, and the flags that would
 * pick another are refused locally with the same typed error the API uses.
 */

export const SINGLE_ENVIRONMENT: ProjectEnvironment = "default";

export const LEGACY_ENVIRONMENTS: readonly ProjectEnvironment[] = [
  "development",
  "production",
];

export function projectEnvironments(
  mode: ProjectEnvironmentMode,
): readonly ProjectEnvironment[] {
  return mode === "single" ? [SINGLE_ENVIRONMENT] : LEGACY_ENVIRONMENTS;
}

/** Where `deploy --watch` and CLI sessions land: the working scope of the project. */
export function workingEnvironment(
  mode: ProjectEnvironmentMode,
): ProjectEnvironment {
  return mode === "single" ? SINGLE_ENVIRONMENT : "development";
}

export function singleEnvironmentError(flag: string): CLIError {
  return new CLIError(
    "single_environment_project",
    `${flag} does not apply: this project has a single environment.`,
    `Omit ${flag}. Use a separate project for a distinct development or production target.`,
  );
}

function legacyEnvironment(
  value: string | undefined,
  flag: string,
  fallback: ProjectEnvironment,
): ProjectEnvironment {
  if (!value) return fallback;
  if (value === "development" || value === "production") return value;
  throw new Error(`${flag} must be development or production`);
}

/**
 * The environment a command acts on. Single-mode projects resolve to
 * `default` and refuse any explicit value, including `development`: the CLI
 * knows the project's mode, so unlike an older CLI it has no reason to say it.
 */
export function resolveEnvironment(
  mode: ProjectEnvironmentMode,
  value: string | undefined,
  flag = "--environment",
): ProjectEnvironment {
  if (mode === "single") {
    if (value !== undefined) throw singleEnvironmentError(flag);
    return SINGLE_ENVIRONMENT;
  }
  return legacyEnvironment(value, flag, "development");
}

/** Like `resolveEnvironment`, but a legacy project without a flag means no filter. */
export function resolveEnvironmentFilter(
  mode: ProjectEnvironmentMode,
  value: string | undefined,
  flag = "--environment",
): ProjectEnvironment | undefined {
  if (mode === "single") {
    if (value !== undefined) throw singleEnvironmentError(flag);
    return SINGLE_ENVIRONMENT;
  }
  return value ? legacyEnvironment(value, flag, "development") : undefined;
}

/** The alias a plain `deploy` publishes: `default` for single-mode, `--alias` or Development for legacy. */
export function resolveDeployAlias(
  mode: ProjectEnvironmentMode,
  requestedAlias: string | undefined,
): string {
  if (mode === "single") {
    if (requestedAlias !== undefined) throw singleEnvironmentError("--alias");
    return SINGLE_ENVIRONMENT;
  }
  return requestedAlias ?? "development";
}

/** The user-facing name of a scope; empty for the single scope, which is not spoken of. */
export function environmentLabel(environment: ProjectEnvironment): string {
  return environment === "development"
    ? "Development"
    : environment === "production"
      ? "Production"
      : "";
}
