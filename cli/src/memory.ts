/**
 * The memory declaration contract: what `defineMemory()`, `documentMemory()`
 * and `httpMemory()` accept and the normalized descriptor they produce.
 *
 * This module is shared verbatim by `@opencomputer/agent`
 * (`agent/src/memory.ts`) and the CLI (`cli/src/memory.ts`), where the
 * compiler runs it on the literal declarations it extracts from agent source
 * and inlines its compiled form into the artifact's runtime. The two copies
 * must stay byte-identical; a CLI test enforces it. Keep the module free of
 * imports so it can be inlined.
 */

export const MEMORY_DEFAULT_MAX_BYTES = 8_192;
export const MEMORY_MAX_BYTES_CEILING = 16_384;
export const MEMORY_ID_MAX_LENGTH = 128;
export const HTTP_MEMORY_DEFAULT_PATH = "/memory";
export const HTTP_MEMORY_MAX_TOOLS = 8;
/** Injected into every memory tool's model-facing schema to select a resource. */
export const MEMORY_RESERVED_ARGUMENT = "memory";
/** The built-in document provider's fixed tools, exposed as `memory_<name>`. */
export const DOCUMENT_MEMORY_TOOLS: readonly string[] = Object.freeze([
  "save",
  "read",
  "list",
]);

const MEMORY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HTTP_MEMORY_PATH_PATTERN = /^\/(?!\/)[^?#\s]*$/;
const HTTP_MEMORY_TOOL_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;

export interface MemoryReference {
  readonly kind: "memory";
  readonly id: string;
}

/** Bounded text documents stored by OpenComputer. */
export interface DocumentMemoryProvider {
  readonly kind: "document";
  /** Maximum UTF-8 size of each document's text, for every writer. */
  readonly maxBytes: number;
}

export type MemoryToolAccess = "read" | "write";

export type MemoryToolInputSchema = Readonly<Record<string, unknown>>;

/**
 * A tool an HTTP memory endpoint executes. The model sees it as
 * `memory_<name>` with the reserved `memory` argument naming the resource, so
 * `input` may not declare a `memory` property of its own.
 */
export interface HttpMemoryToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly access: MemoryToolAccess;
  /**
   * Only an idempotent write is retried after a transport failure or timeout.
   * Declare it only when the endpoint deduplicates `(partition, operationId)`.
   */
  readonly idempotent: boolean;
  readonly input: MemoryToolInputSchema;
}

/** Recall and tools served by another service through a declared connection. */
export interface HttpMemoryProvider {
  readonly kind: "http";
  readonly connection: string;
  readonly path: string;
  /** Maximum UTF-8 size of recalled text. */
  readonly maxBytes: number;
  readonly tools: readonly HttpMemoryToolDefinition[];
}

export type MemoryProvider = DocumentMemoryProvider | HttpMemoryProvider;

/**
 * A memory resource, registered by the compiler and admitted per session.
 * The same id in every agent of a project names the same resource.
 */
export interface MemoryDefinition extends MemoryReference {
  readonly version: 1;
  /** Model-facing guidance, shown in the resource's tool descriptions. */
  readonly description: string;
  readonly provider: MemoryProvider;
}

export interface MemorySource {
  readonly id: string;
  readonly title?: string;
  readonly revision?: string;
  readonly updatedAt?: string;
}

/**
 * What this model request knows from one bound memory resource. The host
 * resolves it before the render; the shape is the same for every provider.
 * Provider read state stays with the host; it is not part of the projection.
 */
export interface MemoryProjection {
  readonly text: string;
  readonly sources: readonly MemorySource[];
  /** Whether this binding's save tool can commit right now. */
  readonly writable: boolean;
}

export interface DocumentMemoryInput {
  maxBytes?: number;
}

export interface HttpMemoryToolInput {
  name: string;
  description: string;
  access: MemoryToolAccess;
  idempotent?: boolean;
  input: MemoryToolInputSchema;
}

/** A `defineConnection()` result, or the policy the compiler resolved for it. */
export interface HttpMemoryConnection {
  readonly kind: "connection";
  readonly id: string;
  readonly methods?: readonly string[];
  readonly pathPrefix?: string;
}

export interface HttpMemoryInput {
  connection: HttpMemoryConnection;
  path?: string;
  maxBytes?: number;
  tools?: readonly HttpMemoryToolInput[];
}

export interface MemoryDefinitionInput {
  id: string;
  description: string;
  provider?: MemoryProvider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export function memoryId(value: unknown, kind: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new Error(`${kind} requires a non-empty id`);
  if (!MEMORY_ID_PATTERN.test(id)) {
    throw new Error(
      `${kind} IDs must use lowercase letters, numbers, and single hyphens`,
    );
  }
  if (id.length > MEMORY_ID_MAX_LENGTH) {
    throw new Error(
      `${kind} IDs must contain at most ${MEMORY_ID_MAX_LENGTH} characters`,
    );
  }
  return id;
}

function memoryMaxBytes(value: unknown, label: string): number {
  if (value === undefined) return MEMORY_DEFAULT_MAX_BYTES;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MEMORY_MAX_BYTES_CEILING
  ) {
    throw new Error(
      `${label} maxBytes must be a whole number between 1 and ${MEMORY_MAX_BYTES_CEILING}`,
    );
  }
  return value;
}

function httpMemoryPath(value: unknown, label: string): string {
  if (value === undefined) return HTTP_MEMORY_DEFAULT_PATH;
  if (typeof value !== "string" || !HTTP_MEMORY_PATH_PATTERN.test(value)) {
    throw new Error(
      `${label} path must begin with a single / and contain no query or fragment`,
    );
  }
  return value;
}

function containsSchemaReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSchemaReference);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) => key === "$ref" || containsSchemaReference(nested),
  );
}

function httpMemoryToolInput(
  value: unknown,
  label: string,
): MemoryToolInputSchema {
  if (!isRecord(value)) {
    throw new Error(`${label} input must be a JSON Schema object`);
  }
  if (value.type !== "object") {
    throw new Error(`${label} input must be a JSON Schema with type "object"`);
  }
  if (containsSchemaReference(value)) {
    throw new Error(`${label} input cannot use $ref`);
  }
  const properties = value.properties;
  if (properties !== undefined && !isRecord(properties)) {
    throw new Error(`${label} input properties must be an object`);
  }
  const required = value.required;
  if (
    required !== undefined &&
    (!Array.isArray(required) ||
      required.some((name) => typeof name !== "string"))
  ) {
    throw new Error(`${label} input required must be an array of strings`);
  }
  if (
    (properties &&
      Object.prototype.hasOwnProperty.call(
        properties,
        MEMORY_RESERVED_ARGUMENT,
      )) ||
    (Array.isArray(required) && required.includes(MEMORY_RESERVED_ARGUMENT))
  ) {
    throw new Error(
      `${label} input cannot declare the reserved ${MEMORY_RESERVED_ARGUMENT} argument; OpenComputer adds it to select the resource`,
    );
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    throw new Error(`${label} input must be JSON-compatible`);
  }
  return deepFreeze(JSON.parse(serialized) as Record<string, unknown>);
}

function httpMemoryTools(
  value: unknown,
  label: string,
): readonly HttpMemoryToolDefinition[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new Error(`${label} tools must be an array`);
  }
  if (value.length > HTTP_MEMORY_MAX_TOOLS) {
    throw new Error(
      `${label} may declare at most ${HTTP_MEMORY_MAX_TOOLS} tools`,
    );
  }
  const names = new Set<string>();
  const tools = value.map((tool: unknown): HttpMemoryToolDefinition => {
    if (!isRecord(tool)) {
      throw new Error(`${label} tools must contain tool objects`);
    }
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!HTTP_MEMORY_TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
        `${label} tool names must use 1 to 32 lowercase letters, numbers, and underscores`,
      );
    }
    const toolLabel = `${label} tool ${name}`;
    if (names.has(name)) {
      throw new Error(`${toolLabel} is declared more than once`);
    }
    names.add(name);
    const description =
      typeof tool.description === "string" ? tool.description.trim() : "";
    if (!description) throw new Error(`${toolLabel} requires a description`);
    if (tool.access !== "read" && tool.access !== "write") {
      throw new Error(`${toolLabel} access must be "read" or "write"`);
    }
    if (tool.idempotent !== undefined && typeof tool.idempotent !== "boolean") {
      throw new Error(`${toolLabel} idempotent must be true or false`);
    }
    return Object.freeze({
      name,
      description,
      access: tool.access,
      idempotent: tool.idempotent === true,
      input: httpMemoryToolInput(tool.input, toolLabel),
    });
  });
  return Object.freeze(tools);
}

/**
 * Normalizes a provider descriptor. Every descriptor a definition carries
 * passes through here, whether it came from `documentMemory()`,
 * `httpMemory()` or was written by hand.
 */
function memoryProvider(value: unknown, label: string): MemoryProvider {
  if (!isRecord(value)) {
    throw new Error(`${label} provider must be documentMemory() or httpMemory()`);
  }
  if (value.kind === "document") {
    return Object.freeze({
      kind: "document" as const,
      maxBytes: memoryMaxBytes(value.maxBytes, label),
    });
  }
  if (value.kind === "http") {
    const connection =
      typeof value.connection === "string" ? value.connection.trim() : "";
    if (!connection) {
      throw new Error(`${label} requires a defineConnection() connection`);
    }
    return Object.freeze({
      kind: "http" as const,
      connection,
      path: httpMemoryPath(value.path, label),
      maxBytes: memoryMaxBytes(value.maxBytes, label),
      tools: httpMemoryTools(value.tools, label),
    });
  }
  throw new Error(`${label} provider must be documentMemory() or httpMemory()`);
}

export function documentMemory(
  input: DocumentMemoryInput = {},
): DocumentMemoryProvider {
  const provider = memoryProvider(
    { kind: "document", maxBytes: input.maxBytes },
    "documentMemory",
  );
  return provider as DocumentMemoryProvider;
}

export function httpMemory(input: HttpMemoryInput): HttpMemoryProvider {
  const connection = input.connection;
  if (
    !isRecord(connection) ||
    typeof connection.id !== "string" ||
    !connection.id
  ) {
    throw new Error("httpMemory requires a defineConnection() connection");
  }
  const provider = memoryProvider(
    {
      kind: "http",
      connection: connection.id,
      path: input.path,
      maxBytes: input.maxBytes,
      tools: input.tools,
    },
    "httpMemory",
  ) as HttpMemoryProvider;
  const policy = connection as HttpMemoryConnection;
  if (policy.pathPrefix && !provider.path.startsWith(policy.pathPrefix)) {
    throw new Error(
      `httpMemory path ${provider.path} is outside connection ${provider.connection} pathPrefix ${policy.pathPrefix}`,
    );
  }
  if (policy.methods && !policy.methods.includes("POST")) {
    throw new Error(
      `httpMemory requires connection ${provider.connection} to allow POST`,
    );
  }
  return provider;
}

export function defineMemory(input: MemoryDefinitionInput): MemoryDefinition {
  const id = memoryId(input.id, "defineMemory");
  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  if (!description) {
    throw new Error(`Memory ${id} requires a non-empty description`);
  }
  const provider =
    input.provider === undefined
      ? documentMemory()
      : memoryProvider(input.provider, `Memory ${id}`);
  return Object.freeze({
    kind: "memory" as const,
    version: 1 as const,
    id,
    description,
    provider,
  });
}

/** The model-facing tool names a provider reserves: `memory_<name>`. */
export function memoryToolNames(provider: MemoryProvider): string[] {
  const names =
    provider.kind === "document"
      ? DOCUMENT_MEMORY_TOOLS
      : provider.tools.map((tool) => tool.name);
  return names.map((name) => `${MEMORY_RESERVED_ARGUMENT}_${name}`);
}

/**
 * The projection the host resolved for the session's binding of `id`, or a
 * render failure when the session has no such binding.
 */
export function memoryProjection(id: string, value: unknown): MemoryProjection {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.sources) ||
    typeof value.writable !== "boolean"
  ) {
    throw new Error(
      `Memory ${JSON.stringify(id)} is not bound to this session; create the session with a memory binding for it`,
    );
  }
  return value as unknown as MemoryProjection;
}
