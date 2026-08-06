import { z } from "zod";

export { z as schema };

export type OperationExecution = "broker" | "hybrid";

export type OperationEffect =
  | "external.read"
  | "external.write"
  | "external.send"
  | "workspace.create";

export interface OperationArtifactReference {
  id: string;
  mediaType: string;
  size: number;
  sha256: string;
  expiresAt?: string;
}

export interface OperationConnection {
  kind: string;
  alias?: string;
}

export interface OperationContext {
  readonly connection?: OperationConnection;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  artifact(input: {
    body: Uint8Array;
    mediaType: string;
  }): Promise<OperationArtifactReference>;
}

export interface OperationLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxArtifactBytes?: number;
}

export interface OperationDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  description: string;
  input: TInput;
  output: TOutput;
  execution: OperationExecution;
  effects: readonly OperationEffect[];
  connection?: string;
  network?: readonly string[];
  limits?: OperationLimits;
  workspaceAdapter?: "git.checkout";
  execute(
    input: z.output<TInput>,
    context: OperationContext,
  ): Promise<z.input<TOutput> | z.output<TOutput>>;
}

export interface PluginDefinition {
  name: string;
  packageName: string;
  displayName: string;
  description: string;
  operations: Record<string, OperationDefinition>;
  skills?: string;
}

export interface PluginSet {
  readonly kind: "opencomputer.plugins";
  readonly plugins: readonly PluginDefinition[];
}

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;
const OPERATION_NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;

export function defineOperation<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  operation: OperationDefinition<TInput, TOutput>,
): OperationDefinition<TInput, TOutput> {
  if (!operation.description.trim()) {
    throw new Error("Operation descriptions cannot be empty");
  }
  if (!operation.effects.length) {
    throw new Error("Operations must declare at least one effect");
  }
  if (operation.execution === "hybrid" && !operation.effects.includes("workspace.create")) {
    throw new Error("Hybrid operations must declare workspace.create");
  }
  if (operation.execution === "hybrid" && !operation.workspaceAdapter) {
    throw new Error("Hybrid operations must declare a trusted workspace adapter");
  }
  for (const origin of operation.network ?? []) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`Operation network origin must be an HTTPS origin: ${origin}`);
    }
  }
  return operation;
}

export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  if (!PLUGIN_NAME.test(plugin.name)) {
    throw new Error(`Invalid plugin name: ${plugin.name}`);
  }
  if (!plugin.packageName.trim()) {
    throw new Error(`Plugin ${plugin.name} must declare packageName`);
  }
  if (!plugin.displayName.trim() || !plugin.description.trim()) {
    throw new Error(`Plugin ${plugin.name} must declare displayName and description`);
  }
  if (!Object.keys(plugin.operations).length) {
    throw new Error(`Plugin ${plugin.name} must provide at least one operation`);
  }
  for (const name of Object.keys(plugin.operations)) {
    if (!OPERATION_NAME.test(name)) {
      throw new Error(`Invalid operation name in plugin ${plugin.name}: ${name}`);
    }
  }
  return plugin;
}

export function definePlugins(
  plugins: readonly PluginDefinition[],
): PluginSet {
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (names.has(plugin.name)) {
      throw new Error(`Duplicate plugin name: ${plugin.name}`);
    }
    names.add(plugin.name);
  }
  return { kind: "opencomputer.plugins", plugins };
}
