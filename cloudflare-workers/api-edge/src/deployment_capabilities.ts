/**
 * Deployment capability manifests and readiness receipts at the API edge.
 *
 * Deploy time: the compiler metadata packaged in an agent artifact
 * (`.opencomputer/reactive.json`, `.opencode/skills/<name>/SKILL.md`) is read
 * into capability declarations that ride along with the deployment
 * registration. Only JSON and file paths are inspected; no agent code runs.
 *
 * Read time: the manifest and receipt the managed-agents service returns are
 * re-projected onto the public field set so nothing private can slip through.
 */

export interface CapabilityDeclarations {
  tools: Array<{ id: string; gated?: true }>;
  resultSchemas: Array<{ toolId: string; schema: Record<string, unknown> }>;
  skills: Array<{ name: string; path: string }>;
  mcpServers: Array<{ id: string; origin?: string; connection?: string }>;
  subagents: string[];
}

const SKILL_PATH = /^\.opencode\/skills\/([^/]+)\/SKILL\.md$/;
const MAX_DECLARATIONS = 500;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compiler-known declarations from an artifact bundle, or `null` when the
 * bundle is not a well-formed agent artifact. An artifact without compiler
 * metadata yields empty declarations rather than failing the deploy.
 */
export function capabilityDeclarationsFromArtifact(
  source: string,
): CapabilityDeclarations | null {
  let bundle: unknown;
  try {
    bundle = JSON.parse(source);
  } catch {
    return null;
  }
  const files = record(bundle)?.files;
  if (!Array.isArray(files)) return null;

  const skills = new Map<string, string>();
  let reactive: Record<string, unknown> | null = null;
  for (const value of files) {
    const file = record(value);
    if (!file || typeof file.path !== "string") continue;
    const skill = SKILL_PATH.exec(file.path);
    if (skill) {
      skills.set(skill[1], `.opencode/skills/${skill[1]}`);
      continue;
    }
    if (file.path === ".opencomputer/reactive.json") {
      if (typeof file.content !== "string") return null;
      try {
        reactive = record(JSON.parse(atob(file.content)));
      } catch {
        return null;
      }
      if (!reactive) return null;
    }
  }

  const gated = new Set(strings(reactive?.gatedTools));
  const tools = [...new Set(strings(reactive?.tools))]
    .sort(byString)
    .slice(0, MAX_DECLARATIONS)
    .map((id) => (gated.has(id) ? { id, gated: true as const } : { id }));

  const resultSchemas: CapabilityDeclarations["resultSchemas"] = [];
  const resultTool = record(reactive?.resultTool);
  const output = record(resultTool?.output);
  if (resultTool && typeof resultTool.id === "string" && output) {
    resultSchemas.push({ toolId: resultTool.id, schema: output });
  }

  const mcpServers: CapabilityDeclarations["mcpServers"] = [];
  const definitions = Array.isArray(reactive?.mcpServerDefinitions)
    ? reactive.mcpServerDefinitions
    : [];
  const seen = new Set<string>();
  for (const value of definitions) {
    const definition = record(value);
    if (!definition || typeof definition.id !== "string") continue;
    if (seen.has(definition.id)) continue;
    seen.add(definition.id);
    const url =
      typeof definition.url === "string"
        ? definition.url
        : typeof definition.origin === "string"
          ? definition.origin
          : undefined;
    const origin = url ? originOf(url) : undefined;
    mcpServers.push({
      id: definition.id,
      ...(origin ? { origin } : {}),
      ...(typeof definition.connection === "string"
        ? { connection: definition.connection }
        : {}),
    });
  }
  for (const id of strings(reactive?.mcpServers)) {
    if (!seen.has(id)) {
      seen.add(id);
      mcpServers.push({ id });
    }
  }
  mcpServers.sort((a, b) => byString(a.id, b.id));

  return {
    tools,
    resultSchemas,
    skills: [...skills.entries()]
      .sort(([a], [b]) => byString(a, b))
      .slice(0, MAX_DECLARATIONS)
      .map(([name, path]) => ({ name, path })),
    mcpServers: mcpServers.slice(0, MAX_DECLARATIONS),
    subagents: [...new Set(strings(reactive?.subagents))].sort(byString),
  };
}

export const CAPABILITIES_ROUTE = /^\/deployments\/[^/]+\/capabilities$/;
export const READINESS_ROUTE = /^\/deployments\/[^/]+\/readiness$/;

/** Manifest fields customers may see; anything else the service adds stays private. */
const PUBLIC_MANIFEST_KEYS = [
  "schema",
  "projectId",
  "agentId",
  "deploymentId",
  "alias",
  "sourceDigest",
  "runtimeImageDigest",
  "runtimeImageVersion",
  "runtimeMode",
  "models",
  "defaultModel",
  "tools",
  "resultSchemas",
  "skills",
  "mcpServers",
  "subagents",
  "connections",
  "memory",
  "regions",
  "lifecycleCapabilities",
  "egressCapabilities",
  "createdAt",
] as const;

export function publicCapabilityManifest(
  value: unknown,
): Record<string, unknown> {
  const body = record(value) ?? {};
  const manifest = record(body.manifest) ?? {};
  return {
    manifest: Object.fromEntries(
      PUBLIC_MANIFEST_KEYS.filter((key) => key in manifest).map((key) => [
        key,
        manifest[key],
      ]),
    ),
    manifestDigest: body.manifestDigest,
  };
}

export function publicReadinessReceipt(value: unknown): Record<string, unknown> {
  const receipt = record(value) ?? {};
  return {
    schema: receipt.schema,
    projectId: receipt.projectId ?? null,
    agentId: receipt.agentId,
    deploymentId: receipt.deploymentId,
    sessionId: receipt.sessionId ?? null,
    environment: receipt.environment,
    checkedAt: receipt.checkedAt,
    manifestDigest: receipt.manifestDigest,
    probe: receipt.probe,
    checks: Array.isArray(receipt.checks)
      ? receipt.checks.map((value) => {
          const check = record(value) ?? {};
          return {
            id: check.id,
            status: check.status,
            required: check.required === true,
            summary: check.summary,
            detail: record(check.detail) ?? {},
            checkedAt: check.checkedAt,
            durationMs: check.durationMs,
          };
        })
      : [],
    ready: receipt.ready === true,
  };
}
