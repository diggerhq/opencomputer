import type { ManagedProject } from "./api.js";

export function projectEnvironmentMode(
  project: ManagedProject,
): "single" | "legacy" {
  return project.environmentMode ?? "legacy";
}

export function deploymentAliasForProject(
  project: ManagedProject,
  requestedAlias?: string,
): "default" | "development" | "production" {
  if (projectEnvironmentMode(project) === "single") {
    if (requestedAlias !== undefined) {
      throw new Error(
        "This project has one current deployment; omit --alias when deploying.",
      );
    }
    return "default";
  }
  if (!requestedAlias || requestedAlias === "development") return "development";
  if (requestedAlias === "production") return "production";
  throw new Error("--alias must be development or production");
}
