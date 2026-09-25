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

/** Base64 to text, decoding the bytes as UTF-8 rather than one code unit per byte. */
function decodeBase64Utf8(text: string): string {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
        reactive = record(JSON.parse(decodeBase64Utf8(file.content)));
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

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort(byString)
      .map((key) => [key, sortKeys(object[key])]),
  );
}

/**
 * The canonical form a manifest digest is computed over: object keys sorted
 * at every level, array order preserved, no whitespace.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export async function manifestDigestOf(manifest: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Whether the digest the service reports is the digest of the manifest
 * customers receive. It is not when the projection above had to drop a
 * field, in which case the digest must not be served as verifiable.
 */
export async function publicManifestDigestVerifies(
  projected: Record<string, unknown>,
): Promise<boolean> {
  return (
    typeof projected.manifestDigest === "string" &&
    (await manifestDigestOf(projected.manifest)) === projected.manifestDigest
  );
}

const MAX_DETAIL_DEPTH = 4;
const MAX_DETAIL_ENTRIES = 200;

/**
 * A readiness check's detail is check-specific structured data (declared
 * versus packaged tool IDs, per-connection configured state, regions). Only
 * JSON scalars, arrays and plain objects pass, to a bounded depth and size.
 */
function publicDetail(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= MAX_DETAIL_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DETAIL_ENTRIES)
      .map((entry) => publicDetail(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  const object = record(value);
  if (!object) return undefined;
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(object).slice(0, MAX_DETAIL_ENTRIES)) {
    const entry = publicDetail(object[key], depth + 1);
    if (entry !== undefined) entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

const CHECK_STATUSES = new Set(["pass", "fail", "skip"]);

export function publicReadinessReceipt(value: unknown): Record<string, unknown> {
  const receipt = record(value) ?? {};
  const probe = record(receipt.probe) ?? {};
  return {
    schema: receipt.schema,
    projectId: typeof receipt.projectId === "string" ? receipt.projectId : null,
    agentId: receipt.agentId,
    deploymentId: receipt.deploymentId,
    sessionId: typeof receipt.sessionId === "string" ? receipt.sessionId : null,
    environment: receipt.environment,
    checkedAt: receipt.checkedAt,
    manifestDigest: receipt.manifestDigest,
    probe: {
      mode: probe.mode,
      executesAgentCode: probe.executesAgentCode === true,
      contactsCustomerTargets: probe.contactsCustomerTargets === true,
    },
    checks: Array.isArray(receipt.checks)
      ? receipt.checks.flatMap((value) => {
          const check = record(value);
          if (
            !check ||
            typeof check.id !== "string" ||
            typeof check.status !== "string" ||
            !CHECK_STATUSES.has(check.status)
          ) {
            return [];
          }
          return [
            {
              id: check.id,
              status: check.status,
              required: check.required === true,
              summary: typeof check.summary === "string" ? check.summary : "",
              detail: publicDetail(record(check.detail) ?? {}) ?? {},
              checkedAt: check.checkedAt,
              durationMs:
                typeof check.durationMs === "number" ? check.durationMs : 0,
            },
          ];
        })
      : [],
    ready: receipt.ready === true,
  };
}
