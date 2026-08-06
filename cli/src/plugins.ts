import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";
import { z } from "zod";

import type {
  OperationContext,
  OperationDefinition,
  OperationEffect,
  OperationExecution,
  PluginDefinition,
  PluginSet,
} from "./plugin.js";

export interface OperationCatalogEntry {
  id: string;
  plugin: string;
  packageName: string;
  packageVersion: string;
  packageDigest: string;
  description: string;
  execution: OperationExecution;
  effects: OperationEffect[];
  connection?: string;
  network: string[];
  workspaceAdapter?: "git.checkout";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface LoadedOperationCatalog {
  plugins: Array<{
    name: string;
    displayName: string;
    description: string;
    packageName: string;
    packageVersion: string;
    packageDigest: string;
  }>;
  operations: OperationCatalogEntry[];
  definitions: Map<string, OperationDefinition>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function packageRoot(root: string, packageName: string): Promise<string> {
  const require = createRequire(resolve(root, "package.json"));
  let entry: string;
  try {
    entry = require.resolve(packageName);
  } catch {
    throw new Error(
      `Plugin package ${packageName} is not installed. Install dependencies before checking or deploying.`,
    );
  }
  let directory = dirname(entry);
  for (;;) {
    const packageJSON = resolve(directory, "package.json");
    if (await exists(packageJSON)) {
      const parsed = JSON.parse(await readFile(packageJSON, "utf8")) as {
        name?: unknown;
      };
      if (parsed.name === packageName) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not locate package.json for plugin ${packageName}`);
}

async function digestDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = resolve(directory, entry.name);
      const name = relative(root, path).split("\\").join("/");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash.update(name);
        hash.update("\0");
        hash.update(await readFile(path));
        hash.update("\0");
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function importPluginSet(root: string): Promise<PluginSet | undefined> {
  const sourcePath = resolve(root, "opencomputer.plugins.ts");
  if (!(await exists(sourcePath))) return undefined;
  const source = await readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length) {
    throw new Error(
      `Invalid opencomputer.plugins.ts: ${errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("; ")}`,
    );
  }
  const cache = resolve(root, ".opencomputer", "plugins");
  await mkdir(cache, { recursive: true });
  const compiledPath = resolve(cache, "opencomputer.plugins.mjs");
  await writeFile(compiledPath, transpiled.outputText);
  const module = (await import(
    `${pathToFileURL(compiledPath).href}?v=${Date.now().toString()}`
  )) as { default?: unknown };
  const value = module.default;
  if (
    !value ||
    typeof value !== "object" ||
    (value as { kind?: unknown }).kind !== "opencomputer.plugins" ||
    !Array.isArray((value as { plugins?: unknown }).plugins)
  ) {
    throw new Error("opencomputer.plugins.ts must default-export definePlugins([...])");
  }
  return value as PluginSet;
}

export async function loadOperationCatalog(
  root: string,
): Promise<LoadedOperationCatalog> {
  const set = await importPluginSet(root);
  const result: LoadedOperationCatalog = {
    plugins: [],
    operations: [],
    definitions: new Map(),
  };
  if (!set) {
    const generated = resolve(root, ".opencomputer", "operations", "catalog.json");
    if (!(await exists(generated))) return result;
    const parsed = JSON.parse(await readFile(generated, "utf8")) as {
      plugins?: LoadedOperationCatalog["plugins"];
      operations?: OperationCatalogEntry[];
    };
    return {
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
      operations: Array.isArray(parsed.operations) ? parsed.operations : [],
      definitions: new Map(),
    };
  }
  const operationIds = new Set<string>();
  for (const plugin of set.plugins) {
    const directory = await packageRoot(root, plugin.packageName);
    const packageJSON = JSON.parse(
      await readFile(resolve(directory, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (packageJSON.name !== plugin.packageName || typeof packageJSON.version !== "string") {
      throw new Error(`Plugin ${plugin.name} has mismatched npm package identity`);
    }
    const packageDigest = await digestDirectory(directory);
    result.plugins.push({
      name: plugin.name,
      displayName: plugin.displayName,
      description: plugin.description,
      packageName: plugin.packageName,
      packageVersion: packageJSON.version,
      packageDigest,
    });
    for (const [name, definition] of Object.entries(plugin.operations)) {
      const id = `${plugin.name}.${name}`;
      if (operationIds.has(id)) throw new Error(`Duplicate operation id: ${id}`);
      operationIds.add(id);
      result.operations.push({
        id,
        plugin: plugin.name,
        packageName: plugin.packageName,
        packageVersion: packageJSON.version,
        packageDigest,
        description: definition.description,
        execution: definition.execution,
        effects: [...definition.effects],
        ...(definition.connection ? { connection: definition.connection } : {}),
        network: [...(definition.network ?? [])],
        ...(definition.workspaceAdapter
          ? { workspaceAdapter: definition.workspaceAdapter }
          : {}),
        inputSchema: z.toJSONSchema(definition.input) as Record<string, unknown>,
        outputSchema: z.toJSONSchema(definition.output) as Record<string, unknown>,
      });
      result.definitions.set(id, definition);
    }
  }
  result.plugins.sort((left, right) => left.name.localeCompare(right.name));
  result.operations.sort((left, right) => left.id.localeCompare(right.id));
  return result;
}

export async function findOperationRoot(
  start = process.cwd(),
): Promise<string | undefined> {
  let directory = resolve(start);
  for (;;) {
    if (
      (await exists(resolve(directory, "opencomputer.plugins.ts"))) ||
      (await exists(resolve(directory, ".opencomputer", "operations", "catalog.json")))
    ) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function writeOperationCatalog(
  runtime: string,
  catalog: LoadedOperationCatalog,
): Promise<void> {
  const root = resolve(runtime, ".opencomputer", "operations");
  await mkdir(root, { recursive: true });
  await writeFile(
    resolve(root, "catalog.json"),
    `${JSON.stringify({ version: 1, plugins: catalog.plugins, operations: catalog.operations }, null, 2)}\n`,
  );
  for (const operation of catalog.operations) {
    const directory = resolve(root, operation.id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "README.md"),
      `# ${operation.id}\n\n${operation.description}\n\n- Execution: ${operation.execution}\n- Effects: ${operation.effects.join(", ")}\n- Connection: ${operation.connection ?? "none"}\n`,
    );
    await writeFile(
      resolve(directory, "input.schema.json"),
      `${JSON.stringify(operation.inputSchema, null, 2)}\n`,
    );
    await writeFile(
      resolve(directory, "output.schema.json"),
      `${JSON.stringify(operation.outputSchema, null, 2)}\n`,
    );
  }
}

export async function testOperation(
  catalog: LoadedOperationCatalog,
  id: string,
  input: unknown,
  context: OperationContext,
): Promise<unknown> {
  const definition = catalog.definitions.get(id);
  if (!definition) throw new Error(`Operation ${id} is not enabled`);
  const parsedInput = definition.input.parse(input);
  const guardedContext: OperationContext = {
    ...context,
    async artifact(value) {
      const maximum = definition.limits?.maxArtifactBytes;
      if (maximum !== undefined && value.body.byteLength > maximum) {
        throw new Error(`Operation ${id} artifact exceeds ${maximum} bytes`);
      }
      return context.artifact(value);
    },
  };
  const result = definition.output.parse(
    await definition.execute(parsedInput, guardedContext),
  );
  const maximum = definition.limits?.maxOutputBytes;
  if (maximum !== undefined && Buffer.byteLength(JSON.stringify(result)) > maximum) {
    throw new Error(`Operation ${id} output exceeds ${maximum} bytes`);
  }
  return result;
}

export function pluginForOperation(
  plugins: readonly PluginDefinition[],
  id: string,
): PluginDefinition | undefined {
  return plugins.find((plugin) => id.startsWith(`${plugin.name}.`));
}
