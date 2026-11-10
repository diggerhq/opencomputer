import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function workspaceModel(
  workspace: string | undefined,
): Promise<string | undefined> {
  if (!workspace) return undefined;
  let source: string;
  try {
    source = await readFile(resolve(workspace, "opencode.json"), "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent opencode.json must contain a JSON object");
  }
  const model = (parsed as Record<string, unknown>).model;
  if (model === undefined) return undefined;
  if (
    typeof model !== "string" ||
    model.length > 512 ||
    model.trim() !== model ||
    !model.includes("/")
  ) {
    throw new Error("Agent opencode.json model must be a provider/model string");
  }
  return model;
}

export function effectiveRuntimeModel(
  configuredModel: string | undefined,
  managedDefaultModel: string,
): string {
  return configuredModel ?? managedDefaultModel;
}
