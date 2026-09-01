import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const TEMPLATE_FILE = "oc-template.toml";
const MAX_TEMPLATE_BYTES = 64 * 1024;
const PROJECT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIREMENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export interface TemplateRequirementAnnotation {
  description?: string;
  documentation?: string;
}

export interface TemplateRuntimeVariable extends TemplateRequirementAnnotation {
  required?: boolean;
  example?: string;
}

export interface TemplateManifest {
  schema: 1;
  template: {
    name: string;
    description: string;
    documentation?: string;
    defaultProjectName?: string;
    firstRun?: { agent: string; prompt: string };
    secrets: Record<string, TemplateRequirementAnnotation>;
    runtimeVariables: Record<string, TemplateRuntimeVariable>;
    connections: Record<string, TemplateRequirementAnnotation>;
  };
}

type Scalar = string | boolean | number;

function fail(message: string, line?: number): never {
  throw new Error(`${TEMPLATE_FILE}${line ? `:${line}` : ""}: ${message}`);
}

function parseString(value: string, line: number): string {
  if (!value.startsWith('"')) fail("values must be strings or booleans", line);
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string") fail("expected a string", line);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(TEMPLATE_FILE)) {
      throw error;
    }
    return fail("invalid quoted string", line);
  }
}

function parseScalar(value: string, line: number): Scalar {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[0-9]+$/.test(value)) return Number(value);
  return parseString(value, line);
}

function parseFlatToml(
  source: string,
): Map<string, { value: Scalar; line: number }> {
  const values = new Map<string, { value: Scalar; line: number }>();
  const sections = new Set<string>();
  let section = "";
  for (const [index, original] of source.split(/\r?\n/).entries()) {
    const line = index + 1;
    const trimmed = original.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      if (!section) fail("empty table name", line);
      const dynamicSection = section.match(
        /^template\.(secrets|runtime_variables|connections)\.([A-Za-z][A-Za-z0-9_]{0,127})$/,
      );
      if (
        section !== "template" &&
        section !== "template.first_run" &&
        !dynamicSection
      ) {
        fail(`unknown table ${section}`, line);
      }
      if (sections.has(section)) fail(`duplicate table ${section}`, line);
      sections.add(section);
      continue;
    }
    const assignment = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) fail("unsupported TOML syntax", line);
    const key = section ? `${section}.${assignment[1]}` : assignment[1]!;
    if (values.has(key)) fail(`duplicate field ${key}`, line);
    values.set(key, { value: parseScalar(assignment[2]!.trim(), line), line });
  }
  return values;
}

function stringField(
  values: Map<string, { value: Scalar; line: number }>,
  key: string,
  required = false,
): string | undefined {
  const entry = values.get(key);
  if (!entry) {
    if (required) fail(`missing required field ${key}`);
    return undefined;
  }
  if (typeof entry.value !== "string" || !entry.value.trim()) {
    fail(`${key} must be a non-empty string`, entry.line);
  }
  return entry.value;
}

function httpsField(
  values: Map<string, { value: Scalar; line: number }>,
  key: string,
): string | undefined {
  const value = stringField(values, key);
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(`${key} must be an HTTPS URL`, values.get(key)?.line);
  }
  if (parsed.protocol !== "https:") {
    fail(`${key} must be an HTTPS URL`, values.get(key)?.line);
  }
  return value;
}

function annotations(
  values: Map<string, { value: Scalar; line: number }>,
  prefix: string,
  runtimeVariable: boolean,
): Record<string, TemplateRuntimeVariable> {
  const result: Record<string, TemplateRuntimeVariable> = {};
  for (const [key, entry] of values) {
    if (!key.startsWith(`${prefix}.`)) continue;
    const remainder = key.slice(prefix.length + 1);
    const separator = remainder.lastIndexOf(".");
    if (separator < 1) fail(`invalid requirement field ${key}`, entry.line);
    const name = remainder.slice(0, separator);
    const field = remainder.slice(separator + 1);
    if (!REQUIREMENT_NAME_PATTERN.test(name)) {
      fail(`invalid requirement name ${name}`, entry.line);
    }
    const allowed = runtimeVariable
      ? ["description", "documentation", "required", "example"]
      : ["description", "documentation"];
    if (!allowed.includes(field)) fail(`unknown field ${key}`, entry.line);
    const target = (result[name] ??= {});
    if (field === "required") {
      if (typeof entry.value !== "boolean") {
        fail(`${key} must be a boolean`, entry.line);
      }
      target.required = entry.value;
    } else {
      if (typeof entry.value !== "string" || !entry.value.trim()) {
        fail(`${key} must be a non-empty string`, entry.line);
      }
      if (field === "documentation") {
        httpsField(values, key);
      }
      target[field as "description" | "documentation" | "example"] =
        entry.value;
    }
  }
  return result;
}

export function parseTemplateManifest(source: string): TemplateManifest {
  if (Buffer.byteLength(source, "utf8") > MAX_TEMPLATE_BYTES) {
    fail(`file exceeds ${MAX_TEMPLATE_BYTES} bytes`);
  }
  const values = parseFlatToml(source);
  const knownExact = new Set([
    "schema",
    "template.name",
    "template.description",
    "template.documentation",
    "template.default_project_name",
    "template.first_run.agent",
    "template.first_run.prompt",
  ]);
  const knownPrefixes = [
    "template.secrets.",
    "template.runtime_variables.",
    "template.connections.",
  ];
  for (const [key, entry] of values) {
    if (
      !knownExact.has(key) &&
      !knownPrefixes.some((prefix) => key.startsWith(prefix))
    ) {
      fail(`unknown field ${key}`, entry.line);
    }
  }
  const schema = values.get("schema");
  if (schema?.value !== 1) fail("schema must be 1", schema?.line);
  const name = stringField(values, "template.name", true)!;
  const description = stringField(values, "template.description", true)!;
  const documentation = httpsField(values, "template.documentation");
  const defaultProjectName = stringField(
    values,
    "template.default_project_name",
  );
  if (defaultProjectName && !PROJECT_NAME_PATTERN.test(defaultProjectName)) {
    fail(
      "template.default_project_name must use lowercase letters, numbers, and single hyphens",
      values.get("template.default_project_name")?.line,
    );
  }
  const firstRunAgent = stringField(values, "template.first_run.agent");
  const firstRunPrompt = stringField(values, "template.first_run.prompt");
  if (Boolean(firstRunAgent) !== Boolean(firstRunPrompt)) {
    fail(
      "template.first_run.agent and template.first_run.prompt must be provided together",
    );
  }
  return {
    schema: 1,
    template: {
      name,
      description,
      ...(documentation ? { documentation } : {}),
      ...(defaultProjectName ? { defaultProjectName } : {}),
      ...(firstRunAgent && firstRunPrompt
        ? { firstRun: { agent: firstRunAgent, prompt: firstRunPrompt } }
        : {}),
      secrets: annotations(values, "template.secrets", false),
      runtimeVariables: annotations(values, "template.runtime_variables", true),
      connections: annotations(values, "template.connections", false),
    },
  };
}

export async function readTemplateManifest(
  root = process.cwd(),
): Promise<TemplateManifest> {
  const path = resolve(root, TEMPLATE_FILE);
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile()) fail(`expected a regular file at ${path}`);
  if (metadata.size > MAX_TEMPLATE_BYTES)
    fail(`file exceeds ${MAX_TEMPLATE_BYTES} bytes`);
  return parseTemplateManifest(await readFile(path, "utf8"));
}

export function normalizeTemplateRepositoryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Repository URL must be https://github.com/<owner>/<repository>",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    parts.length !== 2 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0]!) ||
    !/^[A-Za-z0-9._-]+$/.test(parts[1]!) ||
    parts[1]!.endsWith(".git")
  ) {
    throw new Error(
      "Repository URL must be https://github.com/<owner>/<repository> without a ref or query",
    );
  }
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

export function templateDeployUrl(
  repositoryUrl: string,
  appUrl = "https://app.opencomputer.dev",
): string {
  const target = new URL("/new", appUrl);
  target.searchParams.set(
    "repository-url",
    normalizeTemplateRepositoryUrl(repositoryUrl),
  );
  return target.toString();
}
